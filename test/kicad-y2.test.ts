/**
 * y-s-expr v2 keyed slot maps (ysync 0009) — the merge regression suite (§8):
 * every row of the §3.6 concurrency table, the order-hint read rules, identity
 * assignment, classification/stickiness, v1 interop, and the anti-regressions
 * for the Y.Array anomalies the encoding designs out.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  deltaFromYEvents,
  docToY,
  kicadItemsMap,
  ydocSexprVersion,
  yToDoc,
} from "../src/kicad-y.js";
import {
  ATTR_ORDER_KEY,
  FORCE_ATOMIC_HEADS,
  nodeFromSlots,
  SEXPR_VERSION_CURRENT,
  slotsFromNode,
  updateNodeFromSlots,
  Y_KDOC_SEXPR_VERSION,
} from "../src/kicad-y2.js";
import { docToFile, fileToDoc, field, scalar, type Slot } from "../src/kicad-doc.js";
import { isEmptyKicadDelta } from "../src/kicad-delta.js";
import { parseSexpr } from "../src/sexpr.js";

const BASE = `(kicad_pcb
  (version 20241229)
  (footprint "Lib:FP"
    (at 10 10)
    (layer "F.Cu")
    (uuid "fp-1")
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (uuid "pad-1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (uuid "pad-2"))
  )
  (symbol (lib_id "Device:R") (at 100 100 0) (uuid "sym-1")
    (property "Reference" "R1" (at 1 1 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 2 2 0) (effects (font (size 1.27 1.27))))
  )
  (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 0) (uuid "seg-1"))
  (gr_poly (pts (xy 0 0) (xy 5 0) (xy 5 5) (xy 0 5)) (uuid "poly-1"))
)`;

/** Seed one doc, sync a second — both v2 (fresh docs stamp CURRENT). */
function seededPair(text: string = BASE): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  docToY(fileToDoc(text), a, "seed");
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b };
}

/** Exchange full state both ways — the CRDT merge point. */
function converge(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

/** Re-write one item's body through the real write path (full-item upsert). */
function editItem(ydoc: Y.Doc, uuid: string, mutate: (body: Slot[]) => Slot[]): void {
  const doc = yToDoc(ydoc);
  const item = doc.items[uuid]!;
  applyDeltaToY(
    ydoc,
    { added: [], updated: [{ uuid, ...item, body: mutate(item.body) }], removed: [] },
    "edit",
  );
}

/** Replace the FIRST `(k …)` field's value slots; asserts it exists. */
function setField(body: Slot[], k: string, v: Slot[]): Slot[] {
  const at = body.findIndex((s) => "k" in s && s.k === k);
  expect(at).toBeGreaterThanOrEqual(0);
  const out = body.slice();
  out[at] = { k, v };
  return out;
}

function atoms(...values: string[]): Slot[] {
  return values.map((atom) => ({ atom }));
}

/**
 * Integrate a freshly built node into a scratch doc — a detached (preliminary)
 * Y.Map accepts writes but reads nothing back until integration, so any test
 * that READS a `nodeFromSlots` result must anchor it first (production bodies
 * are always integrated via `items.set`).
 */
function anchored(node: Y.Map<unknown>): Y.Map<unknown> {
  new Y.Doc().getMap("scratch").set("n", node);
  return node;
}

/** The item's live v2 body node map. */
function bodyNode(ydoc: Y.Doc, uuid: string): Y.Map<unknown> {
  const body = kicadItemsMap(ydoc).get(uuid)!.get("body");
  expect(body).toBeInstanceOf(Y.Map);
  return body as Y.Map<unknown>;
}

/** The node's child keys (map membership, not order), sorted. */
function nodeKeys(node: Y.Map<unknown>): string[] {
  const keys: string[] = [];
  node.forEach((_v, k) => {
    if (k !== ATTR_ORDER_KEY) keys.push(k);
  });
  return keys.sort();
}

describe("v2 doc shape & versioning", () => {
  it("a fresh doc is stamped with the current version and stores bodies as node maps", () => {
    const { a } = seededPair();
    expect(ydocSexprVersion(a)).toBe(SEXPR_VERSION_CURRENT);
    expect(kicadItemsMap(a).get("seg-1")!.get("body")).toBeInstanceOf(Y.Map);
  });

  it("round-trips every item byte-structurally (fixture invariant)", () => {
    const { b } = seededPair();
    expect(parseSexpr(docToFile(yToDoc(b)))).toEqual(parseSexpr(BASE));
  });

  it("fileToDoc rejects a head containing the reserved '#'", () => {
    expect(() => fileToDoc(`(kicad_pcb (bad#head 1))`)).toThrow(/reserved '#'/);
  });
});

describe("identity rules (§3.3)", () => {
  it("repeated identifier-atom kinds get identity keys (property#Reference)", () => {
    const { a } = seededPair();
    const keys = nodeKeys(bodyNode(a, "sym-1"));
    expect(keys).toContain("property#Reference");
    expect(keys).toContain("property#Value");
  });

  it("a single child of its kind is positional and its key survives value edits", () => {
    const { a } = seededPair();
    expect(nodeKeys(bodyNode(a, "seg-1"))).toContain("width#1");
    editItem(a, "seg-1", (b) => setField(b, "width", atoms("0.4")));
    expect(nodeKeys(bodyNode(a, "seg-1"))).toContain("width#1"); // updated in place, not rekeyed
    expect(scalar(yToDoc(a).items["seg-1"]!.body, "width")).toBe("0.4");
  });

  it("v3 keeps an anonymous repeated coordinate sequence atomic", () => {
    const { a } = seededPair();
    const pts = bodyNode(a, "poly-1").get("pts#1");
    expect(Array.isArray(pts)).toBe(true);
    expect(pts).toEqual(field(yToDoc(a).items["poly-1"]!.body, "pts"));
  });

  it("hoisted children ref by uuid (#item# keys)", () => {
    const { a } = seededPair();
    const keys = nodeKeys(bodyNode(a, "fp-1"));
    expect(keys).toContain("#item#pad-1");
    expect(keys).toContain("#item#pad-2");
  });

  it("a property rename is delete+add (identity keys are never renumbered)", () => {
    const { a } = seededPair();
    editItem(a, "sym-1", (b) =>
      b.map((s) =>
        "k" in s && s.k === "property" && "atom" in s.v[0]! && s.v[0].atom === '"Value"'
          ? { k: "property", v: [{ atom: '"MPN"' }, ...s.v.slice(1)] }
          : s,
      ),
    );
    const keys = nodeKeys(bodyNode(a, "sym-1"));
    expect(keys).toContain("property#MPN");
    expect(keys).not.toContain("property#Value");
    expect(keys).toContain("property#Reference"); // untouched sibling kept its key
  });
});

describe("classification (§3.5)", () => {
  it("small all-atom tuples are atomic leaves; records are node maps", () => {
    const { a } = seededPair();
    const seg = bodyNode(a, "seg-1");
    expect(Array.isArray(seg.get("start#1"))).toBe(true); // (start 0 0) → leaf
    const sym = bodyNode(a, "sym-1");
    const prop = sym.get("property#Reference") as Y.Map<unknown>;
    expect(prop).toBeInstanceOf(Y.Map); // record → node map
    expect(prop.get("effects#1")).toBeInstanceOf(Y.Map); // nested record too
  });

  it("all-atom children above the tuple threshold become node maps", () => {
    const node = anchored(nodeFromSlots([{ k: "layers", v: atoms("1", "2", "3", "4", "5", "6", "7", "8", "9") }]));
    expect(node.get("layers#1")).toBeInstanceOf(Y.Map);
  });

  it("override heads are force-atomic even when structured (filled_polygon)", () => {
    const node = anchored(nodeFromSlots([
      { k: "filled_polygon", v: [{ k: "layer", v: atoms('"F.Cu"') }, { k: "pts", v: [{ k: "xy", v: atoms("0", "0") }] }] },
    ]));
    expect(Array.isArray(node.get("filled_polygon#1"))).toBe(true);
    expect(FORCE_ATOMIC_HEADS.has("net")).toBe(true);
  });

  it("representation is sticky: an existing node map survives an override-table change", () => {
    const node = anchored(nodeFromSlots([{ k: "pts", v: [{ k: "xy", v: atoms("0", "0") }] }]));
    // A later client forces pts atomic — the EXISTING slot keeps its shape.
    const forcePts = new Set([...FORCE_ATOMIC_HEADS, "pts"]);
    updateNodeFromSlots(node, [{ k: "pts", v: [{ k: "xy", v: atoms("1", "1") }] }], forcePts);
    expect(node.get("pts#1")).toBeInstanceOf(Y.Map);
    expect(slotsFromNode(node)).toEqual([{ k: "pts", v: [{ k: "xy", v: [{ atom: "1" }, { atom: "1" }] }] }]);
    // …while a NEWLY created sibling under the changed table is shaped by it.
    updateNodeFromSlots(
      node,
      [
        { k: "pts", v: [{ k: "xy", v: atoms("1", "1") }] },
        { k: "arcs", v: [{ k: "xy", v: atoms("2", "2") }] },
      ],
      new Set([...forcePts, "arcs"]),
    );
    expect(Array.isArray(node.get("arcs#1"))).toBe(true);
  });
});

describe("#attr_order read normalization (§3.4)", () => {
  it("dedupes (first wins), skips absent keys, appends missing keys sorted", () => {
    const node = anchored(nodeFromSlots(atoms("a", "b", "c")));
    // Corrupt the hint the ways concurrency can: dups, stale, missing.
    const order = node.get(ATTR_ORDER_KEY) as Y.Array<string>;
    order.delete(0, order.length);
    order.insert(0, ["#atom#2", "#atom#9", "#atom#1", "#atom#2"]); // #atom#3 missing, #atom#9 stale
    expect(slotsFromNode(node)).toEqual([{ atom: "b" }, { atom: "a" }, { atom: "c" }]);
  });

  it("a missing #attr_order still renders every child (sorted fallback)", () => {
    const node = anchored(nodeFromSlots(atoms("x", "y")));
    node.delete(ATTR_ORDER_KEY);
    expect(slotsFromNode(node)).toEqual([{ atom: "x" }, { atom: "y" }]);
  });
});

describe("merge regression table (§3.6)", () => {
  it("different slots of one item: both edits survive (the opt-14 fix)", () => {
    const { a, b } = seededPair();
    editItem(a, "seg-1", (body) => setField(body, "width", atoms("0.4")));
    editItem(b, "seg-1", (body) => setField(body, "layer", atoms('"B.Cu"')));
    converge(a, b);
    for (const ydoc of [a, b]) {
      const seg = yToDoc(ydoc).items["seg-1"]!.body;
      expect(scalar(seg, "width")).toBe("0.4");
      expect(scalar(seg, "layer")).toBe('"B.Cu"');
    }
  });

  it("same slot edited twice: LWW single winner, never duplicated (anti Y.Array)", () => {
    const { a, b } = seededPair();
    editItem(a, "seg-1", (body) => setField(body, "width", atoms("0.4")));
    editItem(b, "seg-1", (body) => setField(body, "width", atoms("0.6")));
    converge(a, b);
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
    const widths = yToDoc(a).items["seg-1"]!.body.filter((s) => "k" in s && s.k === "width");
    expect(widths).toHaveLength(1);
    expect(["0.4", "0.6"]).toContain(scalar(yToDoc(a).items["seg-1"]!.body, "width"));
  });

  it("edit vs delete of a slot: the edit wins (resurrection, re-ordered by append)", () => {
    const { a, b } = seededPair();
    editItem(a, "seg-1", (body) => body.filter((s) => !("k" in s && s.k === "width")));
    editItem(b, "seg-1", (body) => setField(body, "width", atoms("0.9")));
    converge(a, b);
    for (const ydoc of [a, b]) {
      const seg = yToDoc(ydoc).items["seg-1"]!.body;
      expect(scalar(seg, "width")).toBe("0.9"); // resurrected with the edit's value
    }
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
  });

  it("concurrent child-item adds: both survive (uuid keys — v1 LWW-dropped one)", () => {
    const { a, b } = seededPair();
    const pad = (uuid: string, x: string): void => {
      const ydoc = uuid === "pad-3" ? a : b;
      const doc = yToDoc(ydoc);
      const fp = doc.items["fp-1"]!;
      applyDeltaToY(
        ydoc,
        {
          added: [
            {
              uuid,
              type: "pad",
              parent: "fp-1",
              body: [
                ...atoms(`"${uuid.slice(-1)}"`, "smd", "rect"),
                { k: "at", v: atoms(x, "0") },
                { k: "uuid", v: [{ atom: `"${uuid}"` }] },
              ],
            },
          ],
          updated: [{ uuid: "fp-1", ...fp, body: [...fp.body, { item: uuid }] }],
          removed: [],
        },
        "edit",
      );
    };
    pad("pad-3", "-2");
    pad("pad-4", "2");
    converge(a, b);
    for (const ydoc of [a, b]) {
      const text = docToFile(yToDoc(ydoc));
      expect(text).toContain('"pad-3"');
      expect(text).toContain('"pad-4"');
    }
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
  });

  it("concurrent same-kind adds (numeric ids): id collision → one wins, no corruption", () => {
    const { a, b } = seededPair();
    const addVertex = (ydoc: Y.Doc, x: string): void =>
      editItem(ydoc, "poly-1", (body) =>
        setField(body, "pts", [...field(body, "pts")!, { k: "xy", v: atoms(x, x) }]),
      );
    addVertex(a, "9");
    addVertex(b, "8");
    converge(a, b);
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
    const pts = field(yToDoc(a).items["poly-1"]!.body, "pts")!;
    expect(pts).toHaveLength(5); // 4 seeded + exactly ONE of the two adds (accepted LWW)
  });

  it("concurrent adds of the same logical entity converge (identity dedup)", () => {
    const { a, b } = seededPair();
    const addMpn = (ydoc: Y.Doc): void =>
      editItem(ydoc, "sym-1", (body) => [
        ...body,
        { k: "property", v: [...atoms('"MPN"', '"RC0603"'), { k: "at", v: atoms("3", "3", "0") }] },
      ]);
    addMpn(a);
    addMpn(b);
    converge(a, b);
    const props = yToDoc(a).items["sym-1"]!.body.filter((s) => "k" in s && s.k === "property");
    expect(props).toHaveLength(3); // Reference, Value, ONE MPN — not four
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
  });

  it("structural edit vs leaf edit in one node: membership and order both merge", () => {
    const { a, b } = seededPair();
    editItem(a, "seg-1", (body) => [...body, { k: "locked", v: atoms("yes") }]);
    editItem(b, "seg-1", (body) => setField(body, "width", atoms("0.7")));
    converge(a, b);
    for (const ydoc of [a, b]) {
      const seg = yToDoc(ydoc).items["seg-1"]!.body;
      expect(scalar(seg, "width")).toBe("0.7");
      expect(scalar(seg, "locked")).toBe("yes");
    }
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
  });
});

describe("deep events resolve the owning item (binding UP path)", () => {
  it("a leaf edit deep in a body surfaces as a full-item update for path[0]'s uuid", () => {
    const { a, b } = seededPair();
    const itemsB = kicadItemsMap(b);
    const seen: string[] = [];
    itemsB.observeDeep((events) => {
      const delta = deltaFromYEvents(itemsB, events);
      if (isEmptyKicadDelta(delta)) return;
      seen.push(...delta.updated.map((it) => it.uuid));
      // Full item content travels, not just the changed leaf.
      expect(scalar(delta.updated[0]!.body, "width")).toBe("0.5");
    });
    editItem(a, "seg-1", (body) => setField(body, "width", atoms("0.5")));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(seen).toEqual(["seg-1"]);
  });
});

describe("removing a child item prunes its ref from the v2 parent body", () => {
  it("parent stays materializable after a child-only removal", () => {
    const { a } = seededPair();
    applyDeltaToY(a, { added: [], updated: [], removed: ["pad-1"] }, "edit");
    const text = docToFile(yToDoc(a)); // would throw on a dangling {item} ref
    expect(text).not.toContain("pad-1");
    expect(text).toContain("pad-2");
    expect(nodeKeys(bodyNode(a, "fp-1"))).not.toContain("#item#pad-1");
  });
});

describe("v1 interop (§5)", () => {
  it("a doc stamped v1 keeps plain bodies and round-trips", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, 1);
    docToY(fileToDoc(BASE), ydoc);
    expect(ydocSexprVersion(ydoc)).toBe(1);
    expect(Array.isArray(kicadItemsMap(ydoc).get("seg-1")!.get("body"))).toBe(true);
    expect(parseSexpr(docToFile(yToDoc(ydoc)))).toEqual(parseSexpr(BASE));
  });

  it("a doc with pre-versioning state is treated as v1 by later writes", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, 1);
    docToY(fileToDoc(BASE), ydoc);
    ydoc.getMap("kdoc_meta").delete(Y_KDOC_SEXPR_VERSION); // simulate a legacy doc
    editItem(ydoc, "seg-1", (body) => setField(body, "width", atoms("0.4")));
    expect(ydocSexprVersion(ydoc)).toBe(1); // not re-stamped
    expect(Array.isArray(kicadItemsMap(ydoc).get("seg-1")!.get("body"))).toBe(true);
  });

  it("v1 blob → fresh current-version seed (the onLoad conversion) is lossless", () => {
    const v1 = new Y.Doc();
    v1.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, 1);
    docToY(fileToDoc(BASE), v1);
    // The §5 conversion: materialize the v1 blob, reseed a FRESH doc (v2).
    const converted = new Y.Doc();
    docToY(yToDoc(v1), converted);
    expect(ydocSexprVersion(converted)).toBe(SEXPR_VERSION_CURRENT);
    expect(docToFile(yToDoc(converted))).toBe(docToFile(yToDoc(v1)));
  });
});
