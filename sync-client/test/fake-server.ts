import {
  encodeBundle,
  encodeFrames,
  sha256Hex,
  type ClientMsg,
  type ServerMsg,
  type SyncChange,
  type SyncManifest,
} from "@pcbjam/shared";
import type { ChannelFactory, RealtimeChannel } from "../src/transport.js";

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
      const { paths } = (await req.json()) as { paths: string[] };
      this.bodyFetches += paths.length;
      return bin(
        encodeFrames(
          paths.map((path) => [path, this.bodies.get(path) ?? new Uint8Array()]),
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
      if (req.method === "PUT") {
        const body = new Uint8Array(await req.arrayBuffer());
        return json(await this.put(path, body));
      }
      if (req.method === "DELETE") return json(this.del(path));
    }
    return new Response(null, { status: 404 });
  }

  async put(
    path: string,
    body: Uint8Array,
  ): Promise<{ version: number; hash: string; size: number }> {
    const hash = await sha256Hex(body);
    this.bodies.set(path, body);
    this.manifest.version += 1;
    this.manifest.entries[path] = { hash, size: body.length, mtime: 0 };
    this.putCount += 1;
    this.broadcast({ op: "put", path, hash, size: body.length, version: this.manifest.version });
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

  del(path: string): { version: number } {
    this.bodies.delete(path);
    delete this.manifest.entries[path];
    this.manifest.version += 1;
    this.broadcast({ op: "del", path, version: this.manifest.version });
    return { version: this.manifest.version };
  }

  connect(): FakeChannel {
    const ch = new FakeChannel(this);
    this.channels.add(ch);
    return ch;
  }

  /** Simulate a transport reconnect: fire onOpen on every live channel. */
  fireReconnect(): void {
    for (const ch of this.channels) ch._open();
  }

  replyHello(ch: FakeChannel): void {
    ch._deliver({ t: "synced", version: this.manifest.version });
  }

  private broadcast(c: SyncChange): void {
    const msg: ServerMsg = { t: "change", ...c };
    for (const ch of this.channels) ch._deliver(msg);
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
