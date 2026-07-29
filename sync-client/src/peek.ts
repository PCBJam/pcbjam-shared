import type { SyncManifest } from "@pcbjam/shared";
import { openStoreDb, readStoredManifest, type LayerStore } from "./store.js";

/** What {@link peekNamespaces} reports for one warm namespace. */
export interface NamespacePeek {
  /** Cached item count (manifest entries). */
  entries: number;
  /** Sum of the cached entries' body sizes, in bytes. */
  totalSize: number;
}

/**
 * Read-only cache probe: which of these namespaces are already warm locally,
 * and how much do they hold? Never fetches, never initializes a cache — the
 * "is this lib already downloaded?" check behind the standalone's download
 * consent dialog (standalone-load-ux 0001), where opening a real
 * SyncStack/SyncLayer would trigger the very cold bundle download the caller
 * is asking about.
 *
 * A namespace maps to `null` when cold: no local store, no cached manifest, or
 * an empty one (SyncLayer.open treats empty-entries as cold and bulk-hydrates,
 * so "empty" and "absent" are the same answer to the caller's question).
 *
 * Production probes IndexedDB directly. Where `indexedDB.databases()` exists it
 * pre-filters to stores that actually exist, so probing N cold namespaces
 * creates no empty databases; without it (older Firefox) the probe falls back
 * to opening each DB (creating an empty one for cold namespaces — harmless:
 * the layer's own open() sees the empty manifest and cold-hydrates as usual).
 * Tests inject `storeFactory` (memStore) exactly as SyncStackOptions does.
 */
export async function peekNamespaces(
  namespaces: string[],
  opts?: {
    /** IDB database name prefix (default "sync:", matching SyncStack). */
    idbPrefix?: string;
    storeFactory?: (namespace: string) => LayerStore;
  },
): Promise<Map<string, NamespacePeek | null>> {
  const idbPrefix = opts?.idbPrefix ?? "sync:";
  const out = new Map<string, NamespacePeek | null>();

  const fromManifest = (m: SyncManifest | null): NamespacePeek | null => {
    const paths = m ? Object.keys(m.entries) : [];
    if (paths.length === 0) return null;
    let totalSize = 0;
    for (const p of paths) totalSize += m!.entries[p]?.size ?? 0;
    return { entries: paths.length, totalSize };
  };

  if (opts?.storeFactory) {
    const makeStore = opts.storeFactory;
    await Promise.all(
      namespaces.map(async (ns) => {
        try {
          out.set(ns, fromManifest(await makeStore(ns).getManifest()));
        } catch {
          out.set(ns, null);
        }
      }),
    );
    return out;
  }

  if (typeof indexedDB === "undefined") {
    for (const ns of namespaces) out.set(ns, null);
    return out;
  }

  // Which DBs exist, when the API is there — so cold probes create nothing.
  let existing: Set<string> | null = null;
  const idb = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof idb.databases === "function") {
    try {
      existing = new Set(
        (await idb.databases()).map((d) => d.name).filter((n): n is string => !!n),
      );
    } catch {
      existing = null; // unsupported/flaky — fall back to opening
    }
  }

  await Promise.all(
    namespaces.map(async (ns) => {
      const dbName = `${idbPrefix}${ns}`;
      if (existing && !existing.has(dbName)) {
        out.set(ns, null);
        return;
      }
      try {
        const db = await openStoreDb(dbName);
        try {
          out.set(ns, fromManifest(await readStoredManifest(db)));
        } finally {
          db.close(); // a probe must not hold N connections open
        }
      } catch {
        out.set(ns, null);
      }
    }),
  );
  return out;
}
