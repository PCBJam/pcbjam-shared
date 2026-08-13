import { encodeFrames } from "@pcbjam/shared";
import { describe, expect, it, vi } from "vitest";
import { defaultChannelFactory, httpLayer } from "../src/transport.js";

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
