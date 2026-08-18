import { encodeFrames, SYNC_ACTION_HEADER, SYNC_ACTION_RELOAD } from "@pcbjam/shared";
import { describe, expect, it, vi } from "vitest";
import {
  defaultChannelFactory,
  httpLayer,
  SyncRoomMovedError,
} from "../src/transport.js";

describe("httpLayer rolling body requests", () => {
  it("sends hash-bound entries and the legacy path list together", async () => {
    let payload: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(encodeFrames([]) as BodyInit);
    };
    const http = httpLayer("https://sync.test", undefined, fetchImpl, "live");
    const entries = [
      { path: "symbol/R", hash: "etag-r" },
      { path: "symbol/C", hash: "etag-c" },
    ];

    await http.getBodies(entries);

    expect(payload).toEqual({
      entries,
      paths: ["symbol/R", "symbol/C"],
    });
  });

  it("forwards the caller's abort signal to fetch", async () => {
    let received: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      received = init?.signal;
      return Response.json({ version: 0, entries: {} });
    };
    const http = httpLayer("https://sync.test", undefined, fetchImpl, "live");
    const controller = new AbortController();

    await http.getManifest(controller.signal);

    expect(received).toBe(controller.signal);
  });
});

describe("cutover 409 (x-pcbjam-sync-action: reload)", () => {
  const moved = () =>
    new Response(JSON.stringify({ message: "room moved" }), {
      status: 409,
      headers: { [SYNC_ACTION_HEADER]: SYNC_ACTION_RELOAD },
    });

  it("PUT and DELETE surface a typed SyncRoomMovedError", async () => {
    const http = httpLayer(
      "https://sync.test",
      undefined,
      (async () => moved()) as typeof fetch,
      "live",
    );
    await expect(http.putBody("symbol/R", new Uint8Array([1]))).rejects.toBeInstanceOf(
      SyncRoomMovedError,
    );
    await expect(http.deleteBody("symbol/R")).rejects.toBeInstanceOf(
      SyncRoomMovedError,
    );
  });

  it("a 409 WITHOUT the action header stays a generic failure", async () => {
    const http = httpLayer(
      "https://sync.test",
      undefined,
      (async () => new Response(null, { status: 409 })) as typeof fetch,
      "live",
    );
    const err = await http.putBody("symbol/R", new Uint8Array([1])).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyncRoomMovedError);
  });
});

describe("native websocket lifetime", () => {
  it("cancels a pending reconnect when close wins before its timer", async () => {
    const sockets: FakeBrowserSocket[] = [];
    class FakeBrowserSocket {
      static readonly OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
      }

      send(_data: string): void {}

      close(): void {
        this.readyState = 3;
        this.onclose?.();
      }

      drop(): void {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeBrowserSocket);
    try {
      const channel = defaultChannelFactory({
        url: "https://sync.test/room",
        namespace: "live:test",
      });
      expect(sockets).toHaveLength(1);

      sockets[0]!.drop();
      expect(vi.getTimerCount()).toBe(1);
      channel.close();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
