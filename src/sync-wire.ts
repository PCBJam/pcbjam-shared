/**
 * Wire protocol for the generic R2⇄IndexedDB sync bridge
 * (docs/features/r2-idb-sync). Environment-agnostic types + pure codecs shared by
 * the browser client (`@pcbjam/sync-client`) and the Cloudflare server
 * (`@pcbjam/sync-server`).
 *
 * Deliberately generic — NO KiCad/lib/symbol vocabulary. A `namespace` is one
 * sync scope (an R2 key-prefix); a `path` is a file within it; a `body` is opaque
 * bytes. Lives in MIT `@pcbjam/shared` next to `collab-wire.ts` / `items-wire.ts`
 * (the established home for cross-boundary wire shapes), so the closed server can
 * import the types without pulling in any browser runtime.
 */

/**
 * One entry in a namespace manifest. `hash` is an opaque content fingerprint the
 * BACKEND computes from the body (R2 etag for static origins, the etag of the
 * DO's R2 write for live overlays) — the client never computes it, it only
 * compares it to its cached value and refetches the body when they differ. The
 * exact algorithm (md5/etag/…) is intentionally not part of the contract.
 */
export interface SyncEntry {
  hash: string;
  size: number;
  mtime: number;
}

/** The index of one namespace. `version` is monotonic, bumped on every put/del. */
export interface SyncManifest {
  version: number;
  entries: Record<string, SyncEntry>;
}

/** A change to one path — broadcast by the server, applied by the client. */
export interface SyncChange {
  op: "put" | "del";
  path: string;
  /** content fingerprint; present for `put` (see SyncEntry.hash) */
  hash?: string;
  /** present for `put` */
  size?: number;
  /** manifest version AFTER this change */
  version: number;
}

/**
 * One layer in a client-merged stack. The bridge opens an ordered list and merges
 * top-wins by path; writes target the top `writable` layer. `static` layers are
 * immutable read-only (cacheable HTTP, no socket); `live` layers are a DO room.
 * `sparse` layers are static layers whose bodies are fetched lazily per read
 * (only the manifest syncs eagerly; there is no bundle) — for namespaces too
 * large to mirror, where the client needs an unpredictable subset.
 */
export interface LayerDescriptor {
  namespace: string;
  kind: "static" | "live" | "sparse";
  /** static/sparse: CDN/R2 base; live: DO/party base */
  url: string;
  /** live: bearer carried on WS + HTTP */
  token?: string;
  writable?: boolean;
  /**
   * sparse: overrides where a single body is fetched from. `{hash}` and `{path}`
   * expand to the manifest entry's hash and the URL-encoded path — so bodies can
   * live at content-addressed keys shared across snapshots. Default (absent):
   * `<url>/body/<path>` like a static layer.
   */
  bodyUrlTemplate?: string;
}

/* ---------------------------------------------------------------- messages --
 * WebSocket frames, live layers only. JSON over the partysocket connection.
 */

/** Client→server on connect: "I'm at this version; tell me if I'm behind." */
export interface HelloMsg {
  t: "hello";
  sinceVersion?: number;
}
/** Server→client reply to `hello` / heartbeat: current authoritative version. */
export interface SyncedMsg {
  t: "synced";
  version: number;
}
/** Server→client broadcast after a put/del (to every client but the originator). */
export interface ChangeMsg extends SyncChange {
  t: "change";
}
/** Server→client hint: you may be behind, run `sync()`. */
export interface ManifestMsg {
  t: "manifest";
  version: number;
}

export type ClientMsg = HelloMsg;
export type ServerMsg = SyncedMsg | ChangeMsg | ManifestMsg;

/* ------------------------------------------------------------------- sha256 -- */

const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/**
 * Hex SHA-256 of body bytes. Uses WebCrypto (`crypto.subtle`), available in the
 * browser, Cloudflare Workers, and Node 20+ — so client and server compute the
 * same digest with no dependency.
 */
export async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) out += HEX[view[i]!];
  return out;
}

/* ------------------------------------------------------------ manifest diff -- */

export interface ManifestDiff {
  /** Paths to (re)fetch — new remotely, or a changed sha. */
  put: string[];
  /** Paths to drop locally — present locally, absent remotely. */
  del: string[];
}

/**
 * What a client must change to go from `local` (or empty/cold) to `remote`.
 * `init()` is this diff against a null local manifest (everything is a `put`).
 */
export function diffManifest(
  local: SyncManifest | null,
  remote: SyncManifest,
): ManifestDiff {
  const put: string[] = [];
  const del: string[] = [];
  const localEntries = local?.entries ?? {};
  for (const [path, e] of Object.entries(remote.entries)) {
    const cur = localEntries[path];
    if (!cur || cur.hash !== e.hash) put.push(path);
  }
  for (const path of Object.keys(localEntries)) {
    if (!(path in remote.entries)) del.push(path);
  }
  return { put, del };
}

/* --------------------------------------------------------- binary framing --
 * Length-prefixed binary (big-endian u32), chosen over NDJSON+base64 to avoid the
 * ~33% blow-up on body bytes. Frame layout, repeated:
 *   [u32 pathLen][path utf8][u32 bodyLen][body]
 * A "bundle" additionally prefixes a manifest frame ([u32 jsonLen][manifest json])
 * so a cold client gets the manifest + every body in one response (spec §2).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode `[path, body]` pairs into one length-prefixed buffer. */
export function encodeFrames(entries: Array<[string, Uint8Array]>): Uint8Array {
  const paths = entries.map(([p]) => enc.encode(p));
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    total += 4 + paths[i]!.length + 4 + entries[i]![1].length;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (let i = 0; i < entries.length; i++) {
    const pb = paths[i]!;
    const body = entries[i]![1];
    dv.setUint32(off, pb.length);
    off += 4;
    out.set(pb, off);
    off += pb.length;
    dv.setUint32(off, body.length);
    off += 4;
    out.set(body, off);
    off += body.length;
  }
  return out;
}

/** Decode a buffer produced by `encodeFrames` back into `[path, body]` pairs. */
export function decodeFrames(bytes: Uint8Array): Array<[string, Uint8Array]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<[string, Uint8Array]> = [];
  let off = 0;
  while (off < bytes.length) {
    const pl = dv.getUint32(off);
    off += 4;
    const path = dec.decode(bytes.subarray(off, off + pl));
    off += pl;
    const bl = dv.getUint32(off);
    off += 4;
    // Copy out so callers own a standalone buffer (subarray aliases input).
    const body = bytes.slice(off, off + bl);
    off += bl;
    out.push([path, body]);
  }
  return out;
}

/** Encode a full namespace snapshot (manifest + every body) for cold `init()`. */
export function encodeBundle(
  manifest: SyncManifest,
  bodies: Array<[string, Uint8Array]>,
): Uint8Array {
  const json = enc.encode(JSON.stringify(manifest));
  const frames = encodeFrames(bodies);
  const out = new Uint8Array(4 + json.length + frames.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(frames, 4 + json.length);
  return out;
}

/** Decode a buffer produced by `encodeBundle`. */
export function decodeBundle(bytes: Uint8Array): {
  manifest: SyncManifest;
  bodies: Array<[string, Uint8Array]>;
} {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jl = dv.getUint32(0);
  const manifest = JSON.parse(
    dec.decode(bytes.subarray(4, 4 + jl)),
  ) as SyncManifest;
  const bodies = decodeFrames(bytes.subarray(4 + jl));
  return { manifest, bodies };
}
