/**
 * Wire protocol of the ProjectRoom gateway (load-path-rework 0003): ONE
 * websocket per (project, session) carrying every per-doc collab room plus the
 * `~presence` channel, multiplexed by small client-assigned channel ids.
 *
 * Two frame families share the socket:
 *  - TEXT frames — JSON control messages ({@link GatewayClientMsg} /
 *    {@link GatewayServerMsg}): subscribe/unsubscribe/activate upstream,
 *    subscription errors and resync/touched prompts downstream.
 *  - BINARY frames — `varint channelId` + an UNCHANGED y-websocket frame
 *    (sync/awareness/queryAwareness). The gateway relays the inner frame
 *    verbatim, so every existing y-protocol consumer keeps working.
 *
 * The varint codec is lib0's (LSB-first, continuation bit) — deliberately
 * identical to what y-protocols uses inside the inner frames, and decoded with
 * the same permissive semantics as the sync worker's guards so a non-minimal
 * encoding can't make the two disagree about where the inner frame starts.
 */

import { isWorkingCopyId } from "./schemas.js";

/** Subscription mode (0003 §2, amended by 0004 §2.1): passive registers
 *  interest — it receives awareness and `touched` hints and may PULL the doc's
 *  at-rest state with SyncStep1 (answered by the gateway from R2 / a live
 *  room's RPC), but can never cause a BoardRoom relay dial. Active is a real
 *  y-protocol participant. */
export type GatewaySubMode = "active" | "passive";

export type GatewayClientMsg =
  | {
      t: "sub";
      ch: number;
      doc: string;
      mode: GatewaySubMode;
      /** The working-copy generation this session was booted with
       *  (git-integration 0004 §E). A gateway that knows a newer generation
       *  answers `suberr` 409 {@link GENERATION_REFUSED}; absent ⇒ the
       *  session predates generations and is accepted as-is. */
      gen?: number;
    }
  | { t: "act"; ch: number }
  | { t: "unsub"; ch: number };

/**
 * Reserved doc name of the project's FILE-CHANGE channel (project-sync 0002):
 * a passive-only subscription that carries {@link GatewayFileChange} hints for
 * writes landing on the files route (CAS PUT, upload, job resave) — the
 * channel a room-less file like `.kicad_pro` never had. Never dials a relay.
 */
export const FILES_DOC_PATH = "~files";

/** One changed project-file row, as carried by a `files` hint. */
export interface GatewayFileChange {
  path: string;
  /** Row revision after the write; 0 with `deleted` for a removed row. */
  revision: number;
  deleted?: true;
  /** With `deleted`: the row was renamed/moved, not trashed (project-page
   *  0003) — the same batch carries the new path's own entry. */
  movedTo?: string;
  /** Coarse writer class, for UX copy only. */
  origin: "editor" | "upload" | "job";
  /** Writer's user slug when a session wrote it; absent for machine writers. */
  by?: string;
}

/**
 * Generation fencing (git-integration 0004 §E, R-§10): when a working copy's
 * base changes, its generation is bumped and every session of the old
 * generation is fenced. The gateway closes their sockets with
 * {@link GENERATION_CLOSE_CODE} and answers any later `sub` carrying an older
 * `gen` with `suberr` status 409 and this message. A fenced client must stop
 * reconnecting and never replay its queues into the new generation; its local
 * edits stay in the tab for an explicit recovery path.
 */
export const GENERATION_REFUSED = "generation";
export const GENERATION_CLOSE_CODE = 4409;
export function isGenerationRefusal(status: number, message: string): boolean {
  return status === 409 && message === GENERATION_REFUSED;
}

/**
 * Websocket close reasons of a file-op kick (project-page 0003 D7), sent with
 * code 4403 like the project-delete kick. `file-moved` carries the new path
 * after a `:` (`file-moved:dir/new.kicad_sch`) so the editor can link to it.
 */
export const FILE_OP_CLOSE_REMOVED = "file-removed";
export const FILE_OP_CLOSE_MOVED = "file-moved";

/** Path-gate reason while a file op is still working on the path. */
export const FILE_OP_BUSY = "file-op-active";

/** True for the reasons the per-doc gate reports for a removed / moved /
 *  being-worked-on path — a 410 `suberr`, as opposed to an invalid file. */
export function isFileOpGateReason(reason: string): boolean {
  return reason === FILE_OP_BUSY || parseFileOpCloseReason(reason) !== null;
}

/** Parse a close / suberr reason; null when it is not a file-op one. */
export function parseFileOpCloseReason(
  reason: string,
): { kind: "removed" } | { kind: "moved"; to: string | null } | null {
  if (reason === FILE_OP_CLOSE_REMOVED) return { kind: "removed" };
  if (reason === FILE_OP_CLOSE_MOVED) return { kind: "moved", to: null };
  if (reason.startsWith(`${FILE_OP_CLOSE_MOVED}:`)) {
    return { kind: "moved", to: reason.slice(FILE_OP_CLOSE_MOVED.length + 1) || null };
  }
  return null;
}

/** Cap on `changes` per `files` frame (project-sync 0002 §1): above it the
 *  frame carries an empty list and the `seq` gap rule makes the client refetch
 *  the listing — a mass import is one listing GET, not a giant frame. */
export const FILES_HINT_MAX_CHANGES = 256;

export type GatewayServerMsg =
  /** The subscription is dead (invalid-file 409, presence-as-readonly 403…).
   *  A 4xx status is terminal for the channel — re-subscribing is the only
   *  retry, and only after the underlying condition changed. */
  | { t: "suberr"; ch: number; status: number; message: string }
  /** The doc's BoardRoom relay (re)connected — an active subscriber should
   *  send SyncStep1 so server-side news flows down. */
  | { t: "resync"; ch: number }
  /** The doc changed while this subscriber is passive — mark it dirty and
   *  catch up on the next activate() (or pull now with SyncStep1, 0004 §2.2). */
  | { t: "touched"; ch: number }
  /** The doc's CRDT history was replaced server-side (a runner re-seed after a
   *  re-upload, an onLoad epoch conversion) and this passive subscriber holds
   *  clocks the new epoch does not know (0004 §2.3). Merging would duplicate
   *  the layout: the client must drop its doc and subscribe afresh. */
  | { t: "reset"; ch: number }
  /** Project files changed on the files route (project-sync 0002). `seq` is
   *  per-ProjectRoom monotonic: a gap means frames were missed (reconnect,
   *  or an oversized batch) and the listing must be refetched. Hints are a
   *  trigger only — never a CAS precondition. */
  | { t: "files"; ch: number; seq: number; changes: GatewayFileChange[] }
  /** Awareness clients that spoke on this channel through a connection that
   *  has gone away (collab-presence: ghost peers). Clock-independent
   *  companion of the synthesized awareness removal frame: the gateway may
   *  only know a STALE clock for them after a hibernation wake, in which
   *  case the binary tombstone is rejected by y-protocols — this control
   *  tells the client to drop the states regardless. */
  | { t: "gone"; ch: number; clients: number[] };

function isChannelId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Parse + validate a client control frame; null for anything malformed. */
export function parseGatewayClientMsg(text: string): GatewayClientMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as { t?: unknown; ch?: unknown; doc?: unknown; mode?: unknown; gen?: unknown };
  if (!isChannelId(m.ch)) return null;
  if (m.t === "sub") {
    if (typeof m.doc !== "string" || !m.doc) return null;
    if (m.mode !== "active" && m.mode !== "passive") return null;
    const sub: GatewayClientMsg = { t: "sub", ch: m.ch, doc: m.doc, mode: m.mode };
    if (m.gen !== undefined) {
      if (typeof m.gen !== "number" || !Number.isInteger(m.gen) || m.gen < 0) return null;
      sub.gen = m.gen;
    }
    return sub;
  }
  if (m.t === "act") return { t: "act", ch: m.ch };
  if (m.t === "unsub") return { t: "unsub", ch: m.ch };
  return null;
}

/** Parse + validate a server control frame; null for anything malformed. */
export function parseGatewayServerMsg(text: string): GatewayServerMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as {
    t?: unknown;
    ch?: unknown;
    status?: unknown;
    message?: unknown;
  };
  if (!isChannelId(m.ch)) return null;
  if (m.t === "suberr") {
    if (typeof m.status !== "number") return null;
    return {
      t: "suberr",
      ch: m.ch,
      status: m.status,
      message: typeof m.message === "string" ? m.message : "",
    };
  }
  if (m.t === "resync") return { t: "resync", ch: m.ch };
  if (m.t === "touched") return { t: "touched", ch: m.ch };
  if (m.t === "reset") return { t: "reset", ch: m.ch };
  if (m.t === "gone") {
    const g = m as { clients?: unknown };
    if (!Array.isArray(g.clients)) return null;
    const clients: number[] = [];
    for (const c of g.clients) {
      if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) return null;
      clients.push(c);
    }
    return { t: "gone", ch: m.ch, clients };
  }
  if (m.t === "files") {
    const f = m as { seq?: unknown; changes?: unknown };
    if (typeof f.seq !== "number" || !Number.isSafeInteger(f.seq) || f.seq < 0) return null;
    if (!Array.isArray(f.changes)) return null;
    const changes: GatewayFileChange[] = [];
    for (const raw of f.changes) {
      const c = parseGatewayFileChange(raw);
      if (!c) return null;
      changes.push(c);
    }
    return { t: "files", ch: m.ch, seq: f.seq, changes };
  }
  return null;
}

/** Validate one file-change entry; null for anything malformed. */
export function parseGatewayFileChange(raw: unknown): GatewayFileChange | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as {
    path?: unknown;
    revision?: unknown;
    deleted?: unknown;
    movedTo?: unknown;
    origin?: unknown;
    by?: unknown;
  };
  if (typeof c.path !== "string" || !c.path) return null;
  if (typeof c.revision !== "number" || !Number.isSafeInteger(c.revision) || c.revision < 0) {
    return null;
  }
  if (c.origin !== "editor" && c.origin !== "upload" && c.origin !== "job") return null;
  const out: GatewayFileChange = { path: c.path, revision: c.revision, origin: c.origin };
  if (c.deleted === true) out.deleted = true;
  if (out.deleted && typeof c.movedTo === "string" && c.movedTo) out.movedTo = c.movedTo;
  if (typeof c.by === "string" && c.by) out.by = c.by;
  return out;
}

/** lib0-compatible unsigned varint decode (permissive about non-minimal
 *  encodings, like the sync worker's guards). Null = truncated/empty. */
export function readGatewayVarint(
  bytes: Uint8Array,
  start: number,
): { value: number; next: number } | null {
  let num = 0;
  let mult = 1;
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i]!;
    num += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) return { value: num, next: i + 1 };
    mult *= 128;
  }
  return null;
}

function writeVarint(out: number[], value: number): void {
  let n = value;
  while (n > 127) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n);
}

/** Prefix a y-protocol frame with its channel id. */
export function tagGatewayFrame(ch: number, frame: Uint8Array): Uint8Array {
  const prefix: number[] = [];
  writeVarint(prefix, ch);
  const out = new Uint8Array(prefix.length + frame.length);
  out.set(prefix, 0);
  out.set(frame, prefix.length);
  return out;
}

/** Split a tagged binary frame back into (channel, inner frame). The inner
 *  frame is a subarray view — copy before holding past the message handler. */
export function untagGatewayFrame(
  data: Uint8Array,
): { ch: number; frame: Uint8Array } | null {
  const head = readGatewayVarint(data, 0);
  if (!head) return null;
  return { ch: head.value, frame: data.subarray(head.next) };
}

// --- gateway room naming ----------------------------------------------------

/**
 * The gateway Durable Object name for a project (0001 §5) — per working copy
 * since git-integration 0004: the default copy keeps the legacy
 * `project:<scopeId>:<projectId>` name, a non-default copy appends its id.
 */
export function projectRoomName(scopeId: string, projectId: string, copyId?: string | null): string {
  return copyId
    ? `project:${scopeId}:${projectId}:${copyId}`
    : `project:${scopeId}:${projectId}`;
}

/**
 * Inverse of {@link projectRoomName}. Ids are uuids (no colons), so a valid
 * name has three or four non-empty segments and starts with `project:`;
 * `copyId` is null for the default copy.
 */
export function parseProjectRoomName(
  room: string,
): { scopeId: string; projectId: string; copyId: string | null } | null {
  if (!room.startsWith("project:")) return null;
  const rest = room.slice("project:".length);
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !p)) return null;
  const scopeId = parts[0] as string;
  const projectId = parts[1] as string;
  const copyId = parts[2] ?? null;
  if (copyId !== null && !isWorkingCopyId(copyId)) return null;
  return { scopeId, projectId, copyId };
}
