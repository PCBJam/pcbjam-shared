import type { LayerDescriptor } from "@pcbjam/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { memStore, SyncStack, type LayerStore } from "../src/index.js";
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
