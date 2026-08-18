import {
  diffManifest,
  manifestDigest,
  type ServerMsg,
  type SyncChange,
  type SyncEntry,
  type SyncManifest,
} from "@pcbjam/shared";
import type { LayerStore } from "./store.js";
import type { LayerHttp, RealtimeChannel } from "./transport.js";

export type LayerChange = SyncChange & { origin: "local" | "remote" };

export interface SyncLayerDeps {
  namespace: string;
  kind: "static" | "live" | "sparse";
  writable: boolean;
  store: LayerStore;
  http: LayerHttp;
  channel?: RealtimeChannel;
  bodyUrlTemplate?: string;
  digest?: string;
  immutable?: boolean;
  /**
   * The channel is a mux facade on a registry-bearing room (descriptor carried
   * `channel.lib`): open() may skip the eager manifest sync and instead await
   * the room's registry verdict — affirm (digest match) keeps the skip; a
   * mismatch, an omitted entry (dirty), or silence past `registryDeadlineMs`
   * falls back to sync(). See load-path-rework 0002 §3.3.
   */
  registryEligible?: boolean;
  registryDeadlineMs?: number;
  onChange?: (change: LayerChange) => void;
  /** Optional lower ceilings for constrained hosts and deterministic tests. */
  mutationQueueLimits?: Partial<SyncMutationQueueLimits>;
  /** Maximum time an HTTP mutation may retain its path FIFO without either an
   * HTTP receipt or its exact websocket echo. */
  mutationReceiptDeadlineMs?: number;
}

/** Active plus queued local mutations retained by one layer. */
export interface SyncMutationQueueLimits {
  maxPerPath: number;
  maxPerLayer: number;
  maxRetainedBodyBytes: number;
}

export const DEFAULT_SYNC_MUTATION_QUEUE_LIMITS: Readonly<SyncMutationQueueLimits> =
  Object.freeze({
    maxPerPath: 64,
    maxPerLayer: 1_024,
    maxRetainedBodyBytes: 64 * 1024 * 1024,
  });

export type SyncMutationQueueFullReason =
  | "path-mutations"
  | "layer-mutations"
  | "retained-body-bytes";

/** Admission failed before the layer copied or sent the mutation body. */
export class SyncMutationQueueFullError extends Error {
  readonly name = "SyncMutationQueueFullError";

  constructor(
    readonly namespace: string,
    readonly path: string,
    readonly reason: SyncMutationQueueFullReason,
  ) {
    super(`sync mutation queue full (${reason}) for ${namespace}:${path}`);
  }
}

interface PathState {
  latest: number;
  active: Set<number>;
}

interface LocalMutation {
  id: string;
  path: string;
  op: "put" | "del";
  body?: Uint8Array;
  generation: number;
  sequence: number;
  collided: boolean;
  echo?: SyncChange;
  echoLatch: MutationEchoLatch;
}

interface MutationEchoLatch {
  promise: Promise<SyncChange>;
  resolve: (echo: SyncChange) => void;
}

interface LocalMutationJob {
  mutation: LocalMutation;
  retainedBodyBytes: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface LocalMutationLane {
  running: boolean;
  queue: LocalMutationJob[];
}

interface LocalReceipt {
  op: "put" | "del";
  version: number;
  hash?: string;
  size?: number;
}

interface CompletedMutationEcho extends LocalReceipt {
  path: string;
}

function sameReceipt(
  left: LocalReceipt | SyncChange,
  right: LocalReceipt | SyncChange,
): boolean {
  return (
    left.op === right.op &&
    left.version === right.version &&
    (left.op === "del" ||
      (right.op === "put" &&
        left.hash === right.hash &&
        left.size === right.size))
  );
}

const MAX_COMPLETED_MUTATION_IDS = 4_096;
const MAX_REMOTE_PATHS = 256;
const DEFAULT_MUTATION_RECEIPT_DEADLINE_MS = 30_000;
/**
 * How long a registry-skipped open waits for the room's registry frame before
 * falling back to the manifest sync. Short on purpose: the frame rides the
 * just-opened socket, so silence past this window means an old server or a
 * down socket — both of which must degrade to exactly today's behavior.
 */
const DEFAULT_REGISTRY_DEADLINE_MS = 1_500;
const INITIAL_REPAIR_DELAY_MS = 100;
const MAX_REPAIR_DELAY_MS = 30_000;

class MutationReceiptDeadlineError extends Error {
  readonly name = "MutationReceiptDeadlineError";

  constructor(namespace: string, path: string, deadlineMs: number) {
    super(
      `mutation receipt deadline (${deadlineMs} ms) for ${namespace}:${path}`,
    );
  }
}

class MutationEchoReceiptError extends Error {
  readonly name = "MutationEchoReceiptError";

  constructor(readonly echo: SyncChange) {
    super(`exact mutation echo received for ${echo.path}`);
  }
}

function createMutationEchoLatch(): MutationEchoLatch {
  let resolve!: (echo: SyncChange) => void;
  const promise = new Promise<SyncChange>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface PendingRemoteChange {
  change: SyncChange;
  generation: number;
  sequence: number;
}

interface RemotePathDrain {
  latest?: PendingRemoteChange;
  promise: Promise<void>;
}

class BodySizeMismatchError extends Error {
  readonly name = "BodySizeMismatchError";

  constructor(
    readonly path: string,
    readonly actualSize: number,
    readonly expectedSize: number,
    source: string,
  ) {
    super(
      `${source} body size ${actualSize} does not match advertised size ${expectedSize} for ${path}`,
    );
  }
}

/**
 * Validate the byte count at the point where a remote result is about to become
 * cache state. The generic client cannot recompute an opaque backend hash, but
 * it can always enforce a supplied byte count. Older change frames may omit
 * `size`; in that rolling-compatibility case the received byte count becomes
 * the entry size instead of pretending that an independent value was checked.
 */
function validateBodySize(
  path: string,
  body: Uint8Array,
  expectedSize: number | undefined,
  source: string,
): number {
  if (expectedSize === undefined) return body.byteLength;
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    body.byteLength !== expectedSize
  ) {
    throw new BodySizeMismatchError(
      path,
      body.byteLength,
      expectedSize,
      source,
    );
  }
  return expectedSize;
}

function validateBundleSnapshot(
  manifest: SyncManifest,
  bodies: Array<[string, Uint8Array]>,
): void {
  // The fingerprint algorithm is deliberately opaque to the generic client;
  // the server binds bytes to it. Here we enforce everything independently
  // knowable from the bundle: exact path set, uniqueness, and advertised size.
  const expected = Object.keys(manifest.entries);
  if (bodies.length !== expected.length) {
    throw new Error(
      `bundle body count ${bodies.length} does not match manifest count ${expected.length}`,
    );
  }

  const seen = new Set<string>();
  for (const [path, body] of bodies) {
    const entry = manifest.entries[path];
    if (!entry) throw new Error(`bundle contains unadvertised body ${path}`);
    if (seen.has(path)) throw new Error(`bundle contains duplicate body ${path}`);
    validateBodySize(path, body, entry.size, "bundle");
    seen.add(path);
  }
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

function randomId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // Non-secure legacy browser context: use the compatibility fallback below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function positiveIntegerLimit(
  configured: number | undefined,
  fallback: number,
  name: string,
): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * One cached namespace. Network operations run concurrently. Only short cache
 * commits share a lane, and local mutations of the same path share a bounded
 * explicit FIFO. Different path FIFOs can perform network I/O concurrently.
 * A path sequence is a compare-and-swap token: a late response cannot publish
 * after a newer source has claimed that path.
 */
export class SyncLayer {
  readonly namespace: string;
  readonly kind: "static" | "live" | "sparse";
  readonly writable: boolean;

  private readonly store: LayerStore;
  private readonly releaseStore?: () => void;
  private readonly http: LayerHttp;
  /** All HTTP started by this layer shares a cancellation lifetime. Source/path
   * sequencing still decides publication; abort releases transport buffers when
   * close makes every result unpublishable. */
  private readonly httpAbort = new AbortController();
  private channel?: RealtimeChannel;
  private openComplete = false;
  private channelReady = false;
  private readonly bodyUrlTemplate?: string;
  private readonly digest?: string;
  private readonly immutable?: boolean;
  private readonly registryEligible: boolean;
  private readonly registryDeadlineMs: number;
  /** Armed between a registry-skipped open and its verdict (frame or deadline).
   *  `timer` is null while the watch is PASSIVE — armed before the channel has
   *  ever opened, where a deadline would only race the socket dial. */
  private registryWatch: { timer: ReturnType<typeof setTimeout> | null } | null =
    null;
  /** undefined = no registry frame yet; null = frame arrived without our entry. */
  private registryEntry: { v: number; digest: string } | null | undefined;
  private readonly onChange?: (change: LayerChange) => void;

  private manifest: SyncManifest = emptyManifest();
  /** Local intent stays in memory. Persistent body+manifest state is always
   * authoritative and is published atomically only after the server ACK. */
  private readonly optimistic = new Map<string, Uint8Array | null>();

  private syncing: Promise<void> | null = null;
  private syncRequested = false;
  private commitTail: Promise<void> = Promise.resolve();

  private sourceClock = 0;
  private readonly paths = new Map<string, PathState>();
  private readonly activeSyncs = new Set<number>();
  private readonly mutationQueueLimits: SyncMutationQueueLimits;
  private readonly mutationReceiptDeadlineMs: number;
  private readonly localPathLanes = new Map<string, LocalMutationLane>();
  /** Active plus queued local mutation records. */
  private localMutationCount = 0;
  /** Snapshot bytes held by active plus queued local puts. */
  private localMutationBodyBytes = 0;
  private readonly localByPath = new Map<string, LocalMutation>();

  private readonly activeMutations = new Map<string, LocalMutation>();
  /** Bounded exact self-echo tombstones. IDs are disclosed in broadcasts, so a
   * tombstone also records every receipt identity field that can be compared. */
  private readonly completedMutations = new Map<string, CompletedMutationEcho>();
  private readonly remotePaths = new Map<string, RemotePathDrain>();
  private channelRefresh: Promise<void> | null = null;

  private repairTimer: ReturnType<typeof setTimeout> | undefined;
  private repairDelayMs = INITIAL_REPAIR_DELAY_MS;
  private repairRunning = false;
  /** Coalesces any number of repair requests into one guaranteed next pass. */
  private repairRequested = false;

  private readonly sparseInflight = new Map<
    string,
    { hash: string; generation: number; promise: Promise<Uint8Array | null> }
  >();
  private lifecycleGeneration = 0;
  private closed = false;

  constructor(deps: SyncLayerDeps) {
    this.namespace = deps.namespace;
    this.kind = deps.kind;
    this.writable = deps.writable;
    this.store = deps.store;
    this.releaseStore = deps.store.acquire?.();
    this.http = deps.http;
    this.channel = deps.channel;
    this.bodyUrlTemplate = deps.bodyUrlTemplate;
    this.digest = deps.digest;
    this.immutable = deps.immutable;
    this.registryEligible = deps.registryEligible ?? false;
    this.registryDeadlineMs = positiveIntegerLimit(
      deps.registryDeadlineMs,
      DEFAULT_REGISTRY_DEADLINE_MS,
      "registryDeadlineMs",
    );
    this.onChange = deps.onChange;
    this.mutationQueueLimits = {
      maxPerPath: positiveIntegerLimit(
        deps.mutationQueueLimits?.maxPerPath,
        DEFAULT_SYNC_MUTATION_QUEUE_LIMITS.maxPerPath,
        "maxPerPath",
      ),
      maxPerLayer: positiveIntegerLimit(
        deps.mutationQueueLimits?.maxPerLayer,
        DEFAULT_SYNC_MUTATION_QUEUE_LIMITS.maxPerLayer,
        "maxPerLayer",
      ),
      maxRetainedBodyBytes: positiveIntegerLimit(
        deps.mutationQueueLimits?.maxRetainedBodyBytes,
        DEFAULT_SYNC_MUTATION_QUEUE_LIMITS.maxRetainedBodyBytes,
        "maxRetainedBodyBytes",
      ),
    };
    this.mutationReceiptDeadlineMs = positiveIntegerLimit(
      deps.mutationReceiptDeadlineMs,
      DEFAULT_MUTATION_RECEIPT_DEADLINE_MS,
      "mutationReceiptDeadlineMs",
    );
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error(`layer ${this.namespace} is closed`);
    const generation = this.lifecycleGeneration;
    const stored = await this.store.getManifest();
    if (!this.isCurrentGeneration(generation)) return;
    this.manifest = stored ? cloneManifest(stored) : emptyManifest();

    // A connected socket can broadcast before our hello. Install its handlers
    // first, but do not trust a numeric `synced` reply until HTTP has compared
    // the actual manifest entries below.
    if (this.channel) this.wireChannel(this.channel, generation);

    if (this.kind === "sparse") {
      await this.sync();
    } else {
      if (!stored) await this.init(stored);
      if (this.channel) {
        if (this.kind === "live" && this.registryEligible) {
          // Registry-bearing room: skip the eager GET and let the room's
          // registry frame affirm the stored snapshot (or force the sync).
          // open() completes immediately — reads serve the stored snapshot
          // until the verdict, the same staleness window realtime already has.
          // Passive (no deadline) until the channel's open event re-arms it.
          this.armRegistryWatch(generation, false);
        } else {
          await this.sync();
        }
      } else if (
        stored &&
        (this.kind === "live" ||
          !(
            this.immutable ||
            (this.digest && (await manifestDigest(this.manifest)) === this.digest)
          ))
      ) {
        // A live room can have a durable dirty marker whose recovery runs only
        // when its manifest is loaded. Digest bookkeeping is outside that
        // Durable Object/R2 transaction, so it cannot prove a live cache
        // current. Channel-less live layers must always perform the GET —
        // `immutable` is likewise ignored for them (guarded by the `live`
        // branch above), it is only meaningful for version-pinned statics.
        await this.sync();
      }
    }

    if (this.channel && this.isCurrentGeneration(generation)) {
      this.channelReady = true;
      this.sendHello(this.channel, generation);
    }
    if (this.isCurrentGeneration(generation)) this.openComplete = true;
  }

  /**
   * Await the room's registry verdict instead of eagerly syncing. A frame that
   * already arrived (wireChannel runs before the open decision) settles
   * immediately. `withDeadline` guards the silent-room fallback (old server,
   * half-dead socket): it is armed only from the channel's OPEN handler —
   * counting down before the socket has even connected would just race the
   * dial (worker authorize + DO wake can exceed any sane deadline) and burst
   * pointless GETs, which is exactly what the registry exists to remove. A
   * passive (pre-open) watch resolves via the frame, or is re-armed WITH the
   * deadline when the open event lands (every mux facade gets one — the mux
   * synthesizes it for facades created after the raw socket opened).
   */
  private armRegistryWatch(generation: number, withDeadline: boolean): void {
    if (this.registryEntry !== undefined) {
      void this.settleRegistryVerdict();
      return;
    }
    this.registryWatch = {
      timer: withDeadline
        ? setTimeout(() => {
            if (!this.isCurrentGeneration(generation) || !this.registryWatch) {
              return;
            }
            this.registryWatch = null;
            void this.sync();
          }, this.registryDeadlineMs)
        : null,
    };
  }

  /** Digest match keeps the skipped sync skipped; anything else syncs. */
  private async settleRegistryVerdict(): Promise<void> {
    const entry = this.registryEntry;
    const affirmed =
      entry != null && (await manifestDigest(this.manifest)) === entry.digest;
    if (!affirmed) await this.sync();
  }

  attachChannel(channel: RealtimeChannel): void {
    if (this.closed) {
      channel.close();
      return;
    }
    if (this.channel) {
      channel.close();
      return;
    }
    this.channel = channel;
    this.channelReady = this.openComplete;
    this.wireChannel(channel, this.lifecycleGeneration);
    if (this.channelReady) {
      this.refreshThenHello(channel, this.lifecycleGeneration);
    }
  }

  get hasChannel(): boolean {
    return this.channel !== undefined;
  }

  private wireChannel(channel: RealtimeChannel, generation: number): void {
    channel.onOpen(() => {
      if (this.channelReady) this.refreshThenHello(channel, generation);
    });
    channel.onMessage((message) => {
      if (!this.isCurrentGeneration(generation)) return;
      void this.onMessage(message, generation).catch(() => {
        this.requestRepair();
      });
    });
  }

  private sendHello(channel: RealtimeChannel, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    channel.send({ t: "hello", sinceVersion: this.manifest.version });
  }

  private refreshThenHello(channel: RealtimeChannel, generation: number): void {
    if (!this.isCurrentGeneration(generation) || this.channelRefresh) return;
    if (this.kind === "live" && this.registryEligible) {
      // Registry-bearing room: it re-sends its snapshot on EVERY connect, so
      // let the verdict decide whether this (re)connect needs a resync. An
      // unconditional sync here would re-create the very warm-load GET burst
      // the registry exists to remove — `onOpen` fires on the FIRST connect
      // too, which in a real browser lands right after open() completed and
      // would have synced every mux'd layer on every page load. Staleness is
      // covered: a pre-reconnect verdict is discarded (below and in the mux's
      // snapshot invalidation), a mismatching or missing frame syncs, and the
      // deadline syncs when the room stays silent.
      this.registryEntry = undefined;
      if (this.registryWatch) {
        if (this.registryWatch.timer !== null) clearTimeout(this.registryWatch.timer);
        this.registryWatch = null;
      }
      this.armRegistryWatch(generation, true);
      this.sendHello(channel, generation);
      return;
    }
    this.channelRefresh = this.sync()
      .then(() => this.sendHello(channel, generation))
      .catch(() => this.requestRepair())
      .finally(() => {
        this.channelRefresh = null;
      });
  }

  async init(expectedManifest?: SyncManifest | null): Promise<void> {
    const generation = this.lifecycleGeneration;
    const expected =
      expectedManifest === undefined
        ? await this.store.getManifest()
        : expectedManifest;
    if (!this.isCurrentGeneration(generation)) return;
    const bundle = await this.http.getBundle(this.httpAbort.signal);
    validateBundleSnapshot(bundle.manifest, bundle.bodies);
    let reconcile = false;
    await this.enqueueCommit(async () => {
      if (!this.isCurrentGeneration(generation)) return;
      const next = cloneManifest(bundle.manifest);
      const persisted = await this.store.replaceSnapshot(
        expected,
        next,
        bundle.bodies,
      );
      if (this.isCurrentGeneration(generation)) {
        this.manifest = persisted.manifest
          ? cloneManifest(persisted.manifest)
          : emptyManifest();
        reconcile = !persisted.applied;
      }
    });
    // A competing lifetime published after our request started. Do not retry
    // the stale bundle. Re-read the server's current manifest and use the normal
    // path-scoped reconciliation, which preserves still-newer cache publishers.
    if (reconcile && this.isCurrentGeneration(generation)) await this.sync();
  }

  /** Concurrent callers share a drain. A request that arrives during a pass
   * requests exactly one follow-up pass, so each caller has a post-call barrier. */
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.syncRequested = true;
    if (!this.syncing) {
      const generation = this.lifecycleGeneration;
      this.syncing = this.drainSyncRequests(generation).finally(() => {
        this.syncing = null;
        if (this.syncRequested) return this.sync();
      });
    }
    return this.syncing;
  }

  private async drainSyncRequests(generation: number): Promise<void> {
    while (this.syncRequested && this.isCurrentGeneration(generation)) {
      this.syncRequested = false;
      await this.syncOnce(generation);
    }
  }

  private async syncOnce(generation: number): Promise<void> {
    const barrier = ++this.sourceClock;
    const baseline = cloneManifest(this.manifest);
    this.activeSyncs.add(barrier);
    try {
      const remote = await this.http.getManifest(this.httpAbort.signal);
      if (!this.isCurrentGeneration(generation)) return;
      const diff = diffManifest(baseline, remote);
      const fetched =
        this.kind !== "sparse" && diff.put.length
          ? await this.http.getBodies(
              diff.put.map((path) => ({
                path,
                hash: remote.entries[path]?.hash ?? "",
              })),
              this.httpAbort.signal,
            )
          : [];
      if (!this.isCurrentGeneration(generation)) return;
      await this.commitFullSync(
        barrier,
        generation,
        baseline,
        remote,
        new Map(fetched),
      );
    } catch (error) {
      // A size mismatch is an integrity failure at the current source, not a
      // partial cache update. Keep the caller-visible rejection and arrange one
      // bounded-backoff authoritative retry; repeated bad responses coalesce.
      if (error instanceof BodySizeMismatchError) this.requestRepair();
      throw error;
    } finally {
      this.activeSyncs.delete(barrier);
      for (const path of this.paths.keys()) this.prunePath(path);
    }
  }

  private async commitFullSync(
    barrier: number,
    generation: number,
    baseline: SyncManifest,
    remote: SyncManifest,
    bodies: Map<string, Uint8Array>,
  ): Promise<void> {
    await this.enqueueCommit(async () => {
      if (!this.isCurrentGeneration(generation)) return;
      const before = cloneManifest(this.manifest);
      const next = cloneManifest(before);
      const puts: Array<[string, Uint8Array]> = [];
      const deletes: string[] = [];
      const applied = new Set<string>();
      let partial = false;
      let skipped = false;

      const allPaths = new Set([
        ...Object.keys(before.entries),
        ...Object.keys(remote.entries),
        ...this.paths.keys(),
        ...this.localByPath.keys(),
      ]);

      for (const path of allPaths) {
        const local = this.localByPath.get(path);
        const state = this.paths.get(path);
        if (local || (state && state.latest > barrier)) {
          partial = true;
          continue;
        }

        const previous = before.entries[path];
        const replacement = remote.entries[path];
        if (replacement) {
          if (previous?.hash !== replacement.hash) {
            if (this.kind === "sparse") {
              if (previous) deletes.push(path);
            } else {
              const body = bodies.get(path);
              if (!body) {
                if (baseline.entries[path]?.hash !== replacement.hash) {
                  throw new Error(`snapshot omitted body for ${path}`);
                }
                // The path changed after the baseline and the first pass did not
                // fetch its now-required body. One follow-up snapshot is enough.
                skipped = true;
                this.syncRequested = true;
                continue;
              }
              // Validate only after this source wins the path CAS. A malformed
              // response which a newer local/realtime source superseded is
              // stale data, not permission to disturb that newer source.
              validateBodySize(path, body, replacement.size, "full sync");
              puts.push([path, body]);
            }
          }
          next.entries[path] = { ...replacement };
        } else {
          delete next.entries[path];
          if (previous) deletes.push(path);
        }
        applied.add(path);
      }

      next.version =
        !partial && !skipped
          ? remote.version
          : Math.max(before.version, remote.version);
      const persisted = await this.store.apply({
        puts,
        deletes,
        manifest: next,
        manifestPaths: [...applied],
        ...(!partial && !skipped ? { resetVersionFrom: before.version } : {}),
      });
      if (!this.isCurrentGeneration(generation)) return;
      this.manifest = persisted ? cloneManifest(persisted) : next;

      // Advance the floor only for paths this snapshot actually published.
      // Older in-flight responses then fail their path CAS; newer ones retain it.
      for (const path of applied) {
        const state = this.paths.get(path);
        if (state && state.latest <= barrier) state.latest = barrier;
      }

      const changed = diffManifest(before, this.manifest);
      if (this.kind !== "sparse") {
        for (const path of changed.put) {
          const entry = this.manifest.entries[path];
          this.onChange?.({
            op: "put",
            path,
            hash: entry?.hash,
            size: entry?.size,
            version: this.manifest.version,
            origin: "remote",
          });
        }
      }
      for (const path of changed.del) {
        this.onChange?.({
          op: "del",
          path,
          version: this.manifest.version,
          origin: "remote",
        });
      }
    });
  }

  private async onMessage(message: ServerMsg, generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    if (message.t === "manifest") {
      await this.sync();
      return;
    }
    if (message.t === "synced") {
      if (message.version !== this.manifest.version) await this.sync();
      return;
    }
    if (message.t === "registry") {
      // Room-level frame; our entry (or its absence) is the verdict for the
      // open-time watch. Outside the watch it is ignored — steady-state
      // freshness rides change/synced/manifest frames, and reacting to every
      // registry frame would race the async application of the change that
      // triggered it.
      this.registryEntry = message.libs?.[this.namespace] ?? null;
      if (this.registryWatch) {
        if (this.registryWatch.timer !== null) clearTimeout(this.registryWatch.timer);
        this.registryWatch = null;
        await this.settleRegistryVerdict();
      }
      return;
    }

    const id = message.mutationId;
    if (id) {
      const mutation = this.activeMutations.get(id);
      if (
        mutation &&
        mutation.path === message.path &&
        mutation.op === message.op
      ) {
        if (!mutation.echo) {
          mutation.echo = message;
          mutation.echoLatch.resolve(message);
        } else if (!sameReceipt(mutation.echo, message)) {
          // Mutation ids are opaque correlation tokens, not writer identity.
          // A peer can learn one from the first broadcast and reuse it on a
          // later write. Never let that later write disappear as a self echo.
          mutation.collided = true;
        }
        return;
      }
      const completed = this.completedMutations.get(id);
      if (
        completed &&
        completed.path === message.path &&
        sameReceipt(completed, message)
      ) {
        return;
      }
    }
    await this.enqueueRemoteChange(message, generation);
  }

  private enqueueRemoteChange(
    change: SyncChange,
    generation: number,
  ): Promise<void> {
    const existing = this.remotePaths.get(change.path);
    if (!existing && this.remotePaths.size >= MAX_REMOTE_PATHS) {
      this.requestRepair();
      return Promise.resolve();
    }

    const sequence = this.beginPathSource(change.path);
    const pending = { change, generation, sequence };
    if (existing) {
      if (existing.latest) {
        this.endPathSource(change.path, existing.latest.sequence);
      }
      existing.latest = pending;
      return existing.promise;
    }

    const drain: RemotePathDrain = {
      latest: pending,
      promise: Promise.resolve(),
    };
    this.remotePaths.set(change.path, drain);
    drain.promise = this.drainRemotePath(change.path, drain);
    return drain.promise;
  }

  private async drainRemotePath(
    path: string,
    drain: RemotePathDrain,
  ): Promise<void> {
    try {
      while (drain.latest) {
        const pending = drain.latest;
        drain.latest = undefined;
        await this.applyRemoteChange(
          pending.change,
          pending.generation,
          pending.sequence,
        );
      }
    } finally {
      if (this.remotePaths.get(path) === drain) this.remotePaths.delete(path);
    }
  }

  private async applyRemoteChange(
    change: SyncChange,
    generation: number,
    sequence: number,
  ): Promise<void> {
    try {
      const local = this.localByPath.get(change.path);
      if (local) {
        // The path GET cannot be paired safely with this event while a local
        // request can change the same server path. Reconcile once at its tail.
        local.collided = true;
        return;
      }

      if (change.op === "put") {
        if (this.manifest.entries[change.path]?.hash === change.hash) {
          await this.commitVersion(change.path, sequence, change.version, generation);
          return;
        }
        const fetched = await this.http.getBodies(
          [{ path: change.path, hash: change.hash ?? "" }],
          this.httpAbort.signal,
        );
        const body = fetched.find(([path]) => path === change.path)?.[1];
        if (!body) throw new Error(`missing body for ${change.path}`);
        await this.enqueueCommit(async () => {
          if (!this.pathIsCurrent(change.path, sequence, generation)) return;
          const size = validateBodySize(
            change.path,
            body,
            change.size,
            "realtime change",
          );
          const next = cloneManifest(this.manifest);
          next.entries[change.path] = {
            hash: change.hash ?? "",
            size,
            mtime: Date.now(),
          };
          next.version = Math.max(next.version, change.version);
          const persisted = await this.store.apply({
            puts: [[change.path, body]],
            manifest: next,
            manifestPaths: [change.path],
          });
          if (!this.isCurrentGeneration(generation)) return;
          this.manifest = persisted ? cloneManifest(persisted) : next;
          this.onChange?.({ ...change, origin: "remote" });
        });
      } else if (!this.manifest.entries[change.path]) {
        await this.commitVersion(change.path, sequence, change.version, generation);
      } else {
        // A change frame has no server epoch/revision precondition. A delayed
        // DELETE from an older room lifetime can therefore have a numerically
        // newer version than a replacement value. Treat it as an invalidation,
        // and let a fresh authoritative manifest decide whether bytes exist.
        // If reconciliation fails, retaining the current value is the only safe
        // choice; the bounded repair loop will try again.
        try {
          await this.sync();
        } catch {
          this.requestRepair();
        }
      }
    } catch {
      if (this.pathIsCurrent(change.path, sequence, generation)) {
        try {
          await this.sync();
        } catch {
          this.requestRepair();
        }
      }
    } finally {
      this.endPathSource(change.path, sequence);
    }
  }

  private requestRepair(): void {
    if (this.closed) return;
    this.repairRequested = true;
    this.scheduleRepair();
  }

  private scheduleRepair(): void {
    if (
      this.closed ||
      !this.repairRequested ||
      this.repairTimer !== undefined ||
      this.repairRunning
    ) {
      return;
    }
    const delay = this.repairDelayMs;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = undefined;
      if (this.closed) return;
      this.repairRunning = true;
      this.repairRequested = false;
      void this.sync()
        .then(() => {
          this.repairDelayMs = INITIAL_REPAIR_DELAY_MS;
        })
        .then(() => {
          if (this.channelReady && this.channel) {
            this.sendHello(this.channel, this.lifecycleGeneration);
          }
        })
        .catch(() => {
          this.repairDelayMs = Math.min(
            this.repairDelayMs * 2,
            MAX_REPAIR_DELAY_MS,
          );
          this.repairRequested = true;
        })
        .finally(() => {
          this.repairRunning = false;
          this.scheduleRepair();
        });
    }, delay);
  }

  private async commitVersion(
    path: string,
    sequence: number,
    version: number,
    generation: number,
  ): Promise<void> {
    await this.enqueueCommit(async () => {
      if (!this.pathIsCurrent(path, sequence, generation)) return;
      if (version <= this.manifest.version) return;
      const next = cloneManifest(this.manifest);
      next.version = version;
      const persisted = await this.store.apply({
        manifest: next,
        manifestPaths: [],
      });
      if (this.isCurrentGeneration(generation)) {
        this.manifest = persisted ? cloneManifest(persisted) : next;
      }
    });
  }

  async push(path: string, body: Uint8Array): Promise<void> {
    if (!this.writable) throw new Error(`layer ${this.namespace} is not writable`);
    if (this.closed) throw new Error(`layer ${this.namespace} is closed`);
    await this.enqueueLocal(path, "put", body);
  }

  async delete(path: string): Promise<void> {
    if (!this.writable) throw new Error(`layer ${this.namespace} is not writable`);
    if (this.closed) throw new Error(`layer ${this.namespace} is closed`);
    await this.enqueueLocal(path, "del");
  }

  private enqueueLocal(
    path: string,
    op: "put" | "del",
    body?: Uint8Array,
  ): Promise<void> {
    let lane = this.localPathLanes.get(path);
    const pathCount = lane ? lane.queue.length + (lane.running ? 1 : 0) : 0;
    const retainedBodyBytes = op === "put" ? body?.byteLength ?? 0 : 0;
    if (pathCount >= this.mutationQueueLimits.maxPerPath) {
      return Promise.reject(
        new SyncMutationQueueFullError(this.namespace, path, "path-mutations"),
      );
    }
    if (this.localMutationCount >= this.mutationQueueLimits.maxPerLayer) {
      return Promise.reject(
        new SyncMutationQueueFullError(this.namespace, path, "layer-mutations"),
      );
    }
    if (
      retainedBodyBytes >
      this.mutationQueueLimits.maxRetainedBodyBytes - this.localMutationBodyBytes
    ) {
      return Promise.reject(
        new SyncMutationQueueFullError(
          this.namespace,
          path,
          "retained-body-bytes",
        ),
      );
    }

    const mutation: LocalMutation = {
      id: randomId(),
      path,
      op,
      body: body?.slice(),
      generation: this.lifecycleGeneration,
      sequence: 0,
      collided: false,
      echoLatch: createMutationEchoLatch(),
    };
    lane ??= { running: false, queue: [] };
    this.localPathLanes.set(path, lane);
    const result = new Promise<void>((resolve, reject) => {
      lane.queue.push({ mutation, retainedBodyBytes, resolve, reject });
    });
    this.localMutationCount++;
    this.localMutationBodyBytes += retainedBodyBytes;
    this.drainLocalPath(path, lane);
    return result;
  }

  private drainLocalPath(path: string, lane: LocalMutationLane): void {
    if (lane.running) return;
    const job = lane.queue.shift();
    if (!job) {
      if (this.localPathLanes.get(path) === lane) this.localPathLanes.delete(path);
      return;
    }
    lane.running = true;
    void this.runLocalMutation(path, lane, job);
  }

  private async runLocalMutation(
    path: string,
    lane: LocalMutationLane,
    job: LocalMutationJob,
  ): Promise<void> {
    try {
      await this.executeLocal(job.mutation);
      job.resolve();
    } catch (error) {
      job.reject(error);
    } finally {
      this.localMutationCount--;
      this.localMutationBodyBytes -= job.retainedBodyBytes;
      lane.running = false;
      if (this.localPathLanes.get(path) === lane) this.drainLocalPath(path, lane);
    }
  }

  private async executeLocal(mutation: LocalMutation): Promise<void> {
    if (!this.isCurrentGeneration(mutation.generation)) {
      throw new Error(`layer ${this.namespace} is closed`);
    }
    mutation.sequence = this.beginPathSource(mutation.path);
    this.localByPath.set(mutation.path, mutation);
    this.activeMutations.set(mutation.id, mutation);
    this.optimistic.set(
      mutation.path,
      mutation.op === "put" ? mutation.body ?? new Uint8Array() : null,
    );

    let failure: unknown;
    let receipt: LocalReceipt | undefined;
    let receiptFromEcho = false;
    // A malformed PUT receipt proves neither that the submitted bytes nor that
    // its advertised metadata are safe to publish. Preserve the receipt only as
    // echo/reconciliation evidence, and suppress the local cache/event commit.
    let receiptBodySizeValid = true;
    try {
      try {
        if (mutation.op === "put") {
          const body = mutation.body;
          if (!body) throw new Error(`missing body for ${mutation.path}`);
          const result = await this.waitForMutationReceipt(
            mutation,
            (signal) =>
              this.http.putBody(mutation.path, body, mutation.id, signal),
          );
          receipt = {
            op: "put",
            version: result.version,
            hash: result.hash,
            size: result.size,
          };
          try {
            validateBodySize(
              mutation.path,
              body,
              result.size,
              "local PUT receipt",
            );
          } catch (error) {
            if (!(error instanceof BodySizeMismatchError)) throw error;
            receiptBodySizeValid = false;
            mutation.collided = true;
          }
        } else {
          // Precondition: the hash this client believes it is deleting (its
          // current manifest view — the local lane is serial per path, so a
          // queued delete sees its predecessors' committed receipts). The
          // server refuses a mismatch (412 → generic failure → authoritative
          // sync below) instead of erasing a body this client never saw. An
          // absent entry sends no precondition — legacy unconditional delete.
          const expectedHash = this.manifest.entries[mutation.path]?.hash;
          const result = await this.waitForMutationReceipt(
            mutation,
            (signal) =>
              this.http.deleteBody(
                mutation.path,
                mutation.id,
                signal,
                expectedHash,
              ),
          );
          receipt = { op: "del", version: result.version };
        }
      } catch (error) {
        const echo =
          error instanceof MutationEchoReceiptError
            ? error.echo
            : mutation.echo;
        if (echo?.path === mutation.path && echo.op === mutation.op) {
          receipt = {
            op: echo.op,
            version: echo.version,
            hash: echo.hash,
            size: echo.size,
          };
          // The HTTP outcome is uncertain and the backend fingerprint is
          // opaque, so the echo cannot prove that its bytes are our submitted
          // bytes. Treat it as durable-success evidence, then bind the cache to
          // a fresh authoritative snapshot instead of publishing local bytes
          // under an unverified hash.
          mutation.collided = true;
          receiptFromEcho = true;
        } else {
          failure = error;
        }
      }

      if (!this.isCurrentGeneration(mutation.generation)) {
        failure = new Error(`layer ${this.namespace} is closed`);
        receipt = undefined;
      }

      if (receipt && mutation.echo && !sameReceipt(receipt, mutation.echo)) {
        // This covers a reconnect where the genuine echo was missed and the
        // first frame observed under our disclosed id belongs to a later peer
        // write. The authoritative snapshot below decides which write won.
        mutation.collided = true;
      }

      if (receipt && receiptBodySizeValid && !mutation.collided) {
        await this.commitLocalReceipt(mutation, receipt);
      }
      if (
        receipt &&
        receiptBodySizeValid &&
        !receiptFromEcho &&
        this.isCurrentGeneration(mutation.generation)
      ) {
        this.onChange?.(
          receipt.op === "put"
            ? {
                op: "put",
                path: mutation.path,
                hash: receipt.hash,
                size: receipt.size,
                version: receipt.version,
                mutationId: mutation.id,
                origin: "local",
              }
            : {
                op: "del",
                path: mutation.path,
                version: receipt.version,
                mutationId: mutation.id,
                origin: "local",
              },
        );
      }
    } catch (error) {
      if (failure === undefined) failure = error;
    } finally {
      if (receipt && failure === undefined) {
        this.rememberCompletedMutation(mutation.id, mutation.path, receipt);
      }
      this.activeMutations.delete(mutation.id);
      if (this.localByPath.get(mutation.path) === mutation) {
        this.localByPath.delete(mutation.path);
      }
      this.endPathSource(mutation.path, mutation.sequence);
    }

    try {
      if (
        this.isCurrentGeneration(mutation.generation) &&
        (mutation.collided || failure !== undefined)
      ) {
        try {
          await this.sync();
        } catch {
          this.requestRepair();
        }
      }
    } finally {
      this.optimistic.delete(mutation.path);
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * Race one HTTP receipt against the mutation's exact websocket echo and a
   * finite deadline. The echo is a durable-success completion edge, but not
   * permission to bind local bytes to an opaque server hash; the caller catches
   * its typed outcome and reconciles. The controller belongs only to this
   * request, so aborting it cannot cancel independent path traffic. Layer close
   * is relayed into it so even an injected transport that ignores AbortSignal
   * cannot retain the FIFO forever.
   */
  private async waitForMutationReceipt<T>(
    mutation: LocalMutation,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const layerSignal = this.httpAbort.signal;
    const relayClose = () => {
      controller.abort(
        layerSignal.reason ?? new Error(`layer ${this.namespace} is closed`),
      );
    };
    if (layerSignal.aborted) relayClose();
    else layerSignal.addEventListener("abort", relayClose, { once: true });

    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const rejectFromAbort = () => {
      rejectAbort(
        controller.signal.reason ??
          new Error(`mutation request aborted for ${mutation.path}`),
      );
    };
    if (controller.signal.aborted) rejectFromAbort();
    else controller.signal.addEventListener("abort", rejectFromAbort, {
      once: true,
    });

    const deadline = setTimeout(() => {
      controller.abort(
        new MutationReceiptDeadlineError(
          this.namespace,
          mutation.path,
          this.mutationReceiptDeadlineMs,
        ),
      );
    }, this.mutationReceiptDeadlineMs);

    // Attach all handlers before racing. An injected transport may ignore abort
    // and settle much later; Promise.race retains a rejection handler for that
    // detached result after the path lane has moved on.
    const http = Promise.resolve().then(() => request(controller.signal));
    const echo = mutation.echoLatch.promise.then((received) => {
      throw new MutationEchoReceiptError(received);
    });

    try {
      return await Promise.race([http, echo, aborted]);
    } catch (error) {
      if (error instanceof MutationEchoReceiptError) {
        controller.abort(error);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      layerSignal.removeEventListener("abort", relayClose);
      controller.signal.removeEventListener("abort", rejectFromAbort);
    }
  }

  private rememberCompletedMutation(
    id: string,
    path: string,
    receipt: LocalReceipt,
  ): void {
    this.completedMutations.set(id, { path, ...receipt });
    if (this.completedMutations.size <= MAX_COMPLETED_MUTATION_IDS) return;
    const oldest = this.completedMutations.keys().next().value as string | undefined;
    if (oldest) this.completedMutations.delete(oldest);
  }

  private async commitLocalReceipt(
    mutation: LocalMutation,
    receipt: LocalReceipt,
  ): Promise<void> {
    await this.enqueueCommit(async () => {
      if (
        !this.pathIsCurrent(
          mutation.path,
          mutation.sequence,
          mutation.generation,
        )
      ) {
        return;
      }
      const next = cloneManifest(this.manifest);
      const puts: Array<[string, Uint8Array]> = [];
      const deletes: string[] = [];
      if (receipt.op === "put") {
        const body = mutation.body;
        if (!body) throw new Error(`missing body for ${mutation.path}`);
        next.entries[mutation.path] = {
          hash: receipt.hash ?? "",
          size: receipt.size ?? body.length,
          mtime: Date.now(),
        };
        puts.push([mutation.path, body]);
      } else {
        delete next.entries[mutation.path];
        deletes.push(mutation.path);
      }
      next.version = Math.max(next.version, receipt.version);
      const persisted = await this.store.apply({
        puts,
        deletes,
        manifest: next,
        manifestPaths: [mutation.path],
      });
      if (this.isCurrentGeneration(mutation.generation)) {
        this.manifest = persisted ? cloneManifest(persisted) : next;
      }
    });
  }

  private enqueueCommit<T>(commit: () => Promise<T>): Promise<T> {
    const result = this.commitTail.then(commit, commit);
    this.commitTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private beginPathSource(path: string): number {
    const sequence = ++this.sourceClock;
    let state = this.paths.get(path);
    if (!state) {
      state = { latest: sequence, active: new Set() };
      this.paths.set(path, state);
    }
    state.latest = sequence;
    state.active.add(sequence);
    return sequence;
  }

  private endPathSource(path: string, sequence: number): void {
    const state = this.paths.get(path);
    state?.active.delete(sequence);
    this.prunePath(path);
  }

  private prunePath(path: string): void {
    const state = this.paths.get(path);
    if (!state || state.active.size > 0) return;
    for (const barrier of this.activeSyncs) {
      if (barrier < state.latest) return;
    }
    this.paths.delete(path);
  }

  private pathIsCurrent(
    path: string,
    sequence: number,
    generation: number,
  ): boolean {
    return (
      this.isCurrentGeneration(generation) &&
      this.paths.get(path)?.latest === sequence
    );
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.closed && generation === this.lifecycleGeneration;
  }

  hasPath(path: string): boolean {
    if (this.optimistic.has(path)) return this.optimistic.get(path) !== null;
    return this.manifest.entries[path] !== undefined;
  }

  entries(): Record<string, SyncEntry> {
    if (this.optimistic.size === 0) return this.manifest.entries;
    const entries = { ...this.manifest.entries };
    for (const [path, body] of this.optimistic) {
      if (body) {
        entries[path] = { hash: "", size: body.length, mtime: Date.now() };
      } else {
        delete entries[path];
      }
    }
    return entries;
  }

  version(): number {
    return this.manifest.version;
  }

  getBody(path: string): Promise<Uint8Array | null> {
    if (this.optimistic.has(path)) {
      return Promise.resolve(this.optimistic.get(path)?.slice() ?? null);
    }
    if (this.kind !== "sparse") return this.store.getBody(path);
    return this.sparseRead(path);
  }

  private async sparseRead(path: string): Promise<Uint8Array | null> {
    const generation = this.lifecycleGeneration;
    const cached = await this.store.getBody(path);
    if (!this.isCurrentGeneration(generation)) return null;
    if (cached) return cached;
    const entry = this.manifest.entries[path];
    if (!entry) return null;

    const existing = this.sparseInflight.get(path);
    if (existing?.hash === entry.hash && existing.generation === generation) {
      return existing.promise;
    }
    const promise = this.fetchSparseBody(path, { ...entry }, generation);
    const request = { hash: entry.hash, generation, promise };
    this.sparseInflight.set(path, request);
    void promise.finally(() => {
      if (this.sparseInflight.get(path) === request) {
        this.sparseInflight.delete(path);
      }
    });
    return promise;
  }

  private async fetchSparseBody(
    path: string,
    entry: SyncEntry,
    generation: number,
  ): Promise<Uint8Array | null> {
    try {
      let body: Uint8Array;
      if (this.bodyUrlTemplate) {
        const url = this.bodyUrlTemplate
          .replace("{hash}", entry.hash)
          .replace("{path}", encodeURIComponent(path));
        body = await this.http.getBodyFromUrl(url, this.httpAbort.signal);
      } else {
        const fetched = await this.http.getBodies(
          [{ path, hash: entry.hash }],
          this.httpAbort.signal,
        );
        const found = fetched.find(([candidate]) => candidate === path);
        if (!found) return null;
        body = found[1];
      }
      let accepted = false;
      await this.enqueueCommit(async () => {
        if (
          !this.isCurrentGeneration(generation) ||
          this.manifest.entries[path]?.hash !== entry.hash
        ) {
          return;
        }
        validateBodySize(path, body, entry.size, "sparse read");
        const persisted = await this.store.apply({
          puts: [[path, body]],
          manifest: cloneManifest(this.manifest),
          manifestPaths: [],
          expectedManifestEntries: [{ path, hash: entry.hash }],
        });
        if (!this.isCurrentGeneration(generation)) return;
        if (!persisted) {
          // Another lifetime changed this path in the shared store while the
          // body request was in flight. The CAS correctly rejected our bytes;
          // also adopt that winner so this same lifetime does not keep asking
          // for the stale hash on every subsequent read. getManifest() runs
          // after the rejected store-lane operation and may safely observe an
          // even newer publisher.
          const current = await this.store.getManifest();
          if (!this.isCurrentGeneration(generation)) return;
          this.manifest = current ? cloneManifest(current) : emptyManifest();
          if (!current) this.requestRepair();
          return;
        }
        this.manifest = cloneManifest(persisted);
        accepted = this.manifest.entries[path]?.hash === entry.hash;
      });
      return accepted ? body : null;
    } catch (error) {
      if (error instanceof BodySizeMismatchError) this.requestRepair();
      return null;
    }
  }

  async readAll(): Promise<Map<string, Uint8Array>> {
    const all = await this.store.getAllBodies();
    const out = new Map<string, Uint8Array>();
    for (const path of Object.keys(this.manifest.entries)) {
      const body = all.get(path);
      if (body) out.set(path, body.slice());
    }
    for (const [path, body] of this.optimistic) {
      if (body) out.set(path, body.slice());
      else out.delete(path);
    }
    return out;
  }

  close(): void {
    if (this.closed) return;
    const closed = new Error(`layer ${this.namespace} is closed`);
    this.closed = true;
    this.lifecycleGeneration++;
    this.httpAbort.abort(closed);
    this.openComplete = false;
    this.channelReady = false;
    if (this.registryWatch) {
      if (this.registryWatch.timer !== null) clearTimeout(this.registryWatch.timer);
      this.registryWatch = null;
    }
    this.syncRequested = false;
    this.repairRequested = false;
    this.optimistic.clear();
    this.sparseInflight.clear();
    this.activeMutations.clear();
    this.completedMutations.clear();
    this.channelRefresh = null;
    this.remotePaths.clear();
    this.localByPath.clear();
    for (const lane of this.localPathLanes.values()) {
      for (const job of lane.queue.splice(0)) {
        this.localMutationCount--;
        this.localMutationBodyBytes -= job.retainedBodyBytes;
        job.reject(closed);
      }
    }
    // Active jobs retain their lane object until their finally block balances
    // the last counters. Removing the map prevents any post-close drain.
    this.localPathLanes.clear();
    this.paths.clear();
    this.activeSyncs.clear();
    if (this.repairTimer !== undefined) clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
    this.channel?.close();
    this.channel = undefined;
    this.releaseStore?.();
  }
}
