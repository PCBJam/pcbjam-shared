import type {
  ClientMsg,
  ServerMsg,
  SyncChange,
  SyncManifest,
} from "@pcbjam/shared";
import { describe, expect, it, vi } from "vitest";
import {
  memStore,
  SyncLayer,
  SyncMutationQueueFullError,
  type LayerHttp,
  type LayerChange,
  type LayerStore,
  type LayerStoreCommit,
  type RealtimeChannel,
  type SyncMutationQueueLimits,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (value: string) => enc.encode(value);
const text = (value: Uint8Array | null) => (value ? dec.decode(value) : null);
const manifest = (version: number): SyncManifest => ({ version, entries: {} });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function fakeHttp(overrides: Partial<LayerHttp> = {}): LayerHttp {
  return {
    getManifest: async () => manifest(0),
    getBundle: async () => ({ manifest: manifest(0), bodies: [] }),
    getBodies: async () => [],
    getBodyFromUrl: async () => new Uint8Array(),
    putBody: async (_path, body) => ({ version: 0, hash: "", size: body.length }),
    deleteBody: async () => ({ version: 0 }),
    ...overrides,
  };
}

class ManualChannel implements RealtimeChannel {
  private onOpenCallback: (() => void) | undefined;
  private onMessageCallback: ((message: ServerMsg) => void) | undefined;
  readonly sent: ClientMsg[] = [];
  closed = false;

  onOpen(callback: () => void): void {
    this.onOpenCallback = callback;
  }

  onMessage(callback: (message: ServerMsg) => void): void {
    this.onMessageCallback = callback;
  }

  send(message: ClientMsg): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  deliver(change: SyncChange): void {
    this.onMessageCallback?.({ t: "change", ...change });
  }

  reopen(): void {
    this.onOpenCallback?.();
  }
}

async function openLayer(
  http: LayerHttp,
  onChange?: (change: LayerChange) => void,
  store: LayerStore = memStore(),
  storedManifest: SyncManifest = manifest(0),
  mutationQueueLimits?: Partial<SyncMutationQueueLimits>,
  mutationReceiptDeadlineMs?: number,
): Promise<{ layer: SyncLayer; channel: ManualChannel }> {
  // A stored manifest makes open() warm. This keeps the tests focused on
  // realtime sequencing instead of the mandatory warm-open HTTP comparison.
  await store.setManifest(storedManifest);
  let opening = true;
  const layerHttp: LayerHttp = {
    ...http,
    getManifest: () =>
      opening
        ? Promise.resolve({
            version: storedManifest.version,
            entries: Object.fromEntries(
              Object.entries(storedManifest.entries).map(([path, entry]) => [
                path,
                { ...entry },
              ]),
            ),
          })
        : http.getManifest(),
  };
  const channel = new ManualChannel();
  const layer = new SyncLayer({
    namespace: "test",
    kind: "live",
    writable: true,
    store,
    http: layerHttp,
    channel,
    onChange,
    mutationQueueLimits,
    mutationReceiptDeadlineMs,
  });
  try {
    await layer.open();
  } finally {
    opening = false;
  }
  return { layer, channel };
}

describe("SyncLayer source sequencing", () => {
  it("keeps one active and one latest pending body read per path", async () => {
    const requests: Array<ReturnType<typeof deferred<Array<[string, Uint8Array]>>>> = [];
    const changes: LayerChange[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const http = fakeHttp({
      getBodies: async () => {
        const request = deferred<Array<[string, Uint8Array]>>();
        requests.push(request);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await request.promise;
        } finally {
          inFlight--;
        }
      },
    });
    const { layer, channel } = await openLayer(http, (change) => changes.push(change));

    channel.deliver({ op: "put", path: "symbol/R", hash: "old", size: 3, version: 1 });
    channel.deliver({ op: "put", path: "symbol/R", hash: "new", size: 3, version: 2 });
    requests[0]!.resolve([["symbol/R", bytes("old")]]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(maxInFlight).toBe(1);
    expect(changes).toHaveLength(0);

    requests[1]!.resolve([["symbol/R", bytes("new")]]);
    await vi.waitFor(() => expect(inFlight).toBe(0));
    await vi.waitFor(() => expect(changes.map((change) => change.version)).toEqual([2]));

    expect(text(await layer.getBody("symbol/R"))).toBe("new");
    expect(layer.entries()["symbol/R"]?.hash).toBe("new");
    expect(layer.version()).toBe(2);
    expect(changes.map((change) => change.version)).toEqual([2]);
  });

  it("keeps body fetches for independent paths concurrent", async () => {
    const requests = new Map<
      string,
      ReturnType<typeof deferred<Array<[string, Uint8Array]>>>
    >();
    let inFlight = 0;
    let maxInFlight = 0;
    const http = fakeHttp({
      getBodies: async (entries) => {
        const path = entries[0]!.path;
        const request = deferred<Array<[string, Uint8Array]>>();
        requests.set(path!, request);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await request.promise;
        } finally {
          inFlight--;
        }
      },
    });
    const { layer, channel } = await openLayer(http);

    channel.deliver({ op: "put", path: "symbol/R", hash: "r", size: 1, version: 1 });
    channel.deliver({ op: "put", path: "symbol/C", hash: "c", size: 1, version: 2 });
    await vi.waitFor(() => expect(requests.size).toBe(2));
    expect(maxInFlight).toBeGreaterThan(1);

    requests.get("symbol/C")!.resolve([["symbol/C", bytes("C")]]);
    requests.get("symbol/R")!.resolve([["symbol/R", bytes("R")]]);
    await vi.waitFor(() => expect(inFlight).toBe(0));
    await vi.waitFor(() => expect(layer.version()).toBe(2));

    expect(text(await layer.getBody("symbol/R"))).toBe("R");
    expect(text(await layer.getBody("symbol/C"))).toBe("C");
  });

  it("runs a follow-up pass when sync is requested during an active pass", async () => {
    const requests: Array<ReturnType<typeof deferred<SyncManifest>>> = [];
    const http = fakeHttp({
      getManifest: async () => {
        const request = deferred<SyncManifest>();
        requests.push(request);
        return request.promise;
      },
    });
    const { layer } = await openLayer(http);

    const first = layer.sync();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const second = layer.sync();
    expect(second).toBe(first);

    requests[0]!.resolve(manifest(1));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(manifest(2));
    await Promise.all([first, second]);

    expect(layer.version()).toBe(2);
  });

  it("never cancels a push when sync is called in the same turn", async () => {
    const manifestRequest = deferred<SyncManifest>();
    const putRequest = deferred<{ version: number; hash: string; size: number }>();
    let manifestStarted = false;
    let putStarted = false;
    const http = fakeHttp({
      getManifest: async () => {
        manifestStarted = true;
        return manifestRequest.promise;
      },
      putBody: async () => {
        putStarted = true;
        return putRequest.promise;
      },
    });
    const { layer } = await openLayer(http);

    const pushing = layer.push("symbol/R", bytes("local"));
    const syncing = layer.sync();
    await vi.waitFor(() => {
      expect(manifestStarted).toBe(true);
      expect(putStarted).toBe(true);
    });
    expect(text(await layer.getBody("symbol/R"))).toBe("local");

    // The snapshot does not contain the concurrent local mutation. Its path is
    // protected rather than silently cancelling the HTTP PUT.
    manifestRequest.resolve(manifest(0));
    await syncing;
    putRequest.resolve({ version: 1, hash: "local-hash", size: 5 });
    await pushing;

    expect(text(await layer.getBody("symbol/R"))).toBe("local");
    expect(layer.entries()["symbol/R"]?.hash).toBe("local-hash");
  });

  it("never cancels a delete when sync is called in the same turn", async () => {
    const path = "symbol/R";
    const initial: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "old", size: 3, mtime: 0 } },
    };
    const store = memStore();
    await store.putBody(path, bytes("old"));
    const manifestRequest = deferred<SyncManifest>();
    const deleteRequest = deferred<{ version: number }>();
    let deleteStarted = false;
    const http = fakeHttp({
      getManifest: async () => manifestRequest.promise,
      deleteBody: async () => {
        deleteStarted = true;
        return deleteRequest.promise;
      },
    });
    const { layer } = await openLayer(http, undefined, store, initial);

    const deleting = layer.delete(path);
    const syncing = layer.sync();
    await vi.waitFor(() => expect(deleteStarted).toBe(true));
    expect(await layer.getBody(path)).toBeNull();

    // This old snapshot still contains the path. The overlapping DELETE owns
    // it until its authoritative receipt arrives.
    manifestRequest.resolve(initial);
    await syncing;
    deleteRequest.resolve({ version: 2 });
    await deleting;

    expect(await layer.getBody(path)).toBeNull();
    expect(layer.entries()[path]).toBeUndefined();
  });

  it("keeps a realtime result when an explicitly replacing sync fails", async () => {
    const manifests: Array<ReturnType<typeof deferred<SyncManifest>>> = [];
    const remoteBody = deferred<Array<[string, Uint8Array]>>();
    const http = fakeHttp({
      getManifest: async () => {
        const request = deferred<SyncManifest>();
        manifests.push(request);
        return request.promise;
      },
      getBodies: async () => remoteBody.promise,
    });
    const { layer, channel } = await openLayer(http);

    const first = layer.sync();
    const rejected = expect(first).rejects.toThrow("replacement failed");
    await vi.waitFor(() => expect(manifests).toHaveLength(1));
    channel.deliver({
      op: "put",
      path: "symbol/R",
      hash: "remote-hash",
      size: 6,
      version: 2,
    });
    const replacement = layer.sync();
    expect(replacement).toBe(first);

    manifests[0]!.resolve(manifest(0));
    await vi.waitFor(() => expect(manifests).toHaveLength(2));
    manifests[1]!.reject(new Error("replacement failed"));
    await rejected;

    remoteBody.resolve([["symbol/R", bytes("remote")]]);
    await vi.waitFor(() =>
      expect(layer.entries()["symbol/R"]?.hash).toBe("remote-hash"),
    );
    expect(text(await layer.getBody("symbol/R"))).toBe("remote");
  });

  it("does not let a stale full sync overwrite a newer realtime change", async () => {
    const staleBody = deferred<Array<[string, Uint8Array]>>();
    const realtimeBody = deferred<Array<[string, Uint8Array]>>();
    const bodyRequests: Array<{ path: string; request: typeof staleBody }> = [];
    const changes: LayerChange[] = [];
    let manifestFetches = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const entry = (hash: string, size = 3) => ({ hash, size, mtime: 0 });
    const http = fakeHttp({
      getManifest: async () => {
        manifestFetches++;
        return manifestFetches === 1
          ? { version: 1, entries: { "symbol/R": entry("old", 4) } }
          : { version: 2, entries: { "symbol/R": entry("new") } };
      },
      getBodies: async (entries) => {
        const path = entries[0]!.path;
        const request = bodyRequests.length === 0 ? staleBody : realtimeBody;
        bodyRequests.push({ path: path!, request });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await request.promise;
        } finally {
          inFlight--;
        }
      },
    });
    const { layer, channel } = await openLayer(http, (change) => changes.push(change));

    const syncing = layer.sync();
    await vi.waitFor(() => expect(bodyRequests).toHaveLength(1));
    channel.deliver({
      op: "put",
      path: "symbol/R",
      hash: "new",
      size: 3,
      version: 2,
    });
    await vi.waitFor(() => expect(bodyRequests).toHaveLength(2));
    expect(maxInFlight).toBeGreaterThan(1);

    realtimeBody.resolve([["symbol/R", bytes("new")]]);
    await vi.waitFor(() => expect(layer.entries()["symbol/R"]?.hash).toBe("new"));
    // This response is malformed as well as stale. Source ordering must reject
    // it before integrity validation can turn a superseded response into a
    // failure or a repair of the already accepted realtime value.
    staleBody.resolve([["symbol/R", bytes("old")]]);
    await syncing;

    // Realtime source order protects this path directly; unrelated traffic
    // does not create a full-sync retry.
    expect(manifestFetches).toBe(1);
    expect(text(await layer.getBody("symbol/R"))).toBe("new");
    expect(layer.entries()["symbol/R"]?.hash).toBe("new");
    expect(layer.version()).toBe(2);
    expect(changes.map((change) => change.version)).toEqual([2]);
  });

  it("reconciles a delayed or replayed remote DELETE after an epoch replacement", async () => {
    const path = "symbol/R";
    const oldEpoch: SyncManifest = {
      version: 40,
      entries: { [path]: { hash: "old-hash", size: 3, mtime: 0 } },
    };
    const newEpoch: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "new-hash", size: 3, mtime: 0 } },
    };
    const store = memStore();
    await store.putBody(path, bytes("old"));
    const changes: LayerChange[] = [];
    let manifestFetches = 0;
    const http = fakeHttp({
      getManifest: async () => {
        manifestFetches++;
        return newEpoch;
      },
      getBodies: async () => [[path, bytes("new")]],
    });
    const { layer, channel } = await openLayer(
      http,
      (change) => changes.push(change),
      store,
      oldEpoch,
    );

    // This complete authoritative sync establishes a replacement epoch whose
    // reset numeric version is lower than the previous room's version.
    await layer.sync();
    expect(layer.version()).toBe(1);
    expect(text(await layer.getBody(path))).toBe("new");

    // A delayed old-room frame looks newer numerically. It is only an
    // invalidation hint: each delivery must re-check the authoritative server,
    // which still owns the replacement value.
    channel.deliver({ op: "del", path, version: 41 });
    await vi.waitFor(() => expect(manifestFetches).toBe(2));
    await vi.waitFor(() =>
      expect(
        (layer as unknown as { remotePaths: Map<string, unknown> }).remotePaths
          .size,
      ).toBe(0),
    );
    channel.deliver({ op: "del", path, version: 41 });
    await vi.waitFor(() => expect(manifestFetches).toBe(3));
    await vi.waitFor(() =>
      expect(
        (layer as unknown as { remotePaths: Map<string, unknown> }).remotePaths
          .size,
      ).toBe(0),
    );

    expect(layer.version()).toBe(1);
    expect(layer.entries()[path]?.hash).toBe("new-hash");
    expect(text(await layer.getBody(path))).toBe("new");
    expect(changes).toEqual([
      expect.objectContaining({ op: "put", path, origin: "remote" }),
    ]);
    layer.close();
  });

  it("does not let a stale full sync overwrite a local push", async () => {
    const staleBody = deferred<Array<[string, Uint8Array]>>();
    const put = deferred<{ version: number; hash: string; size: number }>();
    const changes: LayerChange[] = [];
    let manifestFetches = 0;
    let bodyInFlight = false;
    let putInFlight = false;
    let maxInFlight = 0;
    const countInFlight = () => Number(bodyInFlight) + Number(putInFlight);
    const entry = (hash: string) => ({ hash, size: 5, mtime: 0 });
    const http = fakeHttp({
      getManifest: async () => {
        manifestFetches++;
        return manifestFetches === 1
          ? { version: 1, entries: { "symbol/R": entry("stale") } }
          : { version: 2, entries: { "symbol/R": entry("local") } };
      },
      getBodies: async () => {
        bodyInFlight = true;
        maxInFlight = Math.max(maxInFlight, countInFlight());
        try {
          return await staleBody.promise;
        } finally {
          bodyInFlight = false;
        }
      },
      putBody: async () => {
        putInFlight = true;
        maxInFlight = Math.max(maxInFlight, countInFlight());
        try {
          return await put.promise;
        } finally {
          putInFlight = false;
        }
      },
    });
    const { layer } = await openLayer(http, (change) => changes.push(change));

    const syncing = layer.sync();
    await vi.waitFor(() => expect(bodyInFlight).toBe(true));
    const pushing = layer.push("symbol/R", bytes("local"));
    await vi.waitFor(() => expect(putInFlight).toBe(true));
    expect(maxInFlight).toBeGreaterThan(1);
    expect(text(await layer.getBody("symbol/R"))).toBe("local"); // optimistic

    put.resolve({ version: 2, hash: "local", size: 5 });
    await pushing;
    staleBody.resolve([["symbol/R", bytes("stale")]]);
    await syncing;

    // The overlapping local intent protects its path. Its exact receipt is
    // authoritative, so no traffic-driven replacement pass is necessary.
    expect(manifestFetches).toBe(1);
    expect(text(await layer.getBody("symbol/R"))).toBe("local");
    expect(layer.entries()["symbol/R"]?.hash).toBe("local");
    expect(changes.map((change) => change.version)).toEqual([2]);
  });

  it("does not let a late local ack overwrite a newer same-path remote change", async () => {
    const put = deferred<{ version: number; hash: string; size: number }>();
    const changes: LayerChange[] = [];
    let putStarted = false;
    let bodyFetches = 0;
    const http = fakeHttp({
      putBody: async () => {
        putStarted = true;
        return put.promise;
      },
      getManifest: async () => ({
        version: 2,
        entries: {
          "symbol/R": { hash: "remote-hash", size: 6, mtime: 0 },
        },
      }),
      getBodies: async (entries) => {
        const path = entries[0]!.path;
        bodyFetches++;
        return [[path!, bytes("remote")]];
      },
    });
    const { layer, channel } = await openLayer(http, (change) => changes.push(change));

    const localPush = layer.push("symbol/R", bytes("local"));
    await vi.waitFor(() => expect(putStarted).toBe(true));
    // This newer write is from another client. It arrives while our request is
    // unacknowledged, so path-only echo suppression would incorrectly drop it.
    channel.deliver({
      op: "put",
      path: "symbol/R",
      hash: "remote-hash",
      size: 6,
      version: 2,
    });
    expect(bodyFetches).toBe(0); // waits only for exact receipt classification

    put.resolve({ version: 1, hash: "local-hash", size: 5 });
    await localPush;
    await vi.waitFor(() => expect(bodyFetches).toBe(1));
    await vi.waitFor(() => expect(layer.entries()["symbol/R"]?.hash).toBe("remote-hash"));

    expect(text(await layer.getBody("symbol/R"))).toBe("remote");
    expect(changes.map((change) => change.version)).toEqual([1, 2]);
    expect(changes.map((change) => change.origin)).toEqual(["local", "remote"]);
  });

  it("does not let a failed local rollback overwrite newer remote state", async () => {
    const put = deferred<{ version: number; hash: string; size: number }>();
    const backing = memStore();
    let rollbackDeletes = 0;
    const store: LayerStore = {
      ...backing,
      delBody: async (path) => {
        rollbackDeletes++;
        await backing.delBody(path);
      },
    };
    const changes: LayerChange[] = [];
    let putStarted = false;
    const http = fakeHttp({
      putBody: async () => {
        putStarted = true;
        return put.promise;
      },
      getManifest: async () => ({
        version: 2,
        entries: {
          "symbol/R": { hash: "remote-hash", size: 6, mtime: 0 },
        },
      }),
      getBodies: async (entries) => [[entries[0]!.path, bytes("remote")]],
    });
    const { layer, channel } = await openLayer(
      http,
      (change) => changes.push(change),
      store,
    );

    const localPush = layer.push("symbol/R", bytes("local"));
    await vi.waitFor(() => expect(putStarted).toBe(true));
    channel.deliver({
      op: "put",
      path: "symbol/R",
      hash: "remote-hash",
      size: 6,
      version: 2,
    });

    const failed = expect(localPush).rejects.toThrow("write failed");
    put.reject(new Error("write failed"));
    await failed;
    await vi.waitFor(() => expect(layer.entries()["symbol/R"]?.hash).toBe("remote-hash"));

    expect(rollbackDeletes).toBe(0);
    expect(text(await layer.getBody("symbol/R"))).toBe("remote");
    expect(changes.map((change) => change.version)).toEqual([2]);
    expect(changes[0]?.origin).toBe("remote");
  });

  it("serializes reversed same-path local operations but not independent paths", async () => {
    const firstPut = deferred<{ version: number; hash: string; size: number }>();
    const independentPut = deferred<{
      version: number;
      hash: string;
      size: number;
    }>();
    let deleteStarted = false;
    const started: string[] = [];
    const http = fakeHttp({
      putBody: async (path, body) => {
        started.push(`put:${path}`);
        return path === "symbol/R"
          ? firstPut.promise
          : independentPut.promise;
      },
      deleteBody: async (path) => {
        started.push(`del:${path}`);
        deleteStarted = true;
        return { version: 3 };
      },
    });
    const { layer } = await openLayer(http);

    const first = layer.push("symbol/R", bytes("first"));
    const second = layer.delete("symbol/R");
    const independent = layer.push("symbol/C", bytes("other"));
    await vi.waitFor(() => expect(started).toContain("put:symbol/C"));
    expect(started).toContain("put:symbol/R");
    expect(deleteStarted).toBe(false);

    independentPut.resolve({ version: 2, hash: "other-hash", size: 5 });
    await independent;
    firstPut.resolve({ version: 1, hash: "first-hash", size: 5 });
    await first;
    await vi.waitFor(() => expect(deleteStarted).toBe(true));
    await second;

    expect(await layer.getBody("symbol/R")).toBeNull();
    expect(layer.entries()["symbol/R"]).toBeUndefined();
    expect(text(await layer.getBody("symbol/C"))).toBe("other");
    expect(layer.version()).toBe(3);
  });

  it("rejects exactly beyond a held path lane and keeps other paths concurrent", async () => {
    const firstAck = deferred<{ version: number; hash: string; size: number }>();
    const started: string[] = [];
    let version = 0;
    let first = true;
    const { layer } = await openLayer(
      fakeHttp({
        putBody: async (path, body) => {
          started.push(path);
          if (path === "symbol/R" && first) {
            first = false;
            return firstAck.promise;
          }
          return {
            version: ++version + 1,
            hash: `${path}-${version}`,
            size: body.byteLength,
          };
        },
      }),
      undefined,
      memStore(),
      manifest(0),
      { maxPerPath: 3, maxPerLayer: 4, maxRetainedBodyBytes: 32 },
    );

    const active = layer.push("symbol/R", bytes("A"));
    await vi.waitFor(() => expect(started).toEqual(["symbol/R"]));
    const queuedOne = layer.push("symbol/R", bytes("B"));
    const queuedTwo = layer.push("symbol/R", bytes("C"));
    const overflow = layer.push("symbol/R", bytes("D"));
    const overflowClassAssertion = expect(overflow).rejects.toBeInstanceOf(
      SyncMutationQueueFullError,
    );
    const overflowAssertion = expect(overflow).rejects.toMatchObject({
      name: "SyncMutationQueueFullError",
      reason: "path-mutations",
    });
    const independent = layer.push("symbol/C", bytes("E"));

    await vi.waitFor(() => expect(started).toContain("symbol/C"));
    expect(started.filter((path) => path === "symbol/R")).toHaveLength(1);
    await Promise.all([overflowClassAssertion, overflowAssertion]);
    await independent;

    firstAck.resolve({ version: 1, hash: "r-1", size: 1 });
    await Promise.all([active, queuedOne, queuedTwo]);
    expect(started.filter((path) => path === "symbol/R")).toHaveLength(3);

    const state = layer as unknown as {
      localMutationCount: number;
      localMutationBodyBytes: number;
      localPathLanes: Map<string, unknown>;
    };
    expect(state.localMutationCount).toBe(0);
    expect(state.localMutationBodyBytes).toBe(0);
    expect(state.localPathLanes.size).toBe(0);
    await expect(layer.push("symbol/R", bytes("after"))).resolves.toBeUndefined();
    layer.close();
  });

  it("bounds retained mutation snapshots across independent path lanes", async () => {
    const firstAck = deferred<{ version: number; hash: string; size: number }>();
    let first = true;
    const { layer } = await openLayer(
      fakeHttp({
        putBody: async (path, body) => {
          if (first) {
            first = false;
            return firstAck.promise;
          }
          return { version: 2, hash: path, size: body.byteLength };
        },
      }),
      undefined,
      memStore(),
      manifest(0),
      { maxPerPath: 8, maxPerLayer: 8, maxRetainedBodyBytes: 5 },
    );

    const active = layer.push("symbol/R", bytes("AAAA"));
    const overflow = layer.push("symbol/C", bytes("CC"));
    await expect(overflow).rejects.toBeInstanceOf(SyncMutationQueueFullError);
    await expect(overflow).rejects.toMatchObject({
      name: "SyncMutationQueueFullError",
      reason: "retained-body-bytes",
    });

    firstAck.resolve({ version: 1, hash: "r", size: 4 });
    await active;
    await expect(layer.push("symbol/C", bytes("CC"))).resolves.toBeUndefined();
    const state = layer as unknown as {
      localMutationCount: number;
      localMutationBodyBytes: number;
    };
    expect(state.localMutationCount).toBe(0);
    expect(state.localMutationBodyBytes).toBe(0);
    layer.close();
  });

  it("merges independent commits from two layer lifetimes sharing one store", async () => {
    const store = memStore();
    const first = await openLayer(
      fakeHttp({
        putBody: async (_path, body) => ({
          version: 1,
          hash: "r-hash",
          size: body.length,
        }),
      }),
      undefined,
      store,
    );
    const second = await openLayer(
      fakeHttp({
        putBody: async (_path, body) => ({
          version: 2,
          hash: "c-hash",
          size: body.length,
        }),
      }),
      undefined,
      store,
    );

    await Promise.all([
      first.layer.push("symbol/R", bytes("R")),
      second.layer.push("symbol/C", bytes("C")),
    ]);

    const stored = await store.getManifest();
    expect(stored?.entries["symbol/R"]?.hash).toBe("r-hash");
    expect(stored?.entries["symbol/C"]?.hash).toBe("c-hash");
    expect(text(await store.getBody("symbol/R"))).toBe("R");
    expect(text(await store.getBody("symbol/C"))).toBe("C");
    first.layer.close();
    second.layer.close();
  });

  it("does not retain a path omitted by a later cold bundle", async () => {
    const path = "symbol/R";
    const store = memStore();
    const bundleA = deferred<Awaited<ReturnType<LayerHttp["getBundle"]>>>();
    const bundleB = deferred<Awaited<ReturnType<LayerHttp["getBundle"]>>>();
    const snapshotA: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "a", size: 1, mtime: 0 } },
    };
    const snapshotB = manifest(2);
    let bundleRequests = 0;
    let bManifestRequests = 0;

    const first = new SyncLayer({
      namespace: "shared-cold",
      kind: "static",
      writable: false,
      store,
      http: fakeHttp({
        getBundle: async () => {
          bundleRequests++;
          return bundleA.promise;
        },
      }),
    });
    const second = new SyncLayer({
      namespace: "shared-cold",
      kind: "static",
      writable: false,
      store,
      http: fakeHttp({
        getBundle: async () => {
          bundleRequests++;
          return bundleB.promise;
        },
        getManifest: async () => {
          bManifestRequests++;
          return snapshotB;
        },
      }),
    });

    const openingA = first.open();
    const openingB = second.open();
    await vi.waitFor(() => expect(bundleRequests).toBe(2));

    bundleA.resolve({ manifest: snapshotA, bodies: [[path, bytes("A")]] });
    await openingA;
    expect(text(await store.getBody(path))).toBe("A");

    // B also observed a cold store, but its authoritative bundle completed
    // after A published. Its snapshot omits `path`; that omission is a delete.
    bundleB.resolve({ manifest: snapshotB, bodies: [] });
    await openingB;

    expect(bManifestRequests).toBe(1);
    expect(await store.getManifest()).toEqual(snapshotB);
    expect(await store.getBody(path)).toBeNull();
    expect(await store.getAllBodies()).toEqual(new Map());
    first.close();
    second.close();
  });

  it("does not let a stale cold snapshot clear a same-version newer publisher", async () => {
    const path = "symbol/R";
    const store = memStore();
    const first: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "first", size: 1, mtime: 0 } },
    };
    const newer: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "newer", size: 3, mtime: 1 } },
    };

    expect(
      (await store.replaceSnapshot(null, first, [[path, bytes("A")]])).applied,
    ).toBe(true);
    const staleExpected = await store.getManifest();
    expect(
      (
        await store.replaceSnapshot(staleExpected, newer, [
          [path, bytes("NEW")],
        ])
      ).applied,
    ).toBe(true);

    const rejected = await store.replaceSnapshot(staleExpected, manifest(2), []);
    expect(rejected).toEqual({ applied: false, manifest: newer });
    expect(await store.getManifest()).toEqual(newer);
    expect(text(await store.getBody(path))).toBe("NEW");
  });

  it("does not send a same-path mutation that was queued before close", async () => {
    const firstAck = deferred<{ version: number; hash: string; size: number }>();
    let putCalls = 0;
    const { layer } = await openLayer(
      fakeHttp({
        putBody: async (_path, body) => {
          putCalls++;
          if (putCalls === 1) return firstAck.promise;
          return { version: 2, hash: "late", size: body.length };
        },
      }),
    );

    const first = layer.push("symbol/R", bytes("first"));
    const second = layer.push("symbol/R", bytes("must-not-send"));
    const firstFailure = expect(first).rejects.toThrow("closed");
    const secondFailure = expect(second).rejects.toThrow("closed");
    await vi.waitFor(() => expect(putCalls).toBe(1));
    layer.close();
    firstAck.resolve({ version: 1, hash: "first", size: 5 });

    await Promise.all([firstFailure, secondFailure]);
    expect(putCalls).toBe(1);
  });

  it("aborts stalled HTTP on close without publishing or retaining its body", async () => {
    const store = memStore();
    const changes: LayerChange[] = [];
    let requestSignal: AbortSignal | undefined;
    const requestStarted = deferred<void>();
    const { layer } = await openLayer(
      fakeHttp({
        putBody: async (_path, _body, _mutationId, signal) => {
          requestSignal = signal;
          requestStarted.resolve();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          });
        },
      }),
      (change) => changes.push(change),
      store,
    );

    const pushing = layer.push("symbol/R", bytes("retained"));
    await requestStarted.promise;
    expect(requestSignal?.aborted).toBe(false);

    layer.close();

    expect(requestSignal?.aborted).toBe(true);
    await expect(pushing).rejects.toThrow("closed");
    expect(changes).toEqual([]);
    expect(await store.getBody("symbol/R")).toBeNull();
    expect((await store.getManifest())?.entries["symbol/R"]).toBeUndefined();
    const state = layer as unknown as {
      localMutationCount: number;
      localMutationBodyBytes: number;
      localPathLanes: Map<string, unknown>;
      optimistic: Map<string, unknown>;
    };
    expect(state.localMutationCount).toBe(0);
    expect(state.localMutationBodyBytes).toBe(0);
    expect(state.localPathLanes.size).toBe(0);
    expect(state.optimistic.size).toBe(0);
  });

  it("snapshots caller-owned bytes before an asynchronous mutation", async () => {
    const ack = deferred<{ version: number; hash: string; size: number }>();
    let submitted: Uint8Array | undefined;
    const { layer } = await openLayer(
      fakeHttp({
        putBody: async (_path, body) => {
          submitted = body;
          return ack.promise;
        },
      }),
    );
    const input = bytes("safe");
    const pushing = layer.push("symbol/R", input);
    await vi.waitFor(() => expect(submitted).toBeDefined());

    input[0] = "X".charCodeAt(0);
    const optimisticRead = await layer.getBody("symbol/R");
    optimisticRead![1] = "Y".charCodeAt(0);
    ack.resolve({ version: 1, hash: "safe-hash", size: 4 });
    await pushing;

    expect(text(submitted ?? null)).toBe("safe");
    expect(text(await layer.getBody("symbol/R"))).toBe("safe");
    layer.close();
  });

  it("ignores only an exact completed echo, not a replay with changed content", async () => {
    const changes: LayerChange[] = [];
    let bodyFetches = 0;
    let mutationId: string | undefined;
    const http = fakeHttp({
      putBody: async (_path, body, id) => {
        mutationId = id;
        return { version: 1, hash: "local-hash", size: body.length };
      },
      getBodies: async () => {
        bodyFetches++;
        return [["symbol/R", bytes("unexpected")]];
      },
    });
    const { layer, channel } = await openLayer(http, (change) =>
      changes.push(change),
    );

    await layer.push("symbol/R", bytes("local"));
    expect(changes).toHaveLength(1);
    // The websocket echo arrives after push() and its cache commit completed.
    channel.deliver({
      op: "put",
      path: "symbol/R",
      hash: "local-hash",
      size: 5,
      version: 1,
      mutationId,
    });

    expect(bodyFetches).toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.origin).toBe("local");
    expect(text(await layer.getBody("symbol/R"))).toBe("local");

    channel.deliver({
      op: "put",
      path: "symbol/R",
      hash: "peer-hash",
      size: 10,
      version: 2,
      mutationId,
    });
    await vi.waitFor(() => expect(bodyFetches).toBe(1));
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]?.origin).toBe("remote");
    layer.close();
  });

  it("reconciles a changed-content replay while the mutation is active", async () => {
    const ack = deferred<{ version: number; hash: string; size: number }>();
    let mutationId: string | undefined;
    let bodyFetches = 0;
    const path = "symbol/R";
    const http = fakeHttp({
      putBody: async (_path, _body, id) => {
        mutationId = id;
        return ack.promise;
      },
      getManifest: async () => ({
        version: 2,
        entries: { [path]: { hash: "peer-hash", size: 4, mtime: 0 } },
      }),
      getBodies: async () => {
        bodyFetches++;
        return [[path, bytes("peer")]];
      },
    });
    const { layer, channel } = await openLayer(http);

    const pushing = layer.push(path, bytes("local"));
    await vi.waitFor(() => expect(mutationId).toBeDefined());
    channel.deliver({
      op: "put",
      path,
      hash: "local-hash",
      size: 5,
      version: 1,
      mutationId,
    });
    // A peer learned our opaque id from the first broadcast and reused it for
    // a later write. The second frame is not another copy of our receipt.
    channel.deliver({
      op: "put",
      path,
      hash: "peer-hash",
      size: 4,
      version: 2,
      mutationId,
    });
    ack.resolve({ version: 1, hash: "local-hash", size: 5 });
    await pushing;

    expect(bodyFetches).toBe(1);
    expect(layer.entries()[path]?.hash).toBe("peer-hash");
    expect(text(await layer.getBody(path))).toBe("peer");
    layer.close();
  });

  it("compares the first active echo with the eventual HTTP receipt", async () => {
    const ack = deferred<{ version: number; hash: string; size: number }>();
    let mutationId: string | undefined;
    const path = "symbol/R";
    const http = fakeHttp({
      putBody: async (_path, _body, id) => {
        mutationId = id;
        return ack.promise;
      },
      getManifest: async () => ({
        version: 2,
        entries: { [path]: { hash: "peer-hash", size: 4, mtime: 0 } },
      }),
      getBodies: async () => [[path, bytes("peer")]],
    });
    const { layer, channel } = await openLayer(http);

    const pushing = layer.push(path, bytes("local"));
    await vi.waitFor(() => expect(mutationId).toBeDefined());
    // Models reconnect loss of the genuine echo: the first observed frame under
    // our disclosed id belongs to a later write and disagrees with our ACK.
    channel.deliver({
      op: "put",
      path,
      hash: "peer-hash",
      size: 4,
      version: 2,
      mutationId,
    });
    ack.resolve({ version: 1, hash: "local-hash", size: 5 });
    await pushing;

    expect(layer.entries()[path]?.hash).toBe("peer-hash");
    expect(text(await layer.getBody(path))).toBe("peer");
    layer.close();
  });

  it("reconciles an echo when the HTTP receipt is lost", async () => {
    const ack = deferred<{ version: number; hash: string; size: number }>();
    let mutationId: string | undefined;
    const path = "symbol/R";
    const http = fakeHttp({
      putBody: async (_path, _body, id) => {
        mutationId = id;
        return ack.promise;
      },
      getManifest: async () => ({
        version: 2,
        entries: { [path]: { hash: "peer-hash", size: 4, mtime: 0 } },
      }),
      getBodies: async () => [[path, bytes("peer")]],
    });
    const { layer, channel } = await openLayer(http);

    const pushing = layer.push(path, bytes("local"));
    await vi.waitFor(() => expect(mutationId).toBeDefined());
    // With no HTTP receipt, this disclosed-id frame cannot prove which bytes
    // committed. It confirms durable success only; the snapshot supplies bytes.
    channel.deliver({
      op: "put",
      path,
      hash: "peer-hash",
      size: 4,
      version: 2,
      mutationId,
    });
    ack.reject(new Error("response lost"));
    await pushing;

    expect(layer.entries()[path]?.hash).toBe("peer-hash");
    expect(text(await layer.getBody(path))).toBe("peer");
    layer.close();
  });

  it("settles a hung PUT from its exact echo and releases the same-path FIFO", async () => {
    const path = "symbol/R";
    const store = memStore();
    const hung = deferred<{ version: number; hash: string; size: number }>();
    const tailAck = deferred<{ version: number; hash: string; size: number }>();
    let mutationId: string | undefined;
    let requestSignal: AbortSignal | undefined;
    let putCalls = 0;
    const http = fakeHttp({
      putBody: async (_path, _body, id, signal) => {
        putCalls++;
        if (putCalls === 1) {
          mutationId = id;
          requestSignal = signal;
          return hung.promise;
        }
        return tailAck.promise;
      },
      getManifest: async () => ({
        version: 2,
        entries: { [path]: { hash: "server-hash", size: 6, mtime: 0 } },
      }),
      getBodies: async () => [[path, bytes("server")]],
    });
    const { layer, channel } = await openLayer(
      http,
      undefined,
      store,
      manifest(0),
      undefined,
      1_000,
    );

    vi.useFakeTimers({ now: 0 });
    try {
      const first = layer.push(path, bytes("local"));
      const tail = layer.push(path, bytes("tail"));
      await vi.advanceTimersByTimeAsync(0);
      expect(mutationId).toBeDefined();
      expect(putCalls).toBe(1);

      channel.deliver({
        op: "put",
        path,
        hash: "echo-hash",
        size: 5,
        version: 2,
        mutationId,
      });
      await vi.advanceTimersByTimeAsync(0);
      await first;

      expect(Date.now()).toBe(0);
      expect(requestSignal?.aborted).toBe(true);
      expect(putCalls).toBe(2);
      // The echo proved that a mutation committed, not which bytes now own the
      // path. The authoritative snapshot, rather than local/echo bytes, was
      // persisted before the queued tail started.
      expect(text(await store.getBody(path))).toBe("server");
      expect((await store.getManifest())?.entries[path]?.hash).toBe(
        "server-hash",
      );

      tailAck.resolve({ version: 3, hash: "tail-hash", size: 4 });
      await tail;
      expect(text(await layer.getBody(path))).toBe("tail");
    } finally {
      vi.useRealTimers();
      layer.close();
    }
  });

  it("settles a hung DELETE from its exact echo and releases the same-path FIFO", async () => {
    const path = "symbol/R";
    const initial: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "old-hash", size: 3, mtime: 0 } },
    };
    const store = memStore();
    await store.putBody(path, bytes("old"));
    const hung = deferred<{ version: number }>();
    const tailAck = deferred<{ version: number; hash: string; size: number }>();
    let mutationId: string | undefined;
    let requestSignal: AbortSignal | undefined;
    let putStarted = false;
    const http = fakeHttp({
      deleteBody: async (_path, id, signal) => {
        mutationId = id;
        requestSignal = signal;
        return hung.promise;
      },
      putBody: async () => {
        putStarted = true;
        return tailAck.promise;
      },
      getManifest: async () => manifest(2),
    });
    const { layer, channel } = await openLayer(
      http,
      undefined,
      store,
      initial,
      undefined,
      1_000,
    );

    vi.useFakeTimers({ now: 0 });
    try {
      const deleting = layer.delete(path);
      const tail = layer.push(path, bytes("next"));
      await vi.advanceTimersByTimeAsync(0);
      expect(mutationId).toBeDefined();
      expect(putStarted).toBe(false);

      channel.deliver({
        op: "del",
        path,
        version: 2,
        mutationId,
      });
      await vi.advanceTimersByTimeAsync(0);
      await deleting;

      expect(Date.now()).toBe(0);
      expect(requestSignal?.aborted).toBe(true);
      expect(await store.getBody(path)).toBeNull();
      expect((await store.getManifest())?.entries[path]).toBeUndefined();
      expect(putStarted).toBe(true);

      tailAck.resolve({ version: 3, hash: "next-hash", size: 4 });
      await tail;
      expect(text(await layer.getBody(path))).toBe("next");
    } finally {
      vi.useRealTimers();
      layer.close();
    }
  });

  it("does not settle a hung mutation from a mismatched disclosed-id echo", async () => {
    const path = "symbol/R";
    const hung = deferred<{ version: number; hash: string; size: number }>();
    let mutationId: string | undefined;
    let requestSignal: AbortSignal | undefined;
    const http = fakeHttp({
      putBody: async (_path, _body, id, signal) => {
        mutationId = id;
        requestSignal = signal;
        return hung.promise;
      },
      getManifest: async () => ({
        version: 3,
        entries: { [path]: { hash: "peer-hash", size: 4, mtime: 0 } },
      }),
      getBodies: async () => [[path, bytes("peer")]],
    });
    const { layer, channel } = await openLayer(
      http,
      undefined,
      memStore(),
      manifest(0),
      undefined,
      1_000,
    );

    vi.useFakeTimers({ now: 0 });
    try {
      let settled = false;
      const pushing = layer.push(path, bytes("local"));
      void pushing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mutationId).toBeDefined();

      // The id is disclosed, so it is only an exact correlation token when path
      // and operation also match. This DELETE must not release the PUT lane.
      channel.deliver({ op: "del", path, version: 2, mutationId });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      expect(requestSignal?.aborted).toBe(false);

      channel.deliver({
        op: "put",
        path,
        hash: "echo-hash",
        size: 5,
        version: 2,
        mutationId,
      });
      await vi.advanceTimersByTimeAsync(0);
      await pushing;

      expect(Date.now()).toBe(999);
      expect(requestSignal?.aborted).toBe(true);
      expect(text(await layer.getBody(path))).toBe("peer");
      expect(layer.entries()[path]?.hash).toBe("peer-hash");
    } finally {
      vi.useRealTimers();
      layer.close();
    }
  });

  it("rejects a hung mutation at its finite deadline when no exact echo exists", async () => {
    const path = "symbol/R";
    const hung = deferred<{ version: number; hash: string; size: number }>();
    const tailAck = deferred<{ version: number; hash: string; size: number }>();
    let requestSignal: AbortSignal | undefined;
    let putCalls = 0;
    const http = fakeHttp({
      putBody: async (_path, _body, _id, signal) => {
        putCalls++;
        if (putCalls === 1) {
          requestSignal = signal;
          return hung.promise;
        }
        return tailAck.promise;
      },
      getManifest: async () => manifest(0),
    });
    const { layer } = await openLayer(
      http,
      undefined,
      memStore(),
      manifest(0),
      undefined,
      1_000,
    );

    vi.useFakeTimers({ now: 0 });
    try {
      const first = layer.push(path, bytes("lost"));
      const rejected = expect(first).rejects.toThrow(
        "mutation receipt deadline (1000 ms)",
      );
      const tail = layer.push(path, bytes("tail"));
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;

      expect(requestSignal?.aborted).toBe(true);
      expect(putCalls).toBe(2);
      tailAck.resolve({ version: 1, hash: "tail-hash", size: 4 });
      await tail;
      expect(text(await layer.getBody(path))).toBe("tail");
    } finally {
      vi.useRealTimers();
      layer.close();
    }
  });

  it("recognizes its exact id after a full sync without retaining receipts", async () => {
    const path = "symbol/R";
    const changes: LayerChange[] = [];
    let bodyFetches = 0;
    let mutationId: string | undefined;
    const http = fakeHttp({
      getManifest: async () => ({
        version: 1,
        entries: { [path]: { hash: "local-hash", size: 5, mtime: 0 } },
      }),
      putBody: async (_path, _body, id) => {
        mutationId = id;
        return { version: 1, hash: "local-hash", size: 5 };
      },
      getBodies: async () => {
        bodyFetches++;
        return [[path, bytes("peer")]];
      },
    });
    const { layer, channel } = await openLayer(http, (change) =>
      changes.push(change),
    );

    await layer.push(path, bytes("local"));
    // The self echo is lost. This authoritative snapshot releases the retained
    // mutation body and leaves only a bounded exact-echo tombstone.
    await layer.sync();

    channel.deliver({
      op: "put",
      path,
      hash: "peer-hash",
      size: 4,
      version: 2,
    });
    await vi.waitFor(() => expect(layer.entries()[path]?.hash).toBe("peer-hash"));
    expect(bodyFetches).toBe(1);

    // The delayed pre-barrier echo must neither refetch nor reinstall local.
    channel.deliver({
      op: "put",
      path,
      hash: "local-hash",
      size: 5,
      version: 1,
      mutationId,
    });
    expect(bodyFetches).toBe(1);
    expect(text(await layer.getBody(path))).toBe("peer");
    expect(layer.entries()[path]?.hash).toBe("peer-hash");
    expect(changes.map((change) => change.origin)).toEqual(["local", "remote"]);
  });

  it("retains no receipt or path state for no-op deletes without echoes", async () => {
    const count = 300;
    let version = 0;
    const http = fakeHttp({
      deleteBody: async () => ({ version: ++version }),
      getManifest: async () => ({ version, entries: {} }),
    });
    const { layer } = await openLayer(http);

    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        layer.delete(`symbol/deleted-${index}`),
      ),
    );
    const internals = layer as unknown as {
      activeMutations: Map<string, unknown>;
      paths: Map<string, unknown>;
      localPathLanes: Map<string, unknown>;
      optimistic: Map<string, unknown>;
    };
    expect(internals.activeMutations.size).toBe(0);
    expect(internals.paths.size).toBe(0);
    expect(internals.localPathLanes.size).toBe(0);
    expect(internals.optimistic.size).toBe(0);
  });

  it("cleans a failed mutation and keeps its same-path tail usable", async () => {
    let attempt = 0;
    const http = fakeHttp({
      putBody: async (_path, body) => {
        if (++attempt === 1) throw new Error("first write failed");
        return { version: 1, hash: "ok", size: body.length };
      },
    });
    const { layer } = await openLayer(http);

    await expect(layer.push("symbol/R", bytes("bad"))).rejects.toThrow(
      "first write failed",
    );
    expect(await layer.getBody("symbol/R")).toBeNull();
    await layer.push("symbol/R", bytes("good"));

    expect(text(await layer.getBody("symbol/R"))).toBe("good");
    expect(layer.entries()["symbol/R"]?.hash).toBe("ok");
    const internals = layer as unknown as {
      activeMutations: Map<string, unknown>;
      paths: Map<string, unknown>;
      optimistic: Map<string, unknown>;
      localPathLanes: Map<string, unknown>;
      localMutationCount: number;
      localMutationBodyBytes: number;
    };
    expect(internals.activeMutations.size).toBe(0);
    expect(internals.paths.size).toBe(0);
    expect(internals.optimistic.size).toBe(0);
    expect(internals.localPathLanes.size).toBe(0);
    expect(internals.localMutationCount).toBe(0);
    expect(internals.localMutationBodyBytes).toBe(0);
  });

  it("does not regress v2 to v1 when independent local acks reverse", async () => {
    const requests = new Map<
      string,
      ReturnType<typeof deferred<{ version: number; hash: string; size: number }>>
    >();
    const http = fakeHttp({
      putBody: async (path) => {
        const request = deferred<{ version: number; hash: string; size: number }>();
        requests.set(path, request);
        return request.promise;
      },
    });
    const { layer } = await openLayer(http);

    const older = layer.push("symbol/R", bytes("R"));
    const newer = layer.push("symbol/C", bytes("C"));
    await vi.waitFor(() => expect(requests.size).toBe(2));
    requests.get("symbol/C")!.resolve({ version: 2, hash: "c", size: 1 });
    await newer;
    expect(layer.version()).toBe(2);
    requests.get("symbol/R")!.resolve({ version: 1, hash: "r", size: 1 });
    await older;

    expect(layer.version()).toBe(2);
    expect(layer.entries()["symbol/R"]?.hash).toBe("r");
    expect(layer.entries()["symbol/C"]?.hash).toBe("c");
  });

  it("rejects a sparse body response after its manifest hash changed", async () => {
    const path = "model3d/a.step";
    const oldBody = deferred<Uint8Array>();
    let manifestPass = 0;
    const sparseManifest = (version: number, hash: string): SyncManifest => ({
      version,
      entries: { [path]: { hash, size: 3, mtime: 0 } },
    });
    const http = fakeHttp({
      getManifest: async () =>
        ++manifestPass === 1
          ? sparseManifest(1, "old-hash")
          : sparseManifest(2, "new-hash"),
      getBodyFromUrl: async (url) =>
        url.includes("old-hash") ? oldBody.promise : bytes("new"),
    });
    const store = memStore();
    const layer = new SyncLayer({
      namespace: "sparse",
      kind: "sparse",
      writable: false,
      store,
      http,
      bodyUrlTemplate: "https://body/{hash}/{path}",
    });
    await layer.open();

    const staleRead = layer.getBody(path);
    await layer.sync();
    oldBody.resolve(bytes("old"));
    expect(await staleRead).toBeNull();
    expect(text(await layer.getBody(path))).toBe("new");
    expect(layer.entries()[path]?.hash).toBe("new-hash");
  });

  it("does not publish a stale sparse body over a newer shared-store entry", async () => {
    const path = "model3d/a.step";
    const oldBody = deferred<Uint8Array>();
    const requestStarted = deferred<void>();
    const bodyRequests: string[] = [];
    const oldManifest: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "old-hash", size: 3, mtime: 0 } },
    };
    const newManifest: SyncManifest = {
      version: 2,
      entries: { [path]: { hash: "new-hash", size: 3, mtime: 1 } },
    };
    const store = memStore();
    const layer = new SyncLayer({
      namespace: "sparse",
      kind: "sparse",
      writable: false,
      store,
      http: fakeHttp({
        getManifest: async () => oldManifest,
        getBodyFromUrl: async (url) => {
          bodyRequests.push(url);
          if (url.includes("old-hash")) {
            requestStarted.resolve();
            return oldBody.promise;
          }
          return bytes("new");
        },
      }),
      bodyUrlTemplate: "https://body/{hash}/{path}",
    });
    await layer.open();

    const staleRead = layer.getBody(path);
    await requestStarted.promise;
    // Model a second layer lifetime publishing a newer same-path manifest
    // while this lifetime's old body request is still on the network.
    await store.apply({
      deletes: [path],
      manifest: newManifest,
      manifestPaths: [path],
    });
    oldBody.resolve(bytes("old"));

    expect(await staleRead).toBeNull();
    expect(await store.getBody(path)).toBeNull();
    expect(await store.getManifest()).toEqual(newManifest);

    // The losing lifetime adopts the shared-store winner. Its next read asks
    // for B rather than retrying A forever, and can publish B normally.
    expect(layer.entries()[path]?.hash).toBe("new-hash");
    expect(text(await layer.getBody(path))).toBe("new");
    expect(text(await store.getBody(path))).toBe("new");
    expect(bodyRequests).toEqual([
      expect.stringContaining("old-hash"),
      expect.stringContaining("new-hash"),
    ]);
    layer.close();
  });

  it("blocks a closed layer's late response from corrupting a reopened store", async () => {
    const path = "symbol/R";
    const lateBody = deferred<Array<[string, Uint8Array]>>();
    const store = memStore();
    const oldChanges: LayerChange[] = [];
    const oldHttp = fakeHttp({ getBodies: async () => lateBody.promise });
    const old = await openLayer(oldHttp, (change) => oldChanges.push(change), store);

    old.channel.deliver({
      op: "put",
      path,
      hash: "old-hash",
      size: 3,
      version: 1,
    });
    old.layer.close();

    const reopened = await openLayer(
      fakeHttp({ getBodies: async () => [[path, bytes("new")]] }),
      undefined,
      store,
    );
    reopened.channel.deliver({
      op: "put",
      path,
      hash: "new-hash",
      size: 3,
      version: 2,
    });
    await vi.waitFor(() =>
      expect(reopened.layer.entries()[path]?.hash).toBe("new-hash"),
    );

    lateBody.resolve([[path, bytes("old")]]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldChanges).toHaveLength(0);
    expect(text(await reopened.layer.getBody(path))).toBe("new");
    expect(reopened.layer.entries()[path]?.hash).toBe("new-hash");
  });

  it("keeps an accepted older commit coherent when the newer fetch fails", async () => {
    const path = "symbol/R";
    const initial: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "a", size: 1, mtime: 0 } },
    };
    const backing = memStore();
    await backing.putBody(path, bytes("A"));
    const entered = deferred<void>();
    const release = deferred<void>();
    let firstApply = true;
    let blockApply = false;
    const store: LayerStore = {
      ...backing,
      apply: async (commit) => {
        if (blockApply && firstApply) {
          firstApply = false;
          entered.resolve();
          await release.promise;
        }
        await backing.apply(commit);
      },
    };
    let bodyRequest = 0;
    const http = fakeHttp({
      getBodies: async (entries) => {
        const requested = entries[0]!.path;
        bodyRequest++;
        if (bodyRequest === 1) return [[requested!, bytes("B")]];
        throw new Error("newer body failed");
      },
      getManifest: async () => {
        throw new Error("recovery snapshot failed");
      },
    });
    const changes: LayerChange[] = [];
    const { layer, channel } = await openLayer(
      http,
      (change) => changes.push(change),
      store,
      initial,
    );
    blockApply = true;

    channel.deliver({ op: "put", path, hash: "b", size: 1, version: 2 });
    await entered.promise;
    channel.deliver({ op: "put", path, hash: "c", size: 1, version: 3 });
    release.resolve();
    await vi.waitFor(() => expect(bodyRequest).toBe(2));
    await vi.waitFor(() => expect(changes).toHaveLength(1));

    expect(layer.entries()[path]?.hash).toBe("b");
    expect(text(await layer.getBody(path))).toBe("B");
    expect((await store.getManifest())?.entries[path]?.hash).toBe("b");
    layer.close();
  });

  it("queues a reopened lifetime behind an accepted old atomic commit", async () => {
    const path = "symbol/R";
    const initial: SyncManifest = {
      version: 1,
      entries: { [path]: { hash: "a", size: 1, mtime: 0 } },
    };
    const backing = memStore();
    await backing.putBody(path, bytes("A"));
    await backing.setManifest(initial);
    const entered = deferred<void>();
    const release = deferred<void>();
    let invocations = 0;
    let blockWrites = false;
    let lane = Promise.resolve();
    const store: LayerStore = {
      ...backing,
      apply(commit: LayerStoreCommit) {
        const invocation = ++invocations;
        const result = lane.then(async () => {
          if (blockWrites && invocation === 2) {
            entered.resolve();
            await release.promise;
          }
          await backing.apply(commit);
        });
        lane = result.catch(() => {});
        return result;
      },
    };

    const oldChannel = new ManualChannel();
    const oldChanges: LayerChange[] = [];
    const oldLayer = new SyncLayer({
      namespace: "test",
      kind: "live",
      writable: true,
      store,
      http: fakeHttp({
        getManifest: async () => initial,
        getBodies: async () => [[path, bytes("OLD")]],
      }),
      channel: oldChannel,
      onChange: (change) => oldChanges.push(change),
    });
    await oldLayer.open();
    blockWrites = true;
    oldChannel.deliver({ op: "put", path, hash: "old", size: 3, version: 2 });
    await entered.promise;
    oldLayer.close();

    const newChannel = new ManualChannel();
    const newChanges: LayerChange[] = [];
    const newLayer = new SyncLayer({
      namespace: "test",
      kind: "live",
      writable: true,
      store,
      http: fakeHttp({
        getManifest: async () => ({
          version: 3,
          entries: { [path]: { hash: "new", size: 3, mtime: 0 } },
        }),
        getBodies: async () => [[path, bytes("NEW")]],
      }),
      channel: newChannel,
      onChange: (change) => newChanges.push(change),
    });
    const reopening = newLayer.open();

    // The new lifetime's authoritative open has submitted while the old
    // accepted commit is blocked. The shared store lane fixes publication order.
    await vi.waitFor(() => expect(invocations).toBe(3));
    release.resolve();
    await reopening;

    expect(oldChanges).toHaveLength(0);
    expect(newLayer.entries()[path]?.hash).toBe("new");
    expect(text(await newLayer.getBody(path))).toBe("NEW");
    expect((await store.getManifest())?.entries[path]?.hash).toBe("new");
    newLayer.close();
  });

  it("uses writer identity instead of a resettable version/hash tuple", async () => {
    const path = "symbol/R";
    const changes: LayerChange[] = [];
    let ownId: string | undefined;
    let remoteBody = "peer";
    let bodyFetches = 0;
    const http = fakeHttp({
      putBody: async (_path, body, id) => {
        ownId = id;
        return { version: 1, hash: "same-hash", size: body.length };
      },
      getBodies: async (entries) => {
        const requested = entries[0]!.path;
        bodyFetches++;
        return [[requested!, bytes(remoteBody)]];
      },
    });
    const { layer, channel } = await openLayer(http, (change) =>
      changes.push(change),
    );
    await layer.push(path, bytes("local"));

    channel.deliver({
      op: "put",
      path,
      hash: "peer-hash",
      size: 4,
      version: 2,
      mutationId: "peer:2",
    });
    await vi.waitFor(() => expect(layer.entries()[path]?.hash).toBe("peer-hash"));

    // A rebuilt server can reuse version 1 and the same content hash. This is a
    // peer operation because its opaque writer id is different from ours.
    remoteBody = "local";
    channel.deliver({
      op: "put",
      path,
      hash: "same-hash",
      size: 5,
      version: 1,
      mutationId: "peer-after-reset:1",
    });
    await vi.waitFor(() => expect(layer.entries()[path]?.hash).toBe("same-hash"));

    // The genuinely old own echo has our writer prefix and is ignored exactly.
    channel.deliver({
      op: "put",
      path,
      hash: "same-hash",
      size: 5,
      version: 1,
      mutationId: ownId,
    });
    expect(bodyFetches).toBe(2);
    expect(changes.map((change) => change.origin)).toEqual([
      "local",
      "remote",
      "remote",
    ]);
  });

  it("repairs a warm same-version cache before the first websocket hello", async () => {
    const path = "symbol/R";
    const store = memStore();
    await store.setManifest({
      version: 1,
      entries: { [path]: { hash: "old", size: 3, mtime: 0 } },
    });
    await store.putBody(path, bytes("old"));
    const requests: Array<{ path: string; hash: string }> = [];
    const channel = new ManualChannel();
    const layer = new SyncLayer({
      namespace: "test",
      kind: "live",
      writable: true,
      store,
      channel,
      http: fakeHttp({
        getManifest: async () => ({
          version: 1,
          entries: { [path]: { hash: "new", size: 3, mtime: 0 } },
        }),
        getBodies: async (entries) => {
          requests.push(...entries);
          return [[path, bytes("new")]];
        },
      }),
    });

    await layer.open();

    expect(requests).toEqual([{ path, hash: "new" }]);
    expect(layer.entries()[path]?.hash).toBe("new");
    expect(text(await layer.getBody(path))).toBe("new");
    expect(channel.sent).toEqual([{ t: "hello", sinceVersion: 1 }]);
    layer.close();
  });

  it("authoritatively refreshes before hello on attach and reconnect", async () => {
    const path = "symbol/R";
    const store = memStore();
    await store.setManifest({
      version: 1,
      entries: { [path]: { hash: "old", size: 3, mtime: 0 } },
    });
    await store.putBody(path, bytes("old"));
    let remoteHash = "old";
    const layer = new SyncLayer({
      namespace: "test",
      kind: "live",
      writable: true,
      store,
      http: fakeHttp({
        getManifest: async () => ({
          version: 1,
          entries: { [path]: { hash: remoteHash, size: remoteHash.length, mtime: 0 } },
        }),
        getBodies: async (entries) => [
          [entries[0]!.path, bytes(remoteHash)],
        ],
      }),
    });
    await layer.open();

    remoteHash = "attached";
    const channel = new ManualChannel();
    layer.attachChannel(channel);
    await vi.waitFor(() => expect(layer.entries()[path]?.hash).toBe("attached"));
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));

    remoteHash = "reconnected";
    channel.reopen();
    await vi.waitFor(() => expect(layer.entries()[path]?.hash).toBe("reconnected"));
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    layer.close();
  });

  it("coalesces a transient failure into one bounded-backoff repair", async () => {
    vi.useFakeTimers();
    try {
      const path = "symbol/R";
      let bodyCalls = 0;
      const { layer, channel } = await openLayer(
        fakeHttp({
          getManifest: async () => ({
            version: 1,
            entries: { [path]: { hash: "repaired", size: 8, mtime: 0 } },
          }),
          getBodies: async () => {
            bodyCalls++;
            if (bodyCalls <= 2) throw new Error("transient");
            return [[path, bytes("repaired")]];
          },
        }),
      );

      channel.deliver({
        op: "put",
        path,
        hash: "repaired",
        size: 8,
        version: 1,
      });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(bodyCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(bodyCalls).toBe(3);
      expect(layer.entries()[path]?.hash).toBe("repaired");
      expect(text(await layer.getBody(path))).toBe("repaired");
      expect(vi.getTimerCount()).toBe(0);
      layer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds distinct pending realtime paths and requests one repair", async () => {
    vi.useFakeTimers();
    try {
      let bodyCalls = 0;
      const never = new Promise<Array<[string, Uint8Array]>>(() => {});
      const { layer, channel } = await openLayer(
        fakeHttp({
          getBodies: async () => {
            bodyCalls++;
            return never;
          },
        }),
      );

      for (let index = 0; index < 300; index++) {
        channel.deliver({
          op: "put",
          path: `symbol/${index}`,
          hash: `hash-${index}`,
          size: 1,
          version: index + 1,
        });
      }

      const internals = layer as unknown as { remotePaths: Map<string, unknown> };
      expect(bodyCalls).toBe(256);
      expect(internals.remotePaths.size).toBe(256);
      expect(vi.getTimerCount()).toBe(1);
      layer.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one final repair when requests arrive during the active pass", async () => {
    vi.useFakeTimers();
    try {
      const firstStarted = deferred<void>();
      const releaseFirst = deferred<void>();
      let manifestCalls = 0;
      const { layer } = await openLayer(
        fakeHttp({
          getManifest: async () => {
            manifestCalls++;
            if (manifestCalls === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            }
            return manifest(0);
          },
        }),
      );
      const internals = layer as unknown as {
        requestRepair(): void;
        repairRunning: boolean;
      };

      internals.requestRepair();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await firstStarted.promise;
      expect(internals.repairRunning).toBe(true);

      for (let index = 0; index < 20; index++) internals.requestRepair();
      releaseFirst.resolve();
      for (let index = 0; index < 20 && internals.repairRunning; index++) {
        await Promise.resolve();
      }

      expect(internals.repairRunning).toBe(false);
      expect(manifestCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(manifestCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(manifestCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      layer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("body-size integrity", () => {
    it("rejects a malformed full-sync body atomically and accepts an exact retry", async () => {
      const path = "symbol/R";
      const remote: SyncManifest = {
        version: 1,
        entries: { [path]: { hash: "hash-good", size: 4, mtime: 0 } },
      };
      let responseBody = bytes("bad");
      const changes: LayerChange[] = [];
      const store = memStore();
      const { layer } = await openLayer(
        fakeHttp({
          getManifest: async () => remote,
          getBodies: async () => [[path, responseBody]],
        }),
        (change) => changes.push(change),
        store,
      );

      await expect(layer.sync()).rejects.toThrow(
        "full sync body size 3 does not match advertised size 4",
      );
      expect(layer.entries()[path]).toBeUndefined();
      expect(await store.getBody(path)).toBeNull();
      expect((await store.getManifest())?.entries[path]).toBeUndefined();
      expect(changes).toEqual([]);

      responseBody = bytes("good");
      await layer.sync();

      expect(text(await layer.getBody(path))).toBe("good");
      expect(layer.entries()[path]).toEqual(remote.entries[path]);
      expect(changes).toEqual([
        {
          op: "put",
          path,
          hash: "hash-good",
          size: 4,
          version: 1,
          origin: "remote",
        },
      ]);
      layer.close();
    });

    it("drops a malformed realtime body and accepts the next exact body", async () => {
      const path = "symbol/R";
      let responseBody = bytes("bad");
      const changes: LayerChange[] = [];
      const { layer, channel } = await openLayer(
        fakeHttp({
          getManifest: async () => manifest(0),
          getBodies: async () => [[path, responseBody]],
        }),
        (change) => changes.push(change),
      );
      const internals = layer as unknown as {
        remotePaths: Map<string, unknown>;
      };

      channel.deliver({
        op: "put",
        path,
        hash: "hash-bad",
        size: 4,
        version: 1,
      });
      await vi.waitFor(() => expect(internals.remotePaths.size).toBe(0));
      expect(layer.entries()[path]).toBeUndefined();
      expect(await layer.getBody(path)).toBeNull();
      expect(changes).toEqual([]);

      responseBody = bytes("good");
      channel.deliver({
        op: "put",
        path,
        hash: "hash-good",
        size: 4,
        version: 2,
      });
      await vi.waitFor(() =>
        expect(layer.entries()[path]?.hash).toBe("hash-good"),
      );

      expect(text(await layer.getBody(path))).toBe("good");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        op: "put",
        path,
        hash: "hash-good",
        size: 4,
        version: 2,
        origin: "remote",
      });
      layer.close();
    });

    it.each([
      { source: "content URL" as const },
      { source: "batch endpoint" as const },
    ])(
      "drops a malformed sparse body from the $source and accepts an exact retry",
      async ({ source }) => {
        const path = "model3d/a.step";
        const remote: SyncManifest = {
          version: 1,
          entries: { [path]: { hash: "hash-good", size: 4, mtime: 0 } },
        };
        let attempts = 0;
        const nextBody = () => bytes(++attempts === 1 ? "bad" : "good");
        const store = memStore();
        const layer = new SyncLayer({
          namespace: "sparse",
          kind: "sparse",
          writable: false,
          store,
          http: fakeHttp({
            getManifest: async () => remote,
            getBodyFromUrl: async () => nextBody(),
            getBodies: async (entries) => [
              [entries[0]!.path, nextBody()],
            ],
          }),
          ...(source === "content URL"
            ? { bodyUrlTemplate: "https://body/{hash}/{path}" }
            : {}),
        });
        await layer.open();

        expect(await layer.getBody(path)).toBeNull();
        expect(await store.getBody(path)).toBeNull();
        expect(attempts).toBe(1);

        expect(text(await layer.getBody(path))).toBe("good");
        expect(text(await store.getBody(path))).toBe("good");
        expect(attempts).toBe(2);
        layer.close();
      },
    );

    it("reconciles an inconsistent local PUT receipt without publishing it", async () => {
      const path = "symbol/R";
      const authoritative: SyncManifest = {
        version: 1,
        entries: { [path]: { hash: "server-hash", size: 5, mtime: 0 } },
      };
      const changes: LayerChange[] = [];
      let manifestCalls = 0;
      let bodyCalls = 0;
      const store = memStore();
      const { layer } = await openLayer(
        fakeHttp({
          putBody: async () => ({
            version: 1,
            hash: "server-hash",
            size: 999,
          }),
          getManifest: async () => {
            manifestCalls++;
            return authoritative;
          },
          getBodies: async () => {
            bodyCalls++;
            return [[path, bytes("local")]];
          },
        }),
        (change) => changes.push(change),
        store,
      );

      await layer.push(path, bytes("local"));

      expect(manifestCalls).toBe(1);
      expect(bodyCalls).toBe(1);
      expect(text(await layer.getBody(path))).toBe("local");
      expect(layer.entries()[path]).toEqual(authoritative.entries[path]);
      expect((await store.getManifest())?.entries[path]).toEqual(
        authoritative.entries[path],
      );
      expect(changes).toEqual([
        {
          op: "put",
          path,
          hash: "server-hash",
          size: 5,
          version: 1,
          origin: "remote",
        },
      ]);
      layer.close();
    });

    it("publishes an exact local PUT receipt without a reconciliation fetch", async () => {
      const path = "symbol/R";
      const changes: LayerChange[] = [];
      let manifestCalls = 0;
      let bodyCalls = 0;
      const { layer } = await openLayer(
        fakeHttp({
          putBody: async () => ({
            version: 1,
            hash: "local-hash",
            size: 5,
          }),
          getManifest: async () => {
            manifestCalls++;
            return manifest(0);
          },
          getBodies: async () => {
            bodyCalls++;
            return [];
          },
        }),
        (change) => changes.push(change),
      );

      await layer.push(path, bytes("local"));

      expect(manifestCalls).toBe(0);
      expect(bodyCalls).toBe(0);
      expect(text(await layer.getBody(path))).toBe("local");
      expect(layer.entries()[path]).toMatchObject({
        hash: "local-hash",
        size: 5,
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        op: "put",
        path,
        hash: "local-hash",
        size: 5,
        version: 1,
        origin: "local",
      });
      layer.close();
    });
  });

  const invalidBundles: Array<{
    defect: string;
    snapshot: Awaited<ReturnType<LayerHttp["getBundle"]>>;
  }> = [
    {
      defect: "a missing body",
      snapshot: {
        manifest: {
          version: 1,
          entries: {
            a: { hash: "hash-a", size: 1, mtime: 0 },
            b: { hash: "hash-b", size: 1, mtime: 0 },
          },
        },
        bodies: [["a", bytes("A")]] as Array<[string, Uint8Array]>,
      },
    },
    {
      defect: "a duplicate body",
      snapshot: {
        manifest: {
          version: 1,
          entries: {
            a: { hash: "hash-a", size: 1, mtime: 0 },
            b: { hash: "hash-b", size: 1, mtime: 0 },
          },
        },
        bodies: [
          ["a", bytes("A")],
          ["a", bytes("A")],
        ] as Array<[string, Uint8Array]>,
      },
    },
    {
      defect: "an unadvertised body",
      snapshot: {
        manifest: {
          version: 1,
          entries: { a: { hash: "hash-a", size: 1, mtime: 0 } },
        },
        bodies: [["x", bytes("X")]] as Array<[string, Uint8Array]>,
      },
    },
    {
      defect: "a body-size mismatch",
      snapshot: {
        manifest: {
          version: 1,
          entries: { a: { hash: "hash-a", size: 2, mtime: 0 } },
        },
        bodies: [["a", bytes("A")]] as Array<[string, Uint8Array]>,
      },
    },
  ];

  it.each(invalidBundles)(
    "rejects a cold bundle with $defect before publishing it",
    async ({ snapshot }) => {
      const store = memStore();
      const layer = new SyncLayer({
        namespace: "cold",
        kind: "static",
        writable: false,
        store,
        http: fakeHttp({ getBundle: async () => snapshot }),
      });

      await expect(layer.open()).rejects.toThrow(/bundle/);
      expect(await store.getManifest()).toBeNull();
      expect(await store.getAllBodies()).toEqual(new Map());
      layer.close();
    },
  );

  it("does not expose the retained optimistic body through readAll", async () => {
    const started = deferred<void>();
    const receipt = deferred<{ version: number; hash: string; size: number }>();
    let submitted: Uint8Array | undefined;
    const { layer } = await openLayer(
      fakeHttp({
        putBody: async (_path, body) => {
          submitted = body;
          started.resolve();
          return receipt.promise;
        },
      }),
    );

    const pushing = layer.push("symbol/R", bytes("ABC"));
    await started.promise;
    const snapshot = await layer.readAll();
    snapshot.get("symbol/R")![0] = "X".charCodeAt(0);

    expect(text(await layer.getBody("symbol/R"))).toBe("ABC");
    expect(text(submitted!)).toBe("ABC");
    receipt.resolve({ version: 1, hash: "hash-abc", size: 3 });
    await pushing;
    layer.close();
  });

  it("still accepts a changed manifest whose numeric version reset lower", async () => {
    let pass = 0;
    const entry = (hash: string) => ({ hash, size: 3, mtime: 0 });
    const http = fakeHttp({
      getManifest: async () => {
        pass++;
        return pass === 1
          ? { version: 9, entries: { "symbol/R": entry("old") } }
          : { version: 1, entries: { "symbol/R": entry("new") } };
      },
      getBodies: async (entries) => [
        [entries[0]!.path, bytes(pass === 1 ? "old" : "new")],
      ],
    });
    const { layer } = await openLayer(http);

    await layer.sync();
    expect(layer.version()).toBe(9);
    await layer.sync();

    expect(layer.version()).toBe(1);
    expect(layer.entries()["symbol/R"]?.hash).toBe("new");
    expect(text(await layer.getBody("symbol/R"))).toBe("new");
  });
});
