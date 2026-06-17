import type { SyncManifest } from "@pcbjam/shared";

/**
 * Local byte cache + cached manifest for ONE namespace. The stack keeps one store
 * per layer namespace, so a shared static origin namespace reuses the same store
 * across every stack that includes it (dedup).
 *
 * Production uses `idbStore()` (IndexedDB). Tests inject `memStore()`. The sync
 * logic depends only on this interface, never on IndexedDB directly.
 */
export interface LayerStore {
  getManifest(): Promise<SyncManifest | null>;
  setManifest(m: SyncManifest): Promise<void>;
  getBody(path: string): Promise<Uint8Array | null>;
  putBody(path: string, body: Uint8Array): Promise<void>;
  delBody(path: string): Promise<void>;
  /** Write many bodies in one transaction (cold `init` bulk hydrate). */
  bulkPut(entries: Array<[string, Uint8Array]>): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory store — for tests, and a safe fallback where IndexedDB is absent. */
export function memStore(): LayerStore {
  const bodies = new Map<string, Uint8Array>();
  let manifest: SyncManifest | null = null;
  return {
    getManifest: async () => manifest,
    setManifest: async (m) => {
      manifest = m;
    },
    getBody: async (p) => bodies.get(p) ?? null,
    putBody: async (p, b) => {
      bodies.set(p, b);
    },
    delBody: async (p) => {
      bodies.delete(p);
    },
    bulkPut: async (entries) => {
      for (const [p, b] of entries) bodies.set(p, b);
    },
    clear: async () => {
      bodies.clear();
      manifest = null;
    },
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

function openDb(name: string): Promise<IDBDatabase> {
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

/**
 * IndexedDB-backed store. One DB per namespace (`${idbPrefix}${namespace}`). A
 * thin hand-rolled wrapper (no `idb` dependency — the surface we need is small).
 */
export function idbStore(dbName: string): LayerStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb(dbName));

  return {
    async getManifest() {
      const d = await db();
      const v = await reqDone(
        d.transaction(META, "readonly").objectStore(META).get(MANIFEST_KEY),
      );
      return (v as SyncManifest | undefined) ?? null;
    },
    async setManifest(m) {
      const d = await db();
      const tx = d.transaction(META, "readwrite");
      tx.objectStore(META).put(m, MANIFEST_KEY);
      await txDone(tx);
    },
    async getBody(path) {
      const d = await db();
      const v = await reqDone(
        d.transaction(BODIES, "readonly").objectStore(BODIES).get(path),
      );
      return (v as Uint8Array | undefined) ?? null;
    },
    async putBody(path, body) {
      const d = await db();
      const tx = d.transaction(BODIES, "readwrite");
      tx.objectStore(BODIES).put(body, path);
      await txDone(tx);
    },
    async delBody(path) {
      const d = await db();
      const tx = d.transaction(BODIES, "readwrite");
      tx.objectStore(BODIES).delete(path);
      await txDone(tx);
    },
    async bulkPut(entries) {
      const d = await db();
      const tx = d.transaction(BODIES, "readwrite");
      const os = tx.objectStore(BODIES);
      for (const [p, b] of entries) os.put(b, p);
      await txDone(tx);
    },
    async clear() {
      const d = await db();
      const tx = d.transaction([BODIES, META], "readwrite");
      tx.objectStore(BODIES).clear();
      tx.objectStore(META).clear();
      await txDone(tx);
    },
  };
}
