import {
  encodeBundle,
  encodeFrames,
  manifestDigest,
  sha256Hex,
  SYNC_ACTION_HEADER,
  SYNC_ACTION_RELOAD,
  type ClientMsg,
  type ServerMsg,
  type SyncChange,
  type SyncManifest,
} from "@pcbjam/shared";
import {
  MUTATION_ID_HEADER,
  type ChannelFactory,
  type RealtimeChannel,
} from "../src/transport.js";

/**
 * One in-memory namespace, reachable both as an HTTP origin (routed `fetch`) and
 * as a realtime channel — so the tests exercise the REAL `httpLayer`
 * encode/decode path plus broadcast, with no network/IndexedDB.
 */
export class FakeServer {
  manifest: SyncManifest = { version: 0, entries: {} };
  readonly bodies = new Map<string, Uint8Array>();
  readonly channels = new Set<FakeChannel>();
  /** Per-body fetches via POST /bodies or GET /body — i.e. NON-bundle reads. */
  bodyFetches = 0;
  bundleFetches = 0;
  manifestFetches = 0;
  putCount = 0;
  /** Content-addressed GET /blob/<hash> fetches (sparse bodyUrlTemplate path). */
  blobFetches = 0;
  /** Cutover mode: every write answers 409 + x-pcbjam-sync-action: reload. */
  refuseWritesMoved = false;
  /**
   * Registry-bearing room (load-path-rework 0002): namespaces whose digest the
   * room affirms on connect via a `registry` frame. `sendRegistryOnConnect(ns)`
   * arms it; the frame is delivered on the next task so the stack's handlers
   * are wired first — same delayed delivery as `broadcast`.
   */
  private registryNamespaces: string[] | null = null;

  /** Seed an item with no change broadcast (initial server state). */
  async seed(path: string, body: Uint8Array): Promise<void> {
    const hash = await sha256Hex(body);
    this.bodies.set(path, body);
    this.manifest.version += 1;
    this.manifest.entries[path] = { hash, size: body.length, mtime: 0 };
  }

  async route(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const p = u.pathname;
    if (req.method === "GET" && p === "/manifest") {
      this.manifestFetches += 1;
      return json(this.snapshot());
    }
    if (req.method === "GET" && p === "/bundle") {
      this.bundleFetches += 1;
      return bin(encodeBundle(this.snapshot(), [...this.bodies.entries()]));
    }
    if (req.method === "POST" && p === "/bodies") {
      const { entries } = (await req.json()) as {
        entries: Array<{ path: string; hash: string }>;
      };
      this.bodyFetches += entries.length;
      return bin(
        encodeFrames(
          entries.flatMap(({ path, hash }) =>
            this.manifest.entries[path]?.hash === hash && this.bodies.has(path)
              ? [[path, this.bodies.get(path)!] as [string, Uint8Array]]
              : [],
          ),
        ),
      );
    }
    if (req.method === "GET" && p.startsWith("/blob/")) {
      // Content-addressed body lookup (the sparse layer's bodyUrlTemplate).
      const hash = p.slice("/blob/".length);
      this.blobFetches += 1;
      for (const [path, e] of Object.entries(this.manifest.entries)) {
        if (e.hash === hash) return bin(this.bodies.get(path)!);
      }
      return new Response(null, { status: 404 });
    }
    if (p.startsWith("/body/")) {
      const path = decodeURIComponent(p.slice("/body/".length));
      if (req.method === "GET") {
        this.bodyFetches += 1;
        const b = this.bodies.get(path);
        return b ? bin(b) : new Response(null, { status: 404 });
      }
      if (req.method === "PUT" || req.method === "DELETE") {
        if (this.refuseWritesMoved) {
          return new Response(JSON.stringify({ message: "room moved" }), {
            status: 409,
            headers: { [SYNC_ACTION_HEADER]: SYNC_ACTION_RELOAD },
          });
        }
      }
      if (req.method === "PUT") {
        const body = new Uint8Array(await req.arrayBuffer());
        return json(
          await this.put(path, body, req.headers.get(MUTATION_ID_HEADER) ?? undefined),
        );
      }
      if (req.method === "DELETE") {
        return json(this.del(path, req.headers.get(MUTATION_ID_HEADER) ?? undefined));
      }
    }
    return new Response(null, { status: 404 });
  }

  async put(
    path: string,
    body: Uint8Array,
    mutationId?: string,
  ): Promise<{ version: number; hash: string; size: number }> {
    const hash = await sha256Hex(body);
    this.bodies.set(path, body);
    this.manifest.version += 1;
    this.manifest.entries[path] = { hash, size: body.length, mtime: 0 };
    this.putCount += 1;
    this.broadcast({
      op: "put",
      path,
      hash,
      size: body.length,
      version: this.manifest.version,
      mutationId,
    });
    return { version: this.manifest.version, hash, size: body.length };
  }

  /** Change a body but KEEP the manifest version + skip the broadcast — models a
   *  static origin whose per-entry hash changed (e.g. a re-mirror) without a
   *  version bump. The client must still pick it up on `sync()` via the hash diff. */
  async revise(path: string, body: Uint8Array): Promise<void> {
    const hash = await sha256Hex(body);
    this.bodies.set(path, body);
    this.manifest.entries[path] = { hash, size: body.length, mtime: 0 };
  }

  del(path: string, mutationId?: string): { version: number } {
    this.bodies.delete(path);
    delete this.manifest.entries[path];
    this.manifest.version += 1;
    this.broadcast({ op: "del", path, version: this.manifest.version, mutationId });
    return { version: this.manifest.version };
  }

  /**
   * Model the real transport's connect sequence: the socket's `open` event
   * fires first (a REAL first connect always lands after the stack finished
   * `open()` — the page-load-burst regression hid exactly there), then the
   * room's per-connection registry frame. Off by default so legacy tests keep
   * their never-opened initial channels.
   */
  realisticOpen = false;

  connect(): FakeChannel {
    const ch = new FakeChannel(this);
    this.channels.add(ch);
    if (this.realisticOpen || this.registryNamespaces) {
      setTimeout(() => {
        if (this.realisticOpen) ch._open();
        this.trackRegistry(this.deliverRegistry(ch));
      }, 0);
    }
    return ch;
  }

  /**
   * Await every in-flight registry delivery (the async digest makes them span
   * tasks). A REAL socket's frames cannot cross a reconnect boundary — tests
   * that reconnect must flush first, or a late connect-time frame can settle a
   * post-reconnect watch and turn the test into a coin flip.
   */
  async registryFlushed(): Promise<void> {
    do {
      // Leading task flush: connect()/fireReconnect() only ENQUEUE their
      // delivery on the next task, so the pending list may still be empty.
      await new Promise((r) => setTimeout(r, 0));
      await Promise.all(this.pendingRegistry.splice(0));
      await new Promise((r) => setTimeout(r, 0)); // let the frames dispatch
    } while (this.pendingRegistry.length);
  }

  private readonly pendingRegistry: Promise<void>[] = [];
  private trackRegistry(p: Promise<void>): void {
    this.pendingRegistry.push(p);
  }

  /** Arm the room to send a `registry` frame (for `namespaces`) on connect;
   *  zero namespaces disarms it (a room that has gone silent). */
  sendRegistryOnConnect(...namespaces: string[]): void {
    this.registryNamespaces = namespaces.length ? namespaces : null;
  }

  private async deliverRegistry(ch: FakeChannel): Promise<void> {
    // Capture before the await: a test may disarm the registry mid-delivery.
    const namespaces = this.registryNamespaces;
    if (!namespaces) return;
    const digest = await manifestDigest(this.manifest);
    const libs = Object.fromEntries(
      namespaces.map((ns) => [ns, { v: this.manifest.version, digest }]),
    );
    ch._deliver({ t: "registry", libs });
  }

  /** Simulate a transport reconnect: fire onOpen on every live channel, then
   *  re-send the registry frame (the real room's onConnect runs per connect). */
  fireReconnect(): void {
    for (const ch of this.channels) {
      ch._open();
      setTimeout(() => this.trackRegistry(this.deliverRegistry(ch)), 0);
    }
  }

  replyHello(ch: FakeChannel): void {
    ch._deliver({ t: "synced", version: this.manifest.version });
  }

  private broadcast(c: SyncChange): void {
    const msg: ServerMsg = { t: "change", ...c };
    // A browser cannot synchronously re-enter websocket handlers from inside a
    // fetch implementation. Deliver on the next task so HTTP and websocket race
    // with realistic transport ordering while remaining deterministic.
    for (const ch of this.channels) setTimeout(() => ch._deliver(msg), 0);
  }

  private snapshot(): SyncManifest {
    return {
      version: this.manifest.version,
      entries: Object.fromEntries(
        Object.entries(this.manifest.entries).map(([k, v]) => [k, { ...v }]),
      ),
    };
  }
}

export class FakeChannel implements RealtimeChannel {
  private openCbs: Array<() => void> = [];
  private msgCbs: Array<(m: ServerMsg) => void> = [];
  private closed = false;
  constructor(private readonly server: FakeServer) {}
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onMessage(cb: (m: ServerMsg) => void): void {
    this.msgCbs.push(cb);
  }
  send(msg: ClientMsg): void {
    if (!this.closed && msg.t === "hello") this.server.replyHello(this);
  }
  close(): void {
    this.closed = true;
    this.server.channels.delete(this);
  }
  _open(): void {
    if (!this.closed) for (const cb of this.openCbs) cb();
  }
  _deliver(m: ServerMsg): void {
    if (!this.closed) for (const cb of this.msgCbs) cb(m);
  }
}

/**
 * A registry of fake servers keyed by URL host, exposing a `fetch` dispatcher and
 * a `channelFactory` so a `SyncStack`'s layers (each with a distinct `url`) route
 * to the matching server.
 */
export class FakeCloud {
  private readonly servers = new Map<string, FakeServer>();

  server(url: string): FakeServer {
    const host = new URL(url).host;
    let s = this.servers.get(host);
    if (!s) {
      s = new FakeServer();
      this.servers.set(host, s);
    }
    return s;
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    return this.server(req.url).route(req);
  };

  channelFactory: ChannelFactory = ({ url }) => this.server(url).connect();
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json" },
  });
}

function bin(bytes: Uint8Array): Response {
  return new Response(bytes as BodyInit);
}

/** Let queued microtasks + timers settle (fake broadcasts apply asynchronously). */
export function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
