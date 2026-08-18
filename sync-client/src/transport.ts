import {
  decodeBundle,
  decodeFrames,
  SYNC_ACTION_HEADER,
  SYNC_ACTION_RELOAD,
  type ClientMsg,
  type ServerMsg,
  type SyncManifest,
} from "@pcbjam/shared";

/**
 * A mutation was refused because the addressed room is no longer this
 * namespace's writer (409 + `x-pcbjam-sync-action: reload` — the scope-room
 * cutover, load-path-rework 0002 §4). The caller's recovery is: drop the
 * cached stack descriptor, re-resolve, retry the write once against the room
 * the fresh descriptor names.
 */
export class SyncRoomMovedError extends Error {
  constructor(op: string, path: string) {
    super(`${op} ${path}: room no longer accepts writes (re-resolve the stack)`);
    this.name = "SyncRoomMovedError";
  }
}

function roomMoved(r: Response): boolean {
  // Defensive on headers: injected test fetches may answer with bare
  // `{ok, status}` objects that have no headers at all.
  return (
    r.status === 409 &&
    r.headers?.get?.(SYNC_ACTION_HEADER) === SYNC_ACTION_RELOAD
  );
}

/** Server's reply to a write — the authoritative version + content hash. */
export interface PutResult {
  version: number;
  hash: string;
  size: number;
}

/** A body read bound to the manifest entry that authorized it. */
export interface BodyRequest {
  path: string;
  /** Opaque content fingerprint (for live layers this is normally an R2 etag). */
  hash: string;
}

/**
 * The HTTP face of one layer. For a `live` layer this hits the Durable Object;
 * for a `static` layer it hits the immutable CDN/R2 snapshot (read-only — the
 * write methods reject). Injected, so tests run against an in-memory fake.
 */
export interface LayerHttp {
  getManifest(signal?: AbortSignal): Promise<SyncManifest>;
  getBundle(signal?: AbortSignal): Promise<{
    manifest: SyncManifest;
    bodies: Array<[string, Uint8Array]>;
  }>;
  getBodies(
    entries: BodyRequest[],
    signal?: AbortSignal,
  ): Promise<Array<[string, Uint8Array]>>;
  /** One body from an absolute URL — the sparse layer resolves its
   *  `bodyUrlTemplate` (it owns the manifest hashes) and fetches through this. */
  getBodyFromUrl(url: string, signal?: AbortSignal): Promise<Uint8Array>;
  putBody(
    path: string,
    body: Uint8Array,
    mutationId?: string,
    signal?: AbortSignal,
  ): Promise<PutResult>;
  deleteBody(
    path: string,
    mutationId?: string,
    signal?: AbortSignal,
    expectedHash?: string,
  ): Promise<{ version: number }>;
}

export const MUTATION_ID_HEADER = "x-pcbjam-mutation-id";
/**
 * DELETE precondition: the manifest hash the client believes it is deleting.
 * The server refuses (412) when the stored body differs — a delayed/replayed
 * delete cannot erase a newer body. Optional for rolling upgrades.
 */
export const EXPECTED_HASH_HEADER = "x-pcbjam-expected-hash";

/**
 * `fetch`-backed HTTP transport. `mode` picks the body-fetch strategy: a `live`
 * DO serves a batched `POST /bodies`; a `static` CDN can only GET, so bodies are
 * fetched in parallel and writes are rejected.
 */
export function httpLayer(
  base: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
  mode: "live" | "static" | "sparse",
): LayerHttp {
  const authH: Record<string, string> = token
    ? { authorization: `Bearer ${token}` }
    : {};
  const url = (p: string) => `${base}${p}`;
  const bodyUrl = (path: string) => url(`/body/${encodeURIComponent(path)}`);

  const readOnly = (op: string) => async (): Promise<never> => {
    throw new Error(`static layer ${base} is read-only (${op})`);
  };

  return {
    async getManifest(signal) {
      const r = await fetchImpl(url("/manifest"), { headers: authH, signal });
      if (!r.ok) throw new Error(`getManifest ${r.status}`);
      return (await r.json()) as SyncManifest;
    },
    async getBundle(signal) {
      if (mode === "sparse")
        throw new Error(`sparse layer ${base} has no bundle`);
      const r = await fetchImpl(url("/bundle"), { headers: authH, signal });
      if (!r.ok) throw new Error(`getBundle ${r.status}`);
      return decodeBundle(new Uint8Array(await r.arrayBuffer()));
    },
    async getBodyFromUrl(u, signal) {
      const r = await fetchImpl(u, { headers: authH, signal });
      if (!r.ok) throw new Error(`getBodyFromUrl ${u} ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async getBodies(entries, signal) {
      if (mode !== "live") {
        return Promise.all(
          entries.map(async ({ path }): Promise<[string, Uint8Array]> => {
            const r = await fetchImpl(bodyUrl(path), { headers: authH, signal });
            if (!r.ok) throw new Error(`getBody ${path} ${r.status}`);
            return [path, new Uint8Array(await r.arrayBuffer())];
          }),
        );
      }
      const r = await fetchImpl(url("/bodies"), {
        method: "POST",
        headers: { ...authH, "content-type": "application/json" },
        signal,
        // Carry the legacy path-only shape during the rolling upgrade. A new
        // server uses `entries` to bind each read to its observed hash; an old
        // server ignores that field and continues to read `paths`.
        body: JSON.stringify({
          entries,
          paths: entries.map(({ path }) => path),
        }),
      });
      if (!r.ok) throw new Error(`getBodies ${r.status}`);
      return decodeFrames(new Uint8Array(await r.arrayBuffer()));
    },
    putBody:
      mode !== "live"
        ? (readOnly("put") as LayerHttp["putBody"])
        : async (path, body, mutationId, signal) => {
            const r = await fetchImpl(bodyUrl(path), {
              method: "PUT",
              headers: {
                ...authH,
                "content-type": "application/octet-stream",
                ...(mutationId ? { [MUTATION_ID_HEADER]: mutationId } : {}),
              },
              body: body as BodyInit,
              signal,
            });
            if (roomMoved(r)) throw new SyncRoomMovedError("putBody", path);
            if (!r.ok) throw new Error(`putBody ${r.status}`);
            return (await r.json()) as PutResult;
          },
    deleteBody:
      mode !== "live"
        ? (readOnly("delete") as LayerHttp["deleteBody"])
        : async (path, mutationId, signal, expectedHash) => {
            const r = await fetchImpl(bodyUrl(path), {
              method: "DELETE",
              headers: {
                ...authH,
                ...(mutationId ? { [MUTATION_ID_HEADER]: mutationId } : {}),
                ...(expectedHash
                  ? { [EXPECTED_HASH_HEADER]: expectedHash }
                  : {}),
              },
              signal,
            });
            if (roomMoved(r)) throw new SyncRoomMovedError("deleteBody", path);
            if (!r.ok) throw new Error(`deleteBody ${r.status}`);
            return (await r.json()) as { version: number };
          },
  };
}

/* ------------------------------------------------------------ realtime ----- */

/**
 * A live layer's realtime channel. The default talks to a partyserver DO over a
 * reconnecting native WebSocket; tests inject an in-memory channel. `onOpen`
 * fires on the first connect AND every reconnect (the caller re-hellos + resyncs).
 */
export interface RealtimeChannel {
  onOpen(cb: () => void): void;
  onMessage(cb: (msg: ServerMsg) => void): void;
  send(msg: ClientMsg): void;
  close(): void;
}

export type ChannelFactory = (opts: {
  url: string;
  namespace: string;
  token?: string;
  /**
   * Multiplex key (LayerDescriptor.channel.lib): share ONE socket per `url`
   * across every layer that names it, tagging frames with this id. Absent:
   * a dedicated socket per layer (single-namespace rooms).
   */
  lib?: string;
}) => RealtimeChannel;

/**
 * Default channel: a reconnecting native WebSocket (no partysocket dependency).
 * Layers carrying a `lib` multiplex key share one socket per (url, token) —
 * this is what keeps a project session at ONE connection for all of its
 * per-lib mirror overlays instead of one websocket per library.
 */
export const defaultChannelFactory: ChannelFactory = createMuxChannelFactory(
  webSocketChannel,
);

/**
 * Build a {@link ChannelFactory} that multiplexes lib-tagged layers over shared
 * raw channels (one per url+token, refcounted; closed when the last facade
 * closes). `openRaw` supplies the underlying transport — the real factory
 * passes `webSocketChannel`; tests inject an in-memory channel.
 */
export function createMuxChannelFactory(
  openRaw: (url: string, token?: string) => RealtimeChannel,
): ChannelFactory {
  const shared = new Map<string, { raw: MuxRawChannel; refs: number }>();

  return ({ url, token, lib }) => {
    if (lib === undefined) return openRaw(url, token);

    const key = `${url}|${token ?? ""}`;
    let entry = shared.get(key);
    if (!entry) {
      entry = { raw: new MuxRawChannel(openRaw(url, token)), refs: 0 };
      shared.set(key, entry);
    }
    entry.refs += 1;
    const e = entry;
    return e.raw.facade(lib, () => {
      e.refs -= 1;
      if (e.refs === 0) {
        shared.delete(key);
        e.raw.close();
      }
    });
  };
}

/**
 * One shared raw channel fanning out to per-lib facades. Outbound frames are
 * stamped with the facade's `lib`; inbound frames route to the facade whose
 * `lib` matches exactly (a frame without `lib` matches no facade — facades
 * only exist for multiplexed rooms, where the server tags every frame).
 * `onOpen` fans out to every facade — each layer re-hellos on (re)connect,
 * same as with a dedicated socket.
 */
class MuxRawChannel {
  private readonly facades = new Map<
    string,
    Set<{
      openCbs: Array<() => void>;
      msgCbs: Array<(m: ServerMsg) => void>;
      closed: boolean;
    }>
  >();
  /**
   * The last room-level registry frame, replayed to facades created after it
   * arrived. The frame is a STATE snapshot, not an event: the room sends it
   * once per connect, while a boot's presync creates facades over hundreds of
   * milliseconds — without replay every late layer would miss its verdict and
   * pay the deadline-fallback sync the registry exists to remove.
   */
  private lastRegistry: (ServerMsg & { t: "registry" }) | null = null;

  constructor(private readonly raw: RealtimeChannel) {
    raw.onOpen(() => {
      // A (re)connect invalidates the previous snapshot: the room re-sends its
      // current one, and replaying a pre-disconnect frame could affirm stale.
      this.lastRegistry = null;
      for (const group of this.facades.values()) {
        for (const facade of [...group]) {
          for (const cb of [...facade.openCbs]) {
            if (facade.closed) break;
            cb();
          }
        }
      }
    });
    raw.onMessage((m) => {
      // Room-level registry frames are never lib-tagged: fan the ONE frame out
      // to every facade whose mux key it mentions (each layer picks its own
      // entry by namespace — the mux key IS the sub-namespace name).
      if (m.t === "registry") {
        this.lastRegistry = m;
        for (const lib of Object.keys(m.libs ?? {})) {
          const group = this.facades.get(lib);
          if (!group) continue;
          for (const facade of [...group]) {
            for (const cb of [...facade.msgCbs]) {
              if (facade.closed) break;
              cb(m);
            }
          }
        }
        return;
      }
      const group = this.facades.get((m as { lib?: string }).lib ?? "");
      if (!group) return;
      for (const facade of [...group]) {
        for (const cb of [...facade.msgCbs]) {
          if (facade.closed) break;
          cb(m);
        }
      }
    });
  }

  facade(lib: string, onClose: () => void): RealtimeChannel {
    const state = {
      openCbs: [] as Array<() => void>,
      msgCbs: [] as Array<(m: ServerMsg) => void>,
      closed: false,
    };
    let group = this.facades.get(lib);
    if (!group) {
      group = new Set();
      this.facades.set(lib, group);
    }
    group.add(state);
    // Replay the current registry snapshot to a late-created facade — on the
    // next task, so the caller has wired onMessage first (SyncLayer attaches
    // handlers right after the factory returns).
    if (this.lastRegistry && lib in (this.lastRegistry.libs ?? {})) {
      const replay = this.lastRegistry;
      setTimeout(() => {
        if (state.closed || this.lastRegistry !== replay) return;
        for (const cb of [...state.msgCbs]) {
          if (state.closed) break;
          cb(replay);
        }
      }, 0);
    }
    return {
      onOpen: (cb) => state.openCbs.push(cb),
      onMessage: (cb) => state.msgCbs.push(cb),
      send: (msg) => {
        if (!state.closed) this.raw.send({ ...msg, lib });
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        group.delete(state);
        if (group.size === 0 && this.facades.get(lib) === group) {
          this.facades.delete(lib);
        }
        onClose();
      },
    };
  }

  close(): void {
    this.raw.close();
  }
}

function toWsUrl(base: string, token?: string): string {
  const ws = base.replace(/^http/, "ws");
  return token ? `${ws}?token=${encodeURIComponent(token)}` : ws;
}

function webSocketChannel(base: string, token?: string): RealtimeChannel {
  const target = toWsUrl(base, token);
  const openCbs: Array<() => void> = [];
  const msgCbs: Array<(m: ServerMsg) => void> = [];
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let backoff = 500;

  const connect = () => {
    reconnectTimer = undefined;
    if (closed) return;
    const socket = new WebSocket(target);
    ws = socket;
    socket.onopen = () => {
      if (closed || ws !== socket) return;
      backoff = 500;
      for (const cb of [...openCbs]) cb();
    };
    socket.onmessage = (e) => {
      if (closed || ws !== socket) return;
      if (typeof e.data !== "string") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data) as ServerMsg;
      } catch {
        return;
      }
      for (const cb of [...msgCbs]) cb(msg);
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (closed) return;
      // Every reconnect costs the server an authorize round trip before the
      // socket even speaks, so a persistently-down room must back off far —
      // and jitter, so a fleet of layers doesn't thundering-herd the worker.
      backoff = Math.min(backoff * 2, 30_000);
      reconnectTimer = setTimeout(
        connect,
        backoff + Math.random() * backoff * 0.3,
      );
    };
    socket.onerror = () => socket.close();
  };
  connect();

  return {
    onOpen: (cb) => {
      openCbs.push(cb);
    },
    onMessage: (cb) => {
      msgCbs.push(cb);
    },
    send: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}
