import type { SyncManifest } from "@pcbjam/shared";

export interface LayerStoreCommit {
  puts?: Array<[string, Uint8Array]>;
  deletes?: string[];
  manifest: SyncManifest;
  /**
   * Optional path-local compare-and-swap conditions. The store compares these
   * hashes with its persisted manifest before it writes any body or manifest
   * data. `null` means that the path must still be absent. A mismatch rejects
   * the whole commit by returning `undefined`.
   *
   * This is deliberately path-scoped: an unrelated path may advance while a
   * sparse body download is in flight without blocking that download. The
   * downloaded body may publish only while the manifest still names the hash
   * that the request fetched.
   */
  expectedManifestEntries?: Array<{ path: string; hash: string | null }>;
  /**
   * Manifest paths owned by this transition. When present, `apply()` merges only
   * these entries with the manifest already in the store. This keeps two layer
   * lifetimes (or browser tabs) from dropping unrelated entries merely because
   * one of them built its transition from an older in-memory snapshot.
   *
   * This merge is not a cross-tab same-path ordering protocol. Source ordering
   * belongs to one SyncLayer lifetime; independent browser realms can miss a
   * best-effort realtime frame and temporarily race on the same cache path.
   * Open/reconnect reconciliation restores the server-authoritative value. A
   * stronger contract would require a server epoch/revision in the wire format;
   * the resettable numeric manifest version is not a safe cross-epoch CAS token.
   *
   * Omit this field for the legacy whole-manifest replacement behaviour.
   */
  manifestPaths?: string[];
  /**
   * A complete full sync may accept a server version reset. It may replace the
   * stored numeric version only when the store still has the version from which
   * that sync started; otherwise a newer publisher already owns the version.
   */
  resetVersionFrom?: number;
}

export interface LayerStoreSnapshotResult {
  /** The manifest left in the store after the compare-and-swap. */
  manifest: SyncManifest | null;
  /** False means the expected manifest no longer matched and nothing was written. */
  applied: boolean;
}

/**
 * Local byte cache + cached manifest for ONE namespace. The stack keeps one store
 * per layer namespace, so a shared static origin namespace reuses the same store
 * across every stack that includes it (dedup).
 *
 * Production uses `idbStore()` (IndexedDB). Tests inject `memStore()`. The sync
 * logic depends only on this interface, never on IndexedDB directly.
 */
export interface LayerStore {
  /** Retain the shared store coordinator for one SyncLayer lifetime. */
  acquire?(): () => void;
  getManifest(): Promise<SyncManifest | null>;
  setManifest(m: SyncManifest): Promise<void>;
  getBody(path: string): Promise<Uint8Array | null>;
  /** Read every cached body in one transaction (bulk "fat list" load). */
  getAllBodies(): Promise<Map<string, Uint8Array>>;
  putBody(path: string, body: Uint8Array): Promise<void>;
  delBody(path: string): Promise<void>;
  /** Write many bodies in one transaction (cold `init` bulk hydrate). */
  bulkPut(entries: Array<[string, Uint8Array]>): Promise<void>;
  /**
   * Replace the complete cached snapshot only if the stored manifest still
   * exactly matches `expected`. A successful replacement clears all old bodies
   * and installs `bodies` plus `manifest` atomically. This is the cold-bundle
   * publication primitive: a bundle is authoritative as a whole, but a stale
   * bundle must not overwrite a publisher that changed the cache while the
   * network request was in flight.
   */
  replaceSnapshot(
    expected: SyncManifest | null,
    manifest: SyncManifest,
    bodies: Array<[string, Uint8Array]>,
  ): Promise<LayerStoreSnapshotResult>;
  /**
   * Atomically publish body changes and the manifest that describes them.
   * Implementations also serialize commits that target the same store. This is
   * the only write primitive used by SyncLayer state transitions.
   */
  apply(commit: LayerStoreCommit): Promise<SyncManifest | void>;
  clear(): Promise<void>;
}

interface WriteLane {
  tail: Promise<void>;
}

function enqueueWrite<T>(lane: WriteLane, write: () => Promise<T>): Promise<T> {
  const result = lane.tail.then(write, write);
  lane.tail = result.then(
    () => {},
    () => {},
  );
  return result;
}

const emptyManifest = (): SyncManifest => ({ version: 0, entries: {} });

function cloneManifest(manifest: SyncManifest): SyncManifest {
  return {
    version: manifest.version,
    entries: Object.fromEntries(
      Object.entries(manifest.entries).map(([path, entry]) => [path, { ...entry }]),
    ),
  };
}

function sameManifest(
  left: SyncManifest | null,
  right: SyncManifest | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.version !== right.version) return false;
  const leftPaths = Object.keys(left.entries);
  const rightPaths = Object.keys(right.entries);
  if (leftPaths.length !== rightPaths.length) return false;
  for (const path of leftPaths) {
    const a = left.entries[path];
    const b = right.entries[path];
    if (
      !a ||
      !b ||
      a.hash !== b.hash ||
      a.size !== b.size ||
      a.mtime !== b.mtime
    ) {
      return false;
    }
  }
  return true;
}

function mergeCommitManifest(
  current: SyncManifest | null,
  commit: LayerStoreCommit,
): SyncManifest {
  if (commit.manifestPaths === undefined) return cloneManifest(commit.manifest);

  const previous = current ?? emptyManifest();
  const next = cloneManifest(previous);
  for (const path of commit.manifestPaths) {
    const entry = commit.manifest.entries[path];
    if (entry) next.entries[path] = { ...entry };
    else delete next.entries[path];
  }
  next.version =
    commit.resetVersionFrom !== undefined &&
    previous.version === commit.resetVersionFrom
      ? commit.manifest.version
      : Math.max(previous.version, commit.manifest.version);
  return next;
}

function commitPreconditionsMatch(
  current: SyncManifest | null,
  commit: LayerStoreCommit,
): boolean {
  for (const expected of commit.expectedManifestEntries ?? []) {
    const actual = current?.entries[expected.path]?.hash ?? null;
    if (actual !== expected.hash) return false;
  }
  return true;
}

/** In-memory store — for tests, and a safe fallback where IndexedDB is absent. */
export function memStore(): LayerStore {
  const bodies = new Map<string, Uint8Array>();
  let manifest: SyncManifest | null = null;
  const lane: WriteLane = { tail: Promise.resolve() };
  return {
    getManifest: async () => (manifest ? cloneManifest(manifest) : null),
    setManifest: (m) =>
      enqueueWrite(lane, async () => {
        manifest = cloneManifest(m);
      }),
    getBody: async (p) => bodies.get(p)?.slice() ?? null,
    getAllBodies: async () =>
      new Map([...bodies].map(([path, body]) => [path, body.slice()])),
    putBody: (p, b) =>
      enqueueWrite(lane, async () => {
        bodies.set(p, b.slice());
      }),
    delBody: (p) =>
      enqueueWrite(lane, async () => {
        bodies.delete(p);
      }),
    bulkPut: (entries) =>
      enqueueWrite(lane, async () => {
        for (const [p, b] of entries) bodies.set(p, b.slice());
      }),
    replaceSnapshot: (expected, next, entries) =>
      enqueueWrite(lane, async () => {
        if (!sameManifest(manifest, expected)) {
          return {
            applied: false,
            manifest: manifest ? cloneManifest(manifest) : null,
          };
        }
        bodies.clear();
        for (const [path, body] of entries) bodies.set(path, body.slice());
        manifest = cloneManifest(next);
        return { applied: true, manifest: cloneManifest(manifest) };
      }),
    apply: (commit) =>
      enqueueWrite(lane, async () => {
        if (!commitPreconditionsMatch(manifest, commit)) return undefined;
        for (const [p, b] of commit.puts ?? []) bodies.set(p, b.slice());
        for (const p of commit.deletes ?? []) bodies.delete(p);
        manifest = mergeCommitManifest(manifest, commit);
        return cloneManifest(manifest);
      }),
    clear: () =>
      enqueueWrite(lane, async () => {
        bodies.clear();
        manifest = null;
      }),
  };
}

/* --------------------------------------------------------- IndexedDB store -- */

// Bump on any cached-manifest schema change so stale caches are dropped and the
// client re-hydrates cleanly (one bundle) instead of diffing an incompatible
// manifest. v2: manifest entry field `sha256` → `hash`.
const DB_VERSION = 2;
const BODIES = "bodies"; // key: path, value: Uint8Array
const META = "meta"; // key: "manifest", value: SyncManifest
const MANIFEST_KEY = "manifest";

interface IdbStoreState extends WriteLane {
  db: Promise<IDBDatabase>;
  refs: number;
}

const idbStores = new Map<string, IdbStoreState>();

function sharedIdbStore(dbName: string): IdbStoreState {
  let state = idbStores.get(dbName);
  if (!state) {
    state = { db: openStoreDb(dbName), tail: Promise.resolve(), refs: 0 };
    idbStores.set(dbName, state);
  }
  return state;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Open (or create at the current schema) one namespace's DB. Internal to the
 *  store — exported only for the read-only `peekNamespaces` probe (peek.ts),
 *  which must share this exact schema/version. */
export function openStoreDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Drop any prior-schema stores, then recreate empty (forces a clean cold
      // re-hydrate on a version bump rather than reading an incompatible cache).
      for (const store of [BODIES, META]) {
        if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
      }
      db.createObjectStore(BODIES);
      db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read the cached manifest off an already-open store DB (peek.ts companion). */
export async function readStoredManifest(
  db: IDBDatabase,
): Promise<SyncManifest | null> {
  const v = await reqDone(
    db.transaction(META, "readonly").objectStore(META).get(MANIFEST_KEY),
  );
  return (v as SyncManifest | undefined) ?? null;
}

/**
 * IndexedDB-backed store. One DB per namespace (`${idbPrefix}${namespace}`). A
 * thin hand-rolled wrapper (no `idb` dependency — the surface we need is small).
 */
export function idbStore(dbName: string): LayerStore {
  let shared = sharedIdbStore(dbName);
  const state = () => {
    if (idbStores.get(dbName) !== shared) shared = sharedIdbStore(dbName);
    return shared;
  };
  const db = () => state().db;
  const write = <T>(op: () => Promise<T>) => enqueueWrite(state(), op);

  return {
    acquire() {
      const retained = state();
      retained.refs++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained.refs--;
        void retained.tail.finally(() => {
          if (retained.refs !== 0 || idbStores.get(dbName) !== retained) return;
          idbStores.delete(dbName);
          void retained.db.then((database) => database.close()).catch(() => {});
        });
      };
    },
    async getManifest() {
      const d = await db();
      const v = await reqDone(
        d.transaction(META, "readonly").objectStore(META).get(MANIFEST_KEY),
      );
      return v ? cloneManifest(v as SyncManifest) : null;
    },
    setManifest: (m) =>
      write(async () => {
        const d = await db();
        const tx = d.transaction(META, "readwrite");
        tx.objectStore(META).put(m, MANIFEST_KEY);
        await txDone(tx);
      }),
    async getBody(path) {
      const d = await db();
      const v = await reqDone(
        d.transaction(BODIES, "readonly").objectStore(BODIES).get(path),
      );
      return (v as Uint8Array | undefined) ?? null;
    },
    async getAllBodies() {
      const d = await db();
      // One readonly transaction, two requests on the same store. getAllKeys()
      // and getAll() both return in ascending key order, so they pair by index.
      const os = d.transaction(BODIES, "readonly").objectStore(BODIES);
      const [keys, vals] = await Promise.all([
        reqDone(os.getAllKeys()),
        reqDone(os.getAll()),
      ]);
      const out = new Map<string, Uint8Array>();
      for (let i = 0; i < keys.length; i++) {
        out.set(String(keys[i]), vals[i] as Uint8Array);
      }
      return out;
    },
    putBody: (path, body) =>
      write(async () => {
        const d = await db();
        const tx = d.transaction(BODIES, "readwrite");
        tx.objectStore(BODIES).put(body, path);
        await txDone(tx);
      }),
    delBody: (path) =>
      write(async () => {
        const d = await db();
        const tx = d.transaction(BODIES, "readwrite");
        tx.objectStore(BODIES).delete(path);
        await txDone(tx);
      }),
    bulkPut: (entries) =>
      write(async () => {
        const d = await db();
        const tx = d.transaction(BODIES, "readwrite");
        const os = tx.objectStore(BODIES);
        for (const [p, b] of entries) os.put(b, p);
        await txDone(tx);
      }),
    replaceSnapshot: (expected, next, entries) =>
      write(async () => {
        const d = await db();
        const tx = d.transaction([BODIES, META], "readwrite");
        const bodies = tx.objectStore(BODIES);
        const meta = tx.objectStore(META);
        const stored = (await reqDone(meta.get(MANIFEST_KEY))) as
          | SyncManifest
          | undefined;
        const current = stored ?? null;
        if (!sameManifest(current, expected)) {
          await txDone(tx);
          return {
            applied: false,
            manifest: current ? cloneManifest(current) : null,
          };
        }
        bodies.clear();
        for (const [path, body] of entries) bodies.put(body, path);
        meta.put(next, MANIFEST_KEY);
        await txDone(tx);
        return { applied: true, manifest: cloneManifest(next) };
      }),
    apply: (commit) =>
      write(async () => {
        const d = await db();
        const tx = d.transaction([BODIES, META], "readwrite");
        const bodies = tx.objectStore(BODIES);
        const meta = tx.objectStore(META);
        const stored = await reqDone(meta.get(MANIFEST_KEY));
        const current = (stored as SyncManifest | undefined) ?? null;
        if (!commitPreconditionsMatch(current, commit)) {
          await txDone(tx);
          return undefined;
        }
        const next = mergeCommitManifest(current, commit);
        for (const [path, body] of commit.puts ?? []) bodies.put(body, path);
        for (const path of commit.deletes ?? []) bodies.delete(path);
        meta.put(next, MANIFEST_KEY);
        await txDone(tx);
        return cloneManifest(next);
      }),
    clear: () =>
      write(async () => {
        const d = await db();
        const tx = d.transaction([BODIES, META], "readwrite");
        tx.objectStore(BODIES).clear();
        tx.objectStore(META).clear();
        await txDone(tx);
      }),
  };
}
