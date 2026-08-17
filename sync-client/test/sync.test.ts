import { manifestDigest, type LayerDescriptor } from "@pcbjam/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  memStore,
  SyncStack,
  type LayerChange,
  type LayerStore,
  type RealtimeChannel,
} from "../src/index.js";
import { FakeCloud, settle } from "./fake-server.js";

const enc = new TextEncoder();
const body = (s: string) => enc.encode(s);
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

const MIRROR = "http://mirror";
const ORIGIN = "http://origin";

const liveMirror = (
  url = MIRROR,
  ns = "mirror:p1",
  writable = true,
): LayerDescriptor => ({ namespace: ns, kind: "live", url, writable });
const staticOrigin = (): LayerDescriptor => ({
  namespace: "origin:R@v1",
  kind: "static",
  url: ORIGIN,
});

/** One "browser": a persistent per-namespace store map shared across reopens. */
function browser() {
  const stores = new Map<string, LayerStore>();
  const stack = (cloud: FakeCloud, layers: LayerDescriptor[]) =>
    new SyncStack({
      layers,
      fetchImpl: cloud.fetchImpl,
      channelFactory: cloud.channelFactory,
      storeFactory: (ns) => {
        let s = stores.get(ns);
        if (!s) stores.set(ns, (s = memStore()));
        return s;
      },
    });
  return { stores, stack };
}

describe("cold init", () => {
  let cloud: FakeCloud;
  beforeEach(() => {
    cloud = new FakeCloud();
  });

  it("hydrates from ONE bundle fetch, zero per-item gets", async () => {
    await cloud.server(MIRROR).seed("symbol/R", body("(R)"));
    await cloud.server(MIRROR).seed("symbol/C", body("(C)"));

    const s = browser().stack(cloud, [liveMirror()]);
    await s.open();

    expect((await s.list()).map((e) => e.path).sort()).toEqual([
      "symbol/C",
      "symbol/R",
    ]);
    expect(text(await s.read("symbol/R"))).toBe("(R)");
    expect(cloud.server(MIRROR).bundleFetches).toBe(1);
    expect(cloud.server(MIRROR).bodyFetches).toBe(0);
  });

  it("warm reopen reuses the cache — no bundle, no body fetches", async () => {
    await cloud.server(MIRROR).seed("symbol/R", body("(R)"));
    const b = browser();
    await b.stack(cloud, [liveMirror()]).open();

    const reopened = b.stack(cloud, [liveMirror()]); // same store map
    await reopened.open();

    expect(text(await reopened.read("symbol/R"))).toBe("(R)");
    expect(cloud.server(MIRROR).bundleFetches).toBe(1); // not 2
    expect(cloud.server(MIRROR).bodyFetches).toBe(0);
  });
});

describe("digest-stamped descriptors", () => {
  let cloud: FakeCloud;
  beforeEach(async () => {
    cloud = new FakeCloud();
    await cloud.server(ORIGIN).seed("symbol/R", body("origin-R"));
  });

  it("a matching digest proves the warm layer current — zero requests", async () => {
    const b = browser();
    await b.stack(cloud, [staticOrigin()]).open(); // cold: one bundle

    const digest = await manifestDigest(cloud.server(ORIGIN).manifest);
    const reopened = b.stack(cloud, [{ ...staticOrigin(), digest }]);
    await reopened.open();

    expect(text(await reopened.read("symbol/R"))).toBe("origin-R");
    expect(cloud.server(ORIGIN).manifestFetches).toBe(0);
    expect(cloud.server(ORIGIN).bundleFetches).toBe(1);
  });

  it("a mismatched digest falls back to the manifest sync", async () => {
    const b = browser();
    await b.stack(cloud, [staticOrigin()]).open();
    // Server content moved after our cold open — the descriptor now carries
    // the NEW digest, which no longer matches our cached manifest.
    await cloud.server(ORIGIN).seed("symbol/R", body("origin-R2"));

    const digest = await manifestDigest(cloud.server(ORIGIN).manifest);
    const reopened = b.stack(cloud, [{ ...staticOrigin(), digest }]);
    await reopened.open();

    expect(cloud.server(ORIGIN).manifestFetches).toBe(1);
    expect(text(await reopened.read("symbol/R"))).toBe("origin-R2");
  });

  it("no digest (older backend) keeps today's manifest sync", async () => {
    const b = browser();
    await b.stack(cloud, [staticOrigin()]).open();
    const reopened = b.stack(cloud, [staticOrigin()]);
    await reopened.open();
    expect(cloud.server(ORIGIN).manifestFetches).toBe(1);
  });

  it("never trusts a digest for a channel-less live layer", async () => {
    await cloud.server(MIRROR).seed("symbol/R", body("live-R"));
    const b = browser();
    const first = b.stack(cloud, [liveMirror()]);
    await first.open();
    first.close();

    const server = cloud.server(MIRROR);
    const digest = await manifestDigest(server.manifest);
    server.manifestFetches = 0;
    const store = b.stores.get("mirror:p1")!;
    const reopened = new SyncStack({
      layers: [{ ...liveMirror(), digest }],
      fetchImpl: cloud.fetchImpl,
      channelFactory: cloud.channelFactory,
      storeFactory: () => store,
      realtime: "shared-only",
    });
    await reopened.open();

    // Loading a live manifest is also the server-side dirty-state recovery
    // trigger, so an external digest must never suppress this request.
    expect(server.manifestFetches).toBe(1);
    expect(text(await reopened.read("symbol/R"))).toBe("live-R");
    reopened.close();
  });
});

describe("immutable descriptors (version-pinned statics)", () => {
  let cloud: FakeCloud;
  beforeEach(async () => {
    cloud = new FakeCloud();
    await cloud.server(ORIGIN).seed("symbol/R", body("origin-R"));
  });

  it("a stored snapshot proves the warm layer current — zero requests, no digest", async () => {
    const b = browser();
    await b.stack(cloud, [{ ...staticOrigin(), immutable: true }]).open(); // cold: one bundle

    const reopened = b.stack(cloud, [{ ...staticOrigin(), immutable: true }]);
    await reopened.open();

    expect(text(await reopened.read("symbol/R"))).toBe("origin-R");
    expect(cloud.server(ORIGIN).manifestFetches).toBe(0);
    expect(cloud.server(ORIGIN).bundleFetches).toBe(1);
  });

  it("cold open still fetches the bundle", async () => {
    const b = browser();
    const s = b.stack(cloud, [{ ...staticOrigin(), immutable: true }]);
    await s.open();
    expect(cloud.server(ORIGIN).bundleFetches).toBe(1);
    expect(text(await s.read("symbol/R"))).toBe("origin-R");
  });

  it("never suppresses the manifest GET for a channel-less live layer", async () => {
    await cloud.server(MIRROR).seed("symbol/R", body("live-R"));
    const b = browser();
    const first = b.stack(cloud, [liveMirror()]);
    await first.open();
    first.close();

    const server = cloud.server(MIRROR);
    server.manifestFetches = 0;
    const store = b.stores.get("mirror:p1")!;
    const reopened = new SyncStack({
      layers: [{ ...liveMirror(), immutable: true }],
      fetchImpl: cloud.fetchImpl,
      channelFactory: cloud.channelFactory,
      storeFactory: () => store,
      realtime: "shared-only",
    });
    await reopened.open();

    // Same rationale as `digest`: loading a live manifest doubles as the
    // server-side dirty-state recovery trigger.
    expect(server.manifestFetches).toBe(1);
    reopened.close();
  });

  it("is ignored for sparse layers — their manifest still syncs on open", async () => {
    const MODELS = "http://models-immutable";
    await cloud.server(MODELS).seed("model3d/a.step", body("STEP-A"));
    const sparse = (): LayerDescriptor => ({
      namespace: "models:R@v1",
      kind: "sparse",
      url: MODELS,
      immutable: true,
    });
    const b = browser();
    await b.stack(cloud, [sparse()]).open();
    const reopened = b.stack(cloud, [sparse()]);
    await reopened.open();
    // One manifest GET per open: the eager sync is what discovers entry
    // hashes for the lazy per-body fetches.
    expect(cloud.server(MODELS).manifestFetches).toBe(2);
  });
});

describe("writes (LWW, optimistic)", () => {
  let cloud: FakeCloud;
  beforeEach(() => {
    cloud = new FakeCloud();
  });

  it("push lands locally and on the server without a self-echo refetch", async () => {
    const s = browser().stack(cloud, [liveMirror()]);
    await s.open();
    await s.push("symbol/R", body("(R')"));
    await settle();

    expect(text(await s.read("symbol/R"))).toBe("(R')");
    expect(cloud.server(MIRROR).putCount).toBe(1);
    // The pusher already holds the body — its own broadcast is skipped.
    expect(cloud.server(MIRROR).bodyFetches).toBe(0);
  });

  it("propagates a push to a second client via broadcast", async () => {
    const a = browser().stack(cloud, [liveMirror()]);
    const bC = browser().stack(cloud, [liveMirror()]);
    await a.open();
    await bC.open();

    await a.push("symbol/R", body("(R')"));
    await settle();

    expect(text(await bC.read("symbol/R"))).toBe("(R')");
    // Exactly the second client fetched the one changed body.
    expect(cloud.server(MIRROR).bodyFetches).toBe(1);
  });

  it("snapshots ordered merged notifications without waiting for body reads", async () => {
    const backing = memStore();
    const never = new Promise<Uint8Array | null>(() => {});
    const unreadable: LayerStore = {
      ...backing,
      getBody: () => never,
    };
    const s = new SyncStack({
      layers: [liveMirror()],
      fetchImpl: cloud.fetchImpl,
      channelFactory: cloud.channelFactory,
      storeFactory: () => unreadable,
    });
    await s.open();
    const changes: Array<{ present: boolean; origin: string }> = [];
    s.subscribe((change) => changes.push(change));

    await s.push("symbol/R", body("R"));
    await s.delete("symbol/R");
    await vi.waitFor(() => expect(changes).toHaveLength(2));

    expect(changes).toEqual([
      { path: "symbol/R", present: true, origin: "local" },
      { path: "symbol/R", present: false, origin: "local" },
    ]);
    s.close();
  });
});

describe("stack lifecycle", () => {
  it("closes every acquired channel and store when open fails", async () => {
    let released = 0;
    let channelClosed = 0;
    const backing = memStore();
    const failingStore: LayerStore = {
      ...backing,
      acquire: () => () => {
        released++;
      },
      getManifest: async () => {
        throw new Error("open failed");
      },
    };
    const channel: RealtimeChannel = {
      onOpen: () => {},
      onMessage: () => {},
      send: () => {},
      close: () => {
        channelClosed++;
      },
    };
    const stack = new SyncStack({
      layers: [liveMirror()],
      fetchImpl: async () => {
        throw new Error("unexpected fetch");
      },
      channelFactory: () => channel,
      storeFactory: () => failingStore,
    });

    await expect(stack.open()).rejects.toThrow("open failed");
    expect(released).toBe(1);
    expect(channelClosed).toBe(1);
  });

  it("invalidates a queued notification when close wins", async () => {
    const cloud = new FakeCloud();
    const stack = browser().stack(cloud, [liveMirror()]);
    await stack.open();
    const delivered: unknown[] = [];
    stack.subscribe((change) => delivered.push(change));

    const internal = stack as unknown as {
      enqueueLayerChange(change: LayerChange): void;
    };
    internal.enqueueLayerChange({
      op: "put",
      path: "symbol/R",
      hash: "h",
      size: 1,
      version: 1,
      origin: "remote",
    });
    stack.close();
    await Promise.resolve();
    await Promise.resolve();

    expect(delivered).toEqual([]);
  });

  it("rejects cached read results when close expires their stack lifetime", async () => {
    const cloud = new FakeCloud();
    await cloud.server(MIRROR).seed("symbol/R", body("old-R"));

    const backing = memStore();
    let delayReads = false;
    let releaseBody!: () => void;
    let releaseAll!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const allGate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const delayedStore: LayerStore = {
      ...backing,
      getBody: async (path) => {
        if (delayReads) await bodyGate;
        return backing.getBody(path);
      },
      getAllBodies: async () => {
        if (delayReads) await allGate;
        return backing.getAllBodies();
      },
    };
    const stack = new SyncStack({
      layers: [liveMirror()],
      fetchImpl: cloud.fetchImpl,
      channelFactory: cloud.channelFactory,
      storeFactory: () => delayedStore,
    });
    await stack.open();
    delayReads = true;

    const one = stack.read("symbol/R");
    const all = stack.readAll();
    const oneRejected = expect(one).rejects.toThrow("sync stack is closed");
    const allRejected = expect(all).rejects.toThrow("sync stack is closed");

    stack.close();
    releaseBody();
    releaseAll();

    await oneRejected;
    await allRejected;
    await expect(stack.read("symbol/R")).rejects.toThrow("sync stack is closed");
    await expect(stack.list()).rejects.toThrow("sync stack is closed");
  });

  it("does not create a realtime channel after the stack is closed", () => {
    const channelFactory = vi.fn((): RealtimeChannel => ({
      onOpen: () => {},
      onMessage: () => {},
      send: () => {},
      close: () => {},
    }));
    const stack = new SyncStack({
      layers: [liveMirror()],
      realtime: "shared-only",
      fetchImpl: vi.fn(),
      channelFactory,
      storeFactory: () => memStore(),
    });

    expect(channelFactory).not.toHaveBeenCalled();
    stack.close();
    stack.connectRealtime();
    expect(channelFactory).not.toHaveBeenCalled();
  });
});

describe("layered merge (origin + mirror overlay)", () => {
  let cloud: FakeCloud;
  beforeEach(async () => {
    cloud = new FakeCloud();
    await cloud.server(ORIGIN).seed("symbol/R", body("origin-R"));
    await cloud.server(ORIGIN).seed("symbol/C", body("origin-C"));
  });

  it("reads top-wins; an overlay overrides only the edited item", async () => {
    const s = browser().stack(cloud, [staticOrigin(), liveMirror()]);
    await s.open();

    // Before any edit: everything resolves to the origin.
    expect(text(await s.read("symbol/R"))).toBe("origin-R");
    expect(text(await s.read("symbol/C"))).toBe("origin-C");
    expect((await s.list()).length).toBe(2);

    // Edit R into the overlay.
    await s.push("symbol/R", body("mine-R"));
    await settle();

    expect(text(await s.read("symbol/R"))).toBe("mine-R"); // overlay wins
    expect(text(await s.read("symbol/C"))).toBe("origin-C"); // untouched
    expect((await s.list()).find((e) => e.path === "symbol/R")?.hash).toBe(
      cloud.server(MIRROR).manifest.entries["symbol/R"]?.hash,
    );
  });

  it("deleting an overlay item reveals the origin underneath", async () => {
    const s = browser().stack(cloud, [staticOrigin(), liveMirror()]);
    await s.open();
    await s.push("symbol/R", body("mine-R"));
    await settle();
    expect(text(await s.read("symbol/R"))).toBe("mine-R");

    await s.delete("symbol/R");
    await settle();

    expect(text(await s.read("symbol/R"))).toBe("origin-R"); // back to origin
  });

  it("shares the origin store across two projects (dedup)", async () => {
    await cloud.server("http://mirror2").seed("noop", body("")); // distinct server
    const b = browser(); // one browser, two project stacks
    const p1 = b.stack(cloud, [staticOrigin(), liveMirror(MIRROR, "mirror:p1")]);
    const p2 = b.stack(cloud, [
      staticOrigin(),
      liveMirror("http://mirror2", "mirror:p2"),
    ]);
    await p1.open();
    await p2.open();

    // The shared origin namespace was bundled exactly once.
    expect(cloud.server(ORIGIN).bundleFetches).toBe(1);
    expect(text(await p2.read("symbol/R"))).toBe("origin-R");
  });
});

describe("bulk readAll (fat list)", () => {
  let cloud: FakeCloud;
  beforeEach(() => {
    cloud = new FakeCloud();
  });

  it("returns every body in one shot, matching read()/list()", async () => {
    await cloud.server(MIRROR).seed("symbol/R", body("(R)"));
    await cloud.server(MIRROR).seed("symbol/C", body("(C)"));
    const s = browser().stack(cloud, [liveMirror()]);
    await s.open();

    const all = await s.readAll();
    expect([...all.keys()].sort()).toEqual(["symbol/C", "symbol/R"]);
    expect(text(all.get("symbol/R")!)).toBe("(R)");
    // Same path set as list(), same bytes as read().
    expect([...all.keys()].sort()).toEqual(
      (await s.list()).map((e) => e.path).sort(),
    );
    expect(text(all.get("symbol/C")!)).toBe(text(await s.read("symbol/C")));
  });

  it("merges layers top-wins — a mirror overlay shadows the origin", async () => {
    await cloud.server(ORIGIN).seed("symbol/R", body("origin-R"));
    await cloud.server(ORIGIN).seed("symbol/C", body("origin-C"));
    const s = browser().stack(cloud, [staticOrigin(), liveMirror()]);
    await s.open();

    // Before any edit: the bulk view is the origin, exactly like read().
    let all = await s.readAll();
    expect(text(all.get("symbol/R")!)).toBe("origin-R");
    expect(text(all.get("symbol/C")!)).toBe("origin-C");

    // Edit R into the overlay; the bulk view must reflect the same top-wins merge
    // read() does — overlay R, origin C — and a brand-new overlay-only path shows.
    await s.push("symbol/R", body("mine-R"));
    await s.push("symbol/N", body("mine-N"));
    await settle();

    all = await s.readAll();
    expect(text(all.get("symbol/R")!)).toBe("mine-R"); // overlay wins
    expect(text(all.get("symbol/C")!)).toBe("origin-C"); // origin shows through
    expect(text(all.get("symbol/N")!)).toBe("mine-N"); // overlay-only path
    // Every entry agrees with the per-path read().
    for (const [path, bytes] of all) {
      expect(text(bytes)).toBe(text(await s.read(path)));
    }
  });
});

describe("hash-driven sync (regression: version gate)", () => {
  it("refetches a body whose hash changed even when the manifest version is unchanged", async () => {
    const cloud = new FakeCloud();
    await cloud.server(MIRROR).seed("symbol/R", body("v1"));
    const s = browser().stack(cloud, [liveMirror()]);
    await s.open();
    expect(text(await s.read("symbol/R"))).toBe("v1");
    const version = cloud.server(MIRROR).manifest.version;

    // Body changes, manifest version stays the same (the static-origin case that
    // a version-gated sync used to miss entirely).
    await cloud.server(MIRROR).revise("symbol/R", body("v2"));
    expect(cloud.server(MIRROR).manifest.version).toBe(version);

    await s.sync();
    expect(text(await s.read("symbol/R"))).toBe("v2"); // picked up via hash diff
  });
});

describe("sparse layer (lazy bodies)", () => {
  const MODELS = "http://models";
  const sparseModels = (): LayerDescriptor => ({
    namespace: "models:R@v1",
    kind: "sparse",
    url: MODELS,
    bodyUrlTemplate: `${MODELS}/blob/{hash}`,
  });

  let cloud: FakeCloud;
  beforeEach(async () => {
    cloud = new FakeCloud();
    await cloud.server(MODELS).seed("model3d/a.step", body("STEP-A"));
    await cloud.server(MODELS).seed("model3d/b.step", body("STEP-B"));
  });

  it("open() syncs the manifest only — no bundle, no bodies", async () => {
    const s = browser().stack(cloud, [sparseModels()]);
    await s.open();

    expect((await s.list()).map((e) => e.path).sort()).toEqual([
      "model3d/a.step",
      "model3d/b.step",
    ]);
    expect(cloud.server(MODELS).bundleFetches).toBe(0);
    expect(cloud.server(MODELS).bodyFetches).toBe(0);
    expect(cloud.server(MODELS).blobFetches).toBe(0);
  });

  it("read() lazily fetches ONE body via the content-addressed template, then caches", async () => {
    const b = browser();
    const s = b.stack(cloud, [sparseModels()]);
    await s.open();

    expect(text(await s.read("model3d/a.step"))).toBe("STEP-A");
    expect(cloud.server(MODELS).blobFetches).toBe(1); // exactly a, not b

    expect(text(await s.read("model3d/a.step"))).toBe("STEP-A");
    expect(cloud.server(MODELS).blobFetches).toBe(1); // served from cache

    // Warm reopen (same store map): still cached, manifest-only sync.
    const reopened = b.stack(cloud, [sparseModels()]);
    await reopened.open();
    expect(text(await reopened.read("model3d/a.step"))).toBe("STEP-A");
    expect(cloud.server(MODELS).blobFetches).toBe(1);
  });

  it("unknown path reads null without any fetch", async () => {
    const s = browser().stack(cloud, [sparseModels()]);
    await s.open();
    expect(await s.read("model3d/nope.step")).toBeNull();
    expect(cloud.server(MODELS).blobFetches).toBe(0);
  });

  it("a changed hash invalidates the cached body; the next read refetches", async () => {
    const b = browser();
    const s = b.stack(cloud, [sparseModels()]);
    await s.open();
    expect(text(await s.read("model3d/a.step"))).toBe("STEP-A");

    await cloud.server(MODELS).revise("model3d/a.step", body("STEP-A2"));
    await s.sync();

    expect(text(await s.read("model3d/a.step"))).toBe("STEP-A2");
    expect(cloud.server(MODELS).blobFetches).toBe(2);
  });

  it("rejects writes (read-only like static)", async () => {
    const s = browser().stack(cloud, [sparseModels()]);
    await s.open();
    // No writable layer → the stack rejects the push outright (sync throw).
    expect(() => s.push("model3d/a.step", body("x"))).toThrow(
      /no writable layer/,
    );
  });
});

describe("realtime resync", () => {
  it("resyncs on reconnect when it missed changes while disconnected", async () => {
    const cloud = new FakeCloud();
    await cloud.server(MIRROR).seed("symbol/R", body("(R)"));
    const s = browser().stack(cloud, [liveMirror()]);
    await s.open();

    // A change the client never saw over WS (seed = no broadcast), simulating a
    // change that landed while its channel was down.
    await cloud.server(MIRROR).seed("symbol/N", body("(N)"));
    expect(await s.read("symbol/N")).toBeNull(); // not yet known

    cloud.server(MIRROR).fireReconnect(); // onOpen → hello → resync
    await settle();

    expect(text(await s.read("symbol/N"))).toBe("(N)");
  });
});
