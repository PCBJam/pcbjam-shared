import type { LayerDescriptor, SyncChange } from "@pcbjam/shared";
import { SyncLayer } from "./layer.js";
import { idbStore, type LayerStore } from "./store.js";
import {
  defaultChannelFactory,
  httpLayer,
  type ChannelFactory,
} from "./transport.js";

/** A merged-view change the stack emits to subscribers (post top-wins merge). */
export interface MergedChange {
  path: string;
  /** true if some layer still provides the path after the merge; false = gone. */
  present: boolean;
}

export interface SyncStackOptions {
  /** Layers bottom → top; merged top-wins. Writes go to the top writable layer. */
  layers: LayerDescriptor[];
  /** IDB database name prefix (default "sync:"). */
  idbPrefix?: string;
  fetchImpl?: typeof fetch;
  channelFactory?: ChannelFactory;
  /** Override store creation (tests inject memStore); default = idbStore. */
  storeFactory?: (namespace: string) => LayerStore;
  /**
   * Which live layers dial a realtime channel. `"all"` (default) connects every
   * live layer. `"shared-only"` connects only layers carrying a multiplex key
   * (`d.channel.lib` — they ride one shared socket per room); a live layer
   * WITHOUT one would cost a dedicated WebSocket of its own, so it stays
   * HTTP-only and reconciles on `open()`/`sync()` instead. Bulk consumers
   * (a board session warming 150+ libs) pass this; a focused consumer (the
   * lib editor on its one lib) keeps `"all"` for realtime peer edits.
   */
  realtime?: "all" | "shared-only";
}

/**
 * The public client: opens an ordered stack of {@link SyncLayer}s and presents a
 * single merged, locally-served view. `read`/`list` merge top-wins; `push`/
 * `delete` target the top writable layer. Knows nothing about libs/KiCad — the
 * caller maps its own ids/paths onto namespaces and paths.
 */
export class SyncStack {
  /** bottom → top */
  private readonly layers: SyncLayer[];
  private readonly subs = new Set<(c: MergedChange) => void>();
  /** For the deferred-realtime upgrade ({@link connectRealtime}). */
  private readonly descriptors: LayerDescriptor[];
  private readonly channelFactory: ChannelFactory;

  constructor(opts: SyncStackOptions) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const channelFactory = opts.channelFactory ?? defaultChannelFactory;
    this.descriptors = opts.layers;
    this.channelFactory = channelFactory;
    const idbPrefix = opts.idbPrefix ?? "sync:";
    const makeStore =
      opts.storeFactory ?? ((ns: string) => idbStore(`${idbPrefix}${ns}`));

    this.layers = opts.layers.map((d) => {
      const http = httpLayer(d.url, d.token, fetchImpl, d.kind);
      // Realtime dials the shared room socket when the descriptor names one
      // (d.channel — multiplexed by lib); HTTP always stays on the layer url.
      // Under "shared-only", a live layer with no multiplex key gets no channel
      // at all — it would otherwise open a dedicated socket per layer.
      const wantsChannel =
        d.kind === "live" &&
        (opts.realtime !== "shared-only" || d.channel?.lib !== undefined);
      const channel =
        wantsChannel
          ? channelFactory({
              url: d.channel?.url ?? d.url,
              namespace: d.namespace,
              token: d.token,
              lib: d.channel?.lib,
            })
          : undefined;
      return new SyncLayer({
        namespace: d.namespace,
        kind: d.kind,
        writable: !!d.writable,
        store: makeStore(d.namespace),
        http,
        channel,
        bodyUrlTemplate: d.bodyUrlTemplate,
        digest: d.digest,
        onChange: (c) => void this.onLayerChange(c),
      });
    });
  }

  /** Open (init-or-sync) every layer; connect live channels. */
  async open(): Promise<void> {
    await Promise.all(this.layers.map((l) => l.open()));
  }

  /** Re-reconcile every layer against its remote. */
  async sync(): Promise<void> {
    await Promise.all(this.layers.map((l) => l.sync()));
  }

  /** Merged body for a path: the topmost layer that provides it wins. */
  async read(path: string): Promise<Uint8Array | null> {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]!;
      if (l.hasPath(path)) return l.getBody(path);
    }
    return null;
  }

  /**
   * Merged bodies for every path in one shot — the bulk counterpart of
   * {@link read}. Layers are read bottom → top and overlaid, so the topmost layer
   * providing a path wins, identical to {@link read}/{@link list}. Per-layer reads
   * run concurrently; the merge preserves stack order. Lets a caller hydrate a
   * whole namespace (e.g. a KiCad library) without N per-item round-trips.
   */
  async readAll(): Promise<Map<string, Uint8Array>> {
    const perLayer = await Promise.all(this.layers.map((l) => l.readAll()));
    const merged = new Map<string, Uint8Array>();
    for (const layerBodies of perLayer) {
      for (const [path, body] of layerBodies) merged.set(path, body);
    }
    return merged;
  }

  /** Merged listing: top layers override lower ones by path. */
  async list(): Promise<Array<{ path: string; hash: string; size: number }>> {
    const merged = new Map<string, { hash: string; size: number }>();
    for (const l of this.layers) {
      for (const [path, e] of Object.entries(l.entries())) {
        merged.set(path, { hash: e.hash, size: e.size });
      }
    }
    return [...merged].map(([path, e]) => ({ path, ...e }));
  }

  push(path: string, body: Uint8Array): Promise<void> {
    return this.topWritable().push(path, body);
  }

  delete(path: string): Promise<void> {
    return this.topWritable().delete(path);
  }

  subscribe(cb: (c: MergedChange) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /**
   * Promote live layers opened channel-less (`realtime: "shared-only"`) to
   * realtime NOW — the second half of the deferred-realtime upgrade. Called
   * when the consumer learns this stack's namespaces actually matter (e.g.
   * the open document references this lib, so a peer's edit should reach the
   * session live, not on the next load). Idempotent; layers that already hold
   * a channel are untouched.
   */
  connectRealtime(): void {
    this.layers.forEach((layer, i) => {
      const d = this.descriptors[i]!;
      if (d.kind !== "live" || layer.hasChannel) return;
      layer.attachChannel(
        this.channelFactory({
          url: d.channel?.url ?? d.url,
          namespace: d.namespace,
          token: d.token,
          lib: d.channel?.lib,
        }),
      );
    });
  }

  close(): void {
    for (const l of this.layers) l.close();
  }

  private topWritable(): SyncLayer {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      if (this.layers[i]!.writable) return this.layers[i]!;
    }
    throw new Error("no writable layer in stack");
  }

  private async onLayerChange(c: SyncChange): Promise<void> {
    const merged = await this.read(c.path);
    const ev: MergedChange = { path: c.path, present: merged !== null };
    for (const cb of this.subs) cb(ev);
  }
}
