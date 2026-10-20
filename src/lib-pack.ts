/**
 * The official-library pack: every official KiCad symbol and footprint library
 * in one file, so a first run downloads one object instead of ~380 per-library
 * bundles (libs 0026).
 *
 * A pack is the per-library sync bundles, byte for byte what each origin's
 * `/bundle` route serves, behind a small index:
 *
 *   "PJLP" | u32 LE index length | index JSON | bundle bytes, in index order
 *
 * The index names each bundle by `(libId, versionId)`; a client answers a
 * bundle request from the pack only when both match, and fetches anything else
 * as before. The file travels brotli-compressed with `Content-Encoding: br`, so
 * the browser decompresses it and this format is never compressed itself.
 */

export const LIB_PACK_MAGIC = "PJLP";
export const LIB_PACK_SCHEMA = 1;

export interface LibPackEntry {
  libId: string;
  versionId: string;
  /** Library nickname, for logs and the admin report. */
  name: string;
  bundle: Uint8Array;
}

interface LibPackIndex {
  schema: number;
  libs: Array<{ libId: string; versionId: string; name: string; length: number }>;
}

/** The pointer the API serves for the current pack. */
export interface LibPackPointer {
  /** sha256 hex of the pack's (libId@versionId) set: the pack's id. */
  id: string;
  /** Brotli-compressed size, what the client downloads. */
  bytes: number;
  libs: number;
  builtAt: string;
}

export const libPackKey = (id: string, versionId: string) => `${id}@${versionId}`;

export function encodeLibPack(entries: readonly LibPackEntry[]): Uint8Array {
  const index: LibPackIndex = {
    schema: LIB_PACK_SCHEMA,
    libs: entries.map((e) => ({ libId: e.libId, versionId: e.versionId, name: e.name, length: e.bundle.byteLength })),
  };
  const head = new TextEncoder().encode(JSON.stringify(index));
  const total = 8 + head.byteLength + entries.reduce((n, e) => n + e.bundle.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode(LIB_PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, head.byteLength, true);
  out.set(head, 8);
  let at = 8 + head.byteLength;
  for (const e of entries) {
    out.set(e.bundle, at);
    at += e.bundle.byteLength;
  }
  return out;
}

/** Bundles by `libPackKey(libId, versionId)`; views into `bytes`, no copies. */
export function decodeLibPack(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== LIB_PACK_MAGIC) {
    throw new Error("not a library pack");
  }
  const headLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + headLen > bytes.byteLength) throw new Error("library pack index is truncated");
  const index = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen))) as LibPackIndex;
  if (index.schema !== LIB_PACK_SCHEMA) throw new Error(`library pack schema ${index.schema} is not supported`);
  const out = new Map<string, Uint8Array>();
  let at = 8 + headLen;
  for (const lib of index.libs) {
    if (at + lib.length > bytes.byteLength) throw new Error(`library pack is truncated at ${lib.name}`);
    out.set(libPackKey(lib.libId, lib.versionId), bytes.subarray(at, at + lib.length));
    at += lib.length;
  }
  return out;
}
