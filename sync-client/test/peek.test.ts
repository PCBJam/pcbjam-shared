import { describe, expect, it } from "vitest";
import { memStore, peekNamespaces, type LayerStore } from "../src/index.js";

const enc = new TextEncoder();

describe("peekNamespaces", () => {
  it("reports warm namespaces with entry counts + total bytes, cold as null", async () => {
    const stores = new Map<string, LayerStore>();
    const storeFactory = (ns: string) => {
      let s = stores.get(ns);
      if (!s) stores.set(ns, (s = memStore()));
      return s;
    };

    // warm: a cached manifest with two entries
    await storeFactory("kicad:v1:Device").setManifest({
      version: 1,
      entries: {
        "symbol/R": { hash: "h1", size: 100, mtime: 0 },
        "symbol/C": { hash: "h2", size: 250, mtime: 0 },
      },
    });
    // empty manifest = cold to SyncLayer.open (it would bulk-hydrate) — so cold here
    await storeFactory("kicad:v1:Empty").setManifest({ version: 0, entries: {} });
    await storeFactory("kicad:v1:Fp").putBody("footprint/X", enc.encode("(x)"));

    const peeked = await peekNamespaces(
      ["kicad:v1:Device", "kicad:v1:Empty", "kicad:v1:Fp", "kicad:v1:Never"],
      { storeFactory },
    );

    expect(peeked.get("kicad:v1:Device")).toEqual({ entries: 2, totalSize: 350 });
    expect(peeked.get("kicad:v1:Empty")).toBeNull();
    // a body without a manifest is not a warm cache (open() diffs on the manifest)
    expect(peeked.get("kicad:v1:Fp")).toBeNull();
    expect(peeked.get("kicad:v1:Never")).toBeNull();
  });

  it("never initializes a cache: peeking leaves the store cold", async () => {
    const stores = new Map<string, LayerStore>();
    const storeFactory = (ns: string) => {
      let s = stores.get(ns);
      if (!s) stores.set(ns, (s = memStore()));
      return s;
    };

    await peekNamespaces(["kicad:v1:Cold"], { storeFactory });
    expect(await stores.get("kicad:v1:Cold")!.getManifest()).toBeNull();
  });

  it("treats a per-namespace store failure as cold, not an error", async () => {
    const bad: LayerStore = {
      ...memStore(),
      getManifest: async () => {
        throw new Error("boom");
      },
    };
    const peeked = await peekNamespaces(["ns"], { storeFactory: () => bad });
    expect(peeked.get("ns")).toBeNull();
  });

  it("resolves all-cold without indexedDB (non-browser environment)", async () => {
    // vitest node env has no indexedDB global — the production path must not throw.
    const peeked = await peekNamespaces(["a", "b"]);
    expect(peeked.get("a")).toBeNull();
    expect(peeked.get("b")).toBeNull();
  });
});
