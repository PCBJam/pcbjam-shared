import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  deltaFromYEvents,
  docToY,
  kicadItemsMap,
  yToDoc,
  ydocHasState,
  ydocUpdateToKicadDoc,
} from "../src/kicad-y.js";
import { isEmptyKicadDelta, type KicadDelta } from "../src/kicad-delta.js";
import { docToFile, fileToDoc } from "../src/kicad-doc.js";
import { parseSexpr } from "../src/sexpr.js";
import { FIXTURES, listFixtures } from "./helpers.js";

/** Two Y.Docs joined by relaying their updates (a stand-in for any provider). */
function pair(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "from-a"));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "from-b"));
  return { a, b };
}

const BASE = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
  (via (at 5 5) (size 0.8) (uuid "via-1"))
)`;

describe("docToY / yToDoc", () => {
  it("round-trips a doc through a Y.Doc AND the yjs update encoding", () => {
    const doc = fileToDoc(BASE);
    const ydoc = new Y.Doc();
    docToY(doc, ydoc);
    // Cross the actual wire format: encode state, apply into a fresh doc.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    expect(parseSexpr(docToFile(yToDoc(remote)))).toEqual(parseSexpr(BASE));
  });

  it("ydocUpdateToKicadDoc rebuilds the file from a persisted state update", () => {
    // The server-side materialize path: a stored `.ydoc` (encodeStateAsUpdate)
    // → KicadDoc → file, without the caller touching yjs.
    const ydoc = new Y.Doc();
    docToY(fileToDoc(BASE), ydoc);
    const update = Y.encodeStateAsUpdate(ydoc);
    const doc = ydocUpdateToKicadDoc(update);
    expect(parseSexpr(docToFile(doc))).toEqual(parseSexpr(BASE));
  });

  it("re-seeding removes stale items and preserves layout order", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(BASE), ydoc);
    const next = fileToDoc(`(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
)`);
    docToY(next, ydoc);
    const back = yToDoc(ydoc);
    expect(Object.keys(back.items)).toEqual(["seg-1"]);
    expect(parseSexpr(docToFile(back))).toEqual(parseSexpr(docToFile(next)));
  });
});

describe("ydocHasState — uuid-less docs (pl_editor drawing sheets)", () => {
  // A drawing sheet has NO uuids, so fileToDoc puts everything in layout/meta
  // and kdoc_items stays empty. The seed/adopt/materialize decisions must still
  // see this as a populated room (regression: a 2nd tab opened the stale file).
  const WKS = `(page_layout
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (name border:Rect) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (name title) (pos 100 22))
)`;

  it("a fresh Y.Doc reports no state", () => {
    expect(ydocHasState(new Y.Doc())).toBe(false);
  });

  it("a seeded drawing sheet reports state despite zero kdoc_items", () => {
    const doc = fileToDoc(WKS);
    expect(Object.keys(doc.items)).toHaveLength(0); // no uuids → no items
    const ydoc = new Y.Doc();
    docToY(doc, ydoc);
    expect(kicadItemsMap(ydoc).size).toBe(0); // the OLD items-only check → "empty"
    expect(ydocHasState(ydoc)).toBe(true); // the FIX → layout/meta count as state
  });

  it("the materialize a joining tab would open round-trips across the wire", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(WKS), ydoc);
    const remote = new Y.Doc(); // the 2nd tab's doc after provider sync
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    expect(ydocHasState(remote)).toBe(true);
    expect(parseSexpr(docToFile(yToDoc(remote)))).toEqual(parseSexpr(WKS));
  });
});

describe("applyDeltaToY / deltaFromYEvents (the default onChange impl)", () => {
  it("a delta applied on A arrives on B as the same delta; origins pass through", () => {
    const { a, b } = pair();
    docToY(fileToDoc(BASE), a, "seed");

    // The RUNTIME subscribes (this test plays that role); the lib only computes.
    const seen: Array<{ delta: KicadDelta; origin: unknown }> = [];
    const itemsB = kicadItemsMap(b);
    itemsB.observeDeep((events, txn) => {
      const delta = deltaFromYEvents(itemsB, events);
      if (!isEmptyKicadDelta(delta)) seen.push({ delta, origin: txn.origin });
    });

    applyDeltaToY(
      a,
      {
        added: [
          { uuid: "txt-1", type: "gr_text", parent: null, body: [{ atom: '"hi"' }] },
        ],
        updated: [
          {
            uuid: "seg-1",
            type: "segment",
            parent: null,
            body: [{ k: "width", v: [{ atom: "0.4" }] }],
          },
        ],
        removed: ["via-1"],
      },
      "local-edit",
    );

    expect(seen).toHaveLength(1);
    const { delta, origin } = seen[0]!;
    expect(origin).toBe("from-a"); // B sees the relay origin → would not echo
    expect(delta.added.map((i) => i.uuid)).toEqual(["txt-1"]);
    expect(delta.updated.map((i) => i.uuid)).toEqual(["seg-1"]);
    expect(delta.removed).toEqual(["via-1"]);
    // Full item content travels — not just ids.
    expect(delta.updated[0]!.body).toEqual([{ k: "width", v: [{ atom: "0.4" }] }]);
  });

  it("keeps kdoc_layout in step: live ROOT add/remove stays materializable via docToFile", () => {
    const { a, b } = pair();
    docToY(fileToDoc(BASE), a, "seed");

    // A live editor edit (the binding's applyDeltaToY path): one root added,
    // one root removed. Before the layout maintenance this dropped txt-1 from
    // docToFile output and made the stale via-1 slot THROW renderItem.
    applyDeltaToY(
      a,
      {
        added: [
          {
            uuid: "txt-1",
            type: "gr_text",
            parent: null,
            body: [{ atom: '"hi"' }, { k: "uuid", v: [{ atom: '"txt-1"' }] }],
          },
        ],
        updated: [],
        removed: ["via-1"],
      },
      "local-edit",
    );

    // Both the editing doc and the relayed peer materialize the post-edit file.
    for (const ydoc of [a, b]) {
      const text = docToFile(yToDoc(ydoc));
      expect(text).toContain('(gr_text "hi"');
      expect(text).not.toContain("via-1");
      expect(text).toContain("seg-1"); // untouched root keeps its slot
    }
  });

  it("re-applying an existing root (adopt echo) does not duplicate its layout slot", () => {
    const { a } = pair();
    docToY(fileToDoc(BASE), a, "seed");
    const doc = yToDoc(a);
    applyDeltaToY(a, {
      added: [{ uuid: "seg-1", ...doc.items["seg-1"]! }],
      updated: [],
      removed: [],
    });
    const text = docToFile(yToDoc(a));
    expect(text.match(/"seg-1"/g)).toHaveLength(1);
  });

  it("no-op upserts produce no events", () => {
    const { a, b } = pair();
    docToY(fileToDoc(BASE), a);
    const doc = yToDoc(a);
    let fired = 0;
    const itemsB = kicadItemsMap(b);
    itemsB.observeDeep((events) => {
      if (!isEmptyKicadDelta(deltaFromYEvents(itemsB, events))) fired++;
    });
    applyDeltaToY(a, {
      added: [],
      updated: [{ uuid: "seg-1", ...doc.items["seg-1"]! }], // identical content
      removed: [],
    });
    expect(fired).toBe(0);
  });
});

describe("fixture docs survive the Y wire (auto-discovered)", () => {
  for (const file of listFixtures()) {
    it(path.relative(FIXTURES, file), () => {
      const text = fs.readFileSync(file, "utf8");
      const ydoc = new Y.Doc();
      docToY(fileToDoc(text), ydoc);
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      expect(parseSexpr(docToFile(yToDoc(remote)))).toEqual(parseSexpr(text));
    });
  }
});

describe("kicadDocToYdocUpdate (load-path-rework 0004 §2.4)", () => {
  it("produces a seeded, non-hollow, round-trippable at-rest ydoc", async () => {
    const { kicadDocToYdocUpdate, ydocIsHollow, Y_KDOC_META, Y_KDOC_SEED_NONCE } =
      await import("../src/kicad-y.js");
    const doc = fileToDoc(BASE);
    const update = kicadDocToYdocUpdate(doc, "runner:test");
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, update);
    expect(ydocHasState(ydoc)).toBe(true);
    expect(ydocIsHollow(ydoc)).toBe(false);
    expect(ydoc.getMap(Y_KDOC_META).get(Y_KDOC_SEED_NONCE)).toBe("runner:test");
    expect(docToFile(yToDoc(ydoc))).toBe(docToFile(doc));
    expect(docToFile(ydocUpdateToKicadDoc(update))).toBe(docToFile(doc));
  });
});
