// The client of the simulation library: the only way the app reads it (simulation 0004).
//
// The library is a snapshot of static files. Three kinds of request, nothing else:
//   1. current.json                         which snapshot is the current one
//   2. <snapshot>/index.json                every part: what it fits, its pins, its files
//   3. <snapshot>/parts/<id>/<file>         one file of one part, checked against the index
//      emulators/<id>/<version>/<file>      one file of a chip emulator, checked the same way.
//                                           Beside the snapshots: an emulator is megabytes and
//                                           changes with its own releases, not with the parts
//
// A snapshot never changes once it is published, so 2 and 3 can be cached forever; only 1 is
// asked again. Works the same in a page and under Node: pass the base URL and, if needed, a
// fetch function.
import {
  INDEX_SCHEMA, POINTER_SCHEMA, SNAPSHOT_NAME, type IndexEmulator, type IndexFile, type IndexPart, type LibraryIndex, type LibraryPointer,
  type PartManifest,
} from "./format.js";

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Everything a run needs of one part: its description, its analog half, its digital half. */
export interface LoadedPart {
  id: string;
  manifest: PartManifest;
  /** The text of the model file. */
  analog: string;
  /** The compiled digital half, or null for a part without one. */
  logic: Uint8Array | null;
}

export interface OpenOptions {
  fetch?: typeof fetch;
  /** Open this snapshot instead of asking which one is current. */
  version?: string;
}

export interface SimLibrary {
  base: string;
  version: string;
  index: LibraryIndex;
  parts: IndexPart[];
  part(id: string): IndexPart | undefined;
  /** One file of one part, as bytes. Refused when it is not the file the index describes. */
  file(id: string, name: string): Promise<Uint8Array>;
  text(id: string, name: string): Promise<string>;
  loadPart(id: string): Promise<LoadedPart>;
  /** A chip emulator the library carries, as the index describes it. */
  emulator(id: string): IndexEmulator | undefined;
  /** One file of an emulator, as bytes. Refused when it is not the file the index describes. */
  emulatorFile(id: string, name: string): Promise<Uint8Array>;
  /** How much was asked for so far. */
  requests: { pointer: number; index: number; files: number; bytes: number };
}

export async function openLibrary(base: string, { fetch: f, version }: OpenOptions = {}): Promise<SimLibrary> {
  const doFetch = f ?? globalThis.fetch.bind(globalThis);
  const root = base.endsWith("/") ? base : base + "/";
  const requests = { pointer: 0, index: 0, files: 0, bytes: 0 };
  const get = async (path: string): Promise<Response> => {
    const r = await doFetch(root + path);
    if (!r.ok) throw new Error(`simulation library: ${path}: HTTP ${r.status}`);
    return r;
  };

  let v = version;
  if (!v) {
    requests.pointer++;
    const cur = (await (await get("current.json")).json()) as LibraryPointer;
    if (cur.schema !== POINTER_SCHEMA) throw new Error(`simulation library: pointer of an unknown format (${String(cur.schema)})`);
    v = cur.version;
  }
  if (typeof v !== "string" || !SNAPSHOT_NAME.test(v)) throw new Error(`simulation library: bad snapshot name "${String(v)}"`);
  const snapshot = v;
  requests.index++;
  const index = (await (await get(`${snapshot}/index.json`)).json()) as LibraryIndex;
  if (index.schema !== INDEX_SCHEMA) throw new Error(`simulation library: index of an unknown format (${String(index.schema)})`);
  if (index.version !== snapshot) throw new Error(`simulation library: asked for snapshot ${snapshot}, got ${index.version}`);

  const byId = new Map(index.parts.map((p) => [p.id, p]));
  const emulators = new Map((index.emulators ?? []).map((e) => [e.id, e]));
  const files = new Map<string, Promise<Uint8Array>>();

  /** One file of the library, once, checked against what the index says about it. */
  const checked = (path: string, label: string, missing: string, meta: IndexFile | undefined): Promise<Uint8Array> => {
    let got = files.get(path);
    if (!got) {
      got = (async () => {
        if (!meta) throw new Error(`simulation library: ${missing}`);
        requests.files++;
        const bytes = new Uint8Array(await (await get(path)).arrayBuffer());
        requests.bytes += bytes.length;
        if (bytes.length !== meta.bytes || (await sha256(bytes)) !== meta.sha256)
          throw new Error(`simulation library: ${label} does not match its checksum`);
        return bytes;
      })();
      files.set(path, got);
      // a failed download is not kept: the next ask tries again
      got.catch(() => files.delete(path));
    }
    return got;
  };

  const file = (id: string, name: string): Promise<Uint8Array> =>
    checked(`${snapshot}/parts/${id}/${name}`, `${id}/${name}`, `part "${id}" has no file "${name}"`, byId.get(id)?.files.find((x) => x.name === name));

  const emulatorFile = (id: string, name: string): Promise<Uint8Array> => {
    const e = emulators.get(id);
    return checked(
      `emulators/${id}/${e?.version ?? "-"}/${name}`, `emulator ${id}/${name}`, `emulator "${id}" has no file "${name}"`,
      e?.files.find((x) => x.name === name),
    );
  };

  const text = async (id: string, name: string): Promise<string> => new TextDecoder().decode(await file(id, name));

  const loadPart = async (id: string): Promise<LoadedPart> => {
    const manifest = JSON.parse(await text(id, "part.json")) as PartManifest;
    const d = manifest.digital;
    const [analog, logic] = await Promise.all([
      text(id, manifest.analog.file),
      d && d.kind === "part-wasm" ? file(id, d.file) : null,
    ]);
    return { id, manifest, analog, logic };
  };

  return {
    base: root, version: snapshot, index, parts: index.parts, part: (id) => byId.get(id), file, text, loadPart,
    emulator: (id) => emulators.get(id), emulatorFile, requests,
  };
}
