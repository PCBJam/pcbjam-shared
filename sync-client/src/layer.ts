import {
  diffManifest,
  type ServerMsg,
  type SyncChange,
  type SyncEntry,
  type SyncManifest,
} from "@pcbjam/shared";
import type { LayerStore } from "./store.js";
import type { LayerHttp, RealtimeChannel } from "./transport.js";

export interface SyncLayerDeps {
  namespace: string;
  kind: "static" | "live";
  writable: boolean;
  store: LayerStore;
  http: LayerHttp;
  /** live only */
  channel?: RealtimeChannel;
  /** notify the stack of a low-level change (path-scoped) */
  onChange?: (c: SyncChange) => void;
}

const emptyManifest = (): SyncManifest => ({ version: 0, entries: {} });

function clone(m: SyncManifest): SyncManifest {
  return { version: m.version, entries: { ...m.entries } };
}

/**
 * One synced namespace: a local {@link LayerStore} kept in step with a remote via
 * {@link LayerHttp} (+ an optional realtime {@link RealtimeChannel} for `live`
 * layers). Holds an in-memory mirror of the cached manifest so `read`/`list` on
 * the stack are synchronous metadata lookups.
 */
export class SyncLayer {
  readonly namespace: string;
  readonly kind: "static" | "live";
  readonly writable: boolean;

  private readonly store: LayerStore;
  private readonly http: LayerHttp;
  private readonly channel?: RealtimeChannel;
  private readonly onChange?: (c: SyncChange) => void;

  private manifest: SyncManifest = emptyManifest();
  private syncing: Promise<void> | null = null;
  /** Paths with an in-flight local push, so the server's echo of our own write
   *  isn't re-fetched (the broadcast can beat the PUT response). */
  private readonly pendingPush = new Set<string>();

  constructor(d: SyncLayerDeps) {
    this.namespace = d.namespace;
    this.kind = d.kind;
    this.writable = d.writable;
    this.store = d.store;
    this.http = d.http;
    this.channel = d.channel;
    this.onChange = d.onChange;
  }

  /** Hydrate from cache then reconcile; wire realtime for `live` layers. */
  async open(): Promise<void> {
    this.manifest = (await this.store.getManifest()) ?? emptyManifest();
    if (Object.keys(this.manifest.entries).length === 0) await this.init();
    else await this.sync();

    if (this.channel) {
      this.channel.onOpen(() => void this.onReconnect());
      this.channel.onMessage((m) => void this.onMessage(m));
      // First connect: announce where we are so the server can tell us if behind.
      this.channel.send({ t: "hello", sinceVersion: this.manifest.version });
    }
  }

  /** Cold bulk hydrate — one bundle fetch. */
  async init(): Promise<void> {
    const { manifest, bodies } = await this.http.getBundle();
    await this.store.bulkPut(bodies);
    await this.store.setManifest(manifest);
    this.manifest = manifest;
  }

  /** Reconcile against the remote manifest (idempotent; concurrent calls coalesce). */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const remote = await this.http.getManifest();
    // Diff by HASH, not version. A static origin pins `version` to a constant, so
    // gating on version would mask a changed body (e.g. a re-mirror). diffManifest
    // is a cheap in-memory compare; when nothing changed it yields no fetches.
    const diff = diffManifest(this.manifest, remote);
    if (diff.put.length) await this.store.bulkPut(await this.http.getBodies(diff.put));
    for (const p of diff.del) await this.store.delBody(p);
    await this.store.setManifest(remote);
    this.manifest = remote;
    for (const p of diff.put) {
      const e = remote.entries[p];
      this.onChange?.({ op: "put", path: p, hash: e?.hash, size: e?.size, version: remote.version });
    }
    for (const p of diff.del) this.onChange?.({ op: "del", path: p, version: remote.version });
  }

  private async onReconnect(): Promise<void> {
    this.channel?.send({ t: "hello", sinceVersion: this.manifest.version });
    await this.sync();
  }

  private async onMessage(m: ServerMsg): Promise<void> {
    if (m.t === "synced" || m.t === "manifest") {
      if (m.version > this.manifest.version) await this.sync();
    } else if (m.t === "change") {
      await this.applyChange(m);
    }
  }

  /**
   * Apply one broadcast change incrementally. Self-echo and duplicates are
   * skipped idempotently (we already hold this sha / already lack this path), so
   * the server can broadcast to everyone without tracking the originator.
   */
  private async applyChange(c: SyncChange): Promise<void> {
    // Our own in-flight write — we already hold the body; don't re-fetch it.
    if (this.pendingPush.has(c.path)) {
      this.bumpVersion(c.version);
      return;
    }
    if (c.op === "put") {
      if (this.manifest.entries[c.path]?.hash === c.hash) {
        this.bumpVersion(c.version);
        return;
      }
      const fetched = await this.http.getBodies([c.path]);
      const got = fetched[0];
      if (!got) return;
      await this.store.putBody(c.path, got[1]);
      this.manifest.entries[c.path] = {
        hash: c.hash ?? "",
        size: c.size ?? got[1].length,
        mtime: Date.now(),
      };
    } else {
      if (!this.manifest.entries[c.path]) {
        this.bumpVersion(c.version);
        return;
      }
      await this.store.delBody(c.path);
      delete this.manifest.entries[c.path];
    }
    this.manifest.version = Math.max(this.manifest.version, c.version);
    await this.store.setManifest(this.manifest);
    this.onChange?.(c);
  }

  private bumpVersion(version: number): void {
    if (version > this.manifest.version) {
      this.manifest.version = version;
      void this.store.setManifest(this.manifest);
    }
  }

  /** Write a body (optimistic local apply + PUT; rolls back on failure). The
   *  content `hash` is reconciled from the server's response — never computed here. */
  async push(path: string, body: Uint8Array): Promise<void> {
    if (!this.writable) throw new Error(`layer ${this.namespace} is not writable`);
    const prevBody = await this.store.getBody(path);
    const prevManifest = clone(this.manifest);
    this.pendingPush.add(path);

    await this.store.putBody(path, body);
    this.manifest.entries[path] = { hash: "", size: body.length, mtime: Date.now() };

    try {
      const res = await this.http.putBody(path, body);
      this.manifest.entries[path] = { hash: res.hash, size: res.size, mtime: Date.now() };
      this.manifest.version = res.version;
      await this.store.setManifest(this.manifest);
    } catch (e) {
      await this.rollback(path, prevBody, prevManifest);
      throw e;
    } finally {
      this.pendingPush.delete(path);
    }
    const entry = this.manifest.entries[path];
    this.onChange?.({ op: "put", path, hash: entry?.hash, size: body.length, version: this.manifest.version });
  }

  /** Remove a body from this layer (optimistic local apply + DELETE). */
  async delete(path: string): Promise<void> {
    if (!this.writable) throw new Error(`layer ${this.namespace} is not writable`);
    const prevBody = await this.store.getBody(path);
    const prevManifest = clone(this.manifest);
    this.pendingPush.add(path);

    await this.store.delBody(path);
    delete this.manifest.entries[path];

    try {
      const res = await this.http.deleteBody(path);
      this.manifest.version = res.version;
      await this.store.setManifest(this.manifest);
    } catch (e) {
      await this.rollback(path, prevBody, prevManifest);
      throw e;
    } finally {
      this.pendingPush.delete(path);
    }
    this.onChange?.({ op: "del", path, version: this.manifest.version });
  }

  private async rollback(
    path: string,
    prevBody: Uint8Array | null,
    prevManifest: SyncManifest,
  ): Promise<void> {
    if (prevBody) await this.store.putBody(path, prevBody);
    else await this.store.delBody(path);
    this.manifest = prevManifest;
    await this.store.setManifest(prevManifest);
  }

  /* ---- synchronous metadata lookups used by the stack merge ---- */

  hasPath(path: string): boolean {
    return this.manifest.entries[path] !== undefined;
  }

  entries(): Record<string, SyncEntry> {
    return this.manifest.entries;
  }

  version(): number {
    return this.manifest.version;
  }

  getBody(path: string): Promise<Uint8Array | null> {
    return this.store.getBody(path);
  }

  /**
   * Every body this layer currently provides, scoped to the in-memory manifest so
   * the result matches {@link hasPath}/{@link entries} (the source of truth the
   * stack merges on). One bulk store read; a manifest entry whose body is somehow
   * absent from the cache is simply omitted (the per-item `getBody` path still
   * covers it). Used by the stack's bulk "fat list" load.
   */
  async readAll(): Promise<Map<string, Uint8Array>> {
    const all = await this.store.getAllBodies();
    const out = new Map<string, Uint8Array>();
    for (const path of Object.keys(this.manifest.entries)) {
      const body = all.get(path);
      if (body) out.set(path, body);
    }
    return out;
  }

  close(): void {
    this.channel?.close();
  }
}
