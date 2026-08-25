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

/** Subscription mode (0003 §2): passive registers interest only — it receives
 *  awareness and `touched` hints but never doc frames, and can never cause a
 *  BoardRoom relay dial. Active is a real y-protocol participant. */
export type GatewaySubMode = "active" | "passive";

export type GatewayClientMsg =
  | { t: "sub"; ch: number; doc: string; mode: GatewaySubMode }
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
  /** Coarse writer class, for UX copy only. */
  origin: "editor" | "upload" | "job";
  /** Writer's user slug when a session wrote it; absent for machine writers. */
  by?: string;
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
   *  catch up on the next activate(). */
  | { t: "touched"; ch: number }
  /** Project files changed on the files route (project-sync 0002). `seq` is
   *  per-ProjectRoom monotonic: a gap means frames were missed (reconnect,
   *  or an oversized batch) and the listing must be refetched. Hints are a
   *  trigger only — never a CAS precondition. */
  | { t: "files"; ch: number; seq: number; changes: GatewayFileChange[] };

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
  const m = raw as { t?: unknown; ch?: unknown; doc?: unknown; mode?: unknown };
  if (!isChannelId(m.ch)) return null;
  if (m.t === "sub") {
    if (typeof m.doc !== "string" || !m.doc) return null;
    if (m.mode !== "active" && m.mode !== "passive") return null;
    return { t: "sub", ch: m.ch, doc: m.doc, mode: m.mode };
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

/** The gateway Durable Object name for a project (0001 §5). */
export function projectRoomName(scopeId: string, projectId: string): string {
  return `project:${scopeId}:${projectId}`;
}

/**
 * Inverse of {@link projectRoomName}. Ids are uuids (no colons), so a valid
 * name has exactly three non-empty segments and starts with `project:`.
 */
export function parseProjectRoomName(
  room: string,
): { scopeId: string; projectId: string } | null {
  if (!room.startsWith("project:")) return null;
  const rest = room.slice("project:".length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const scopeId = rest.slice(0, i);
  const projectId = rest.slice(i + 1);
  if (!projectId || projectId.includes(":")) return null;
  return { scopeId, projectId };
}
