import {
  decodeBundle,
  decodeFrames,
  type ClientMsg,
  type ServerMsg,
  type SyncManifest,
} from "@pcbjam/shared";

/** Server's reply to a write — the authoritative version + content hash. */
export interface PutResult {
  version: number;
  hash: string;
  size: number;
}

/**
 * The HTTP face of one layer. For a `live` layer this hits the Durable Object;
 * for a `static` layer it hits the immutable CDN/R2 snapshot (read-only — the
 * write methods reject). Injected, so tests run against an in-memory fake.
 */
export interface LayerHttp {
  getManifest(): Promise<SyncManifest>;
  getBundle(): Promise<{
    manifest: SyncManifest;
    bodies: Array<[string, Uint8Array]>;
  }>;
  getBodies(paths: string[]): Promise<Array<[string, Uint8Array]>>;
  putBody(path: string, body: Uint8Array): Promise<PutResult>;
  deleteBody(path: string): Promise<{ version: number }>;
}

/**
 * `fetch`-backed HTTP transport. `mode` picks the body-fetch strategy: a `live`
 * DO serves a batched `POST /bodies`; a `static` CDN can only GET, so bodies are
 * fetched in parallel and writes are rejected.
 */
export function httpLayer(
  base: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
  mode: "live" | "static",
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
    async getManifest() {
      const r = await fetchImpl(url("/manifest"), { headers: authH });
      if (!r.ok) throw new Error(`getManifest ${r.status}`);
      return (await r.json()) as SyncManifest;
    },
    async getBundle() {
      const r = await fetchImpl(url("/bundle"), { headers: authH });
      if (!r.ok) throw new Error(`getBundle ${r.status}`);
      return decodeBundle(new Uint8Array(await r.arrayBuffer()));
    },
    async getBodies(paths) {
      if (mode === "static") {
        return Promise.all(
          paths.map(async (p): Promise<[string, Uint8Array]> => {
            const r = await fetchImpl(bodyUrl(p), { headers: authH });
            if (!r.ok) throw new Error(`getBody ${p} ${r.status}`);
            return [p, new Uint8Array(await r.arrayBuffer())];
          }),
        );
      }
      const r = await fetchImpl(url("/bodies"), {
        method: "POST",
        headers: { ...authH, "content-type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!r.ok) throw new Error(`getBodies ${r.status}`);
      return decodeFrames(new Uint8Array(await r.arrayBuffer()));
    },
    putBody:
      mode === "static"
        ? (readOnly("put") as LayerHttp["putBody"])
        : async (path, body) => {
            const r = await fetchImpl(bodyUrl(path), {
              method: "PUT",
              headers: { ...authH, "content-type": "application/octet-stream" },
              body: body as BodyInit,
            });
            if (!r.ok) throw new Error(`putBody ${r.status}`);
            return (await r.json()) as PutResult;
          },
    deleteBody:
      mode === "static"
        ? (readOnly("delete") as LayerHttp["deleteBody"])
        : async (path) => {
            const r = await fetchImpl(bodyUrl(path), {
              method: "DELETE",
              headers: authH,
            });
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
}) => RealtimeChannel;

/** Default channel: a reconnecting native WebSocket (no partysocket dependency). */
export const defaultChannelFactory: ChannelFactory = ({ url, token }) =>
  webSocketChannel(url, token);

function toWsUrl(base: string, token?: string): string {
  const ws = base.replace(/^http/, "ws");
  return token ? `${ws}?token=${encodeURIComponent(token)}` : ws;
}

function webSocketChannel(base: string, token?: string): RealtimeChannel {
  const target = toWsUrl(base, token);
  const openCbs: Array<() => void> = [];
  const msgCbs: Array<(m: ServerMsg) => void> = [];
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const connect = () => {
    ws = new WebSocket(target);
    ws.onopen = () => {
      backoff = 500;
      for (const cb of openCbs) cb();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data) as ServerMsg;
      } catch {
        return;
      }
      for (const cb of msgCbs) cb(msg);
    };
    ws.onclose = () => {
      if (closed) return;
      backoff = Math.min(backoff * 2, 10_000);
      setTimeout(connect, backoff);
    };
    ws.onerror = () => ws?.close();
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
      closed = true;
      ws?.close();
    },
  };
}
