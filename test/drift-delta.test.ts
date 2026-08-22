import { describe, expect, it } from "vitest";
import {
  compareKicadItems,
  compareSlots,
  docDelta,
  driftDocDelta,
  KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
} from "../src/kicad-delta.js";
import { fileToDoc, type KicadItem, type Slot } from "../src/kicad-doc.js";

/**
 * Order-only classification for drift reporting (kicad-delta.ts).
 *
 * The contract under test, stated once: order is exact by default. Only
 * identity-bearing item references may use the explicit, writer-audited order
 * exception; positional atoms and anonymous/keyed children always stay exact.
 */

const k = (key: string, ...v: Slot[]): Slot => ({ k: key, v });
const a = (atom: string): Slot => ({ atom });
const item = (body: Slot[]): KicadItem => ({ type: "footprint", parent: null, body });

describe("compareSlots", () => {
  it("reports identical lists as equal", () => {
    const slots = [k("layer", a('"F.Cu"')), k("at", a("1"), a("2"))];
    expect(compareSlots(slots, [...slots])).toBe("equal");
  });

  it("treats a swap of top-level keyed children as different by default", () => {
    const x = k("property", a('"Reference"'));
    const y = k("property", a('"Value"'));
    expect(compareSlots([x, y], [y, x])).toBe("different");
  });

  it("ignores only explicitly audited UUID item-reference order", () => {
    const x: Slot = { item: "uuid-a" };
    const y: Slot = { item: "uuid-b" };
    expect(compareSlots([x, y], [y, x])).toBe("different");
    expect(
      compareSlots([x, y], [y, x], KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER),
    ).toBe("reordered");
  });

  it("does not let item-reference relaxation hide an anonymous reorder", () => {
    const x: Slot = { item: "uuid-a" };
    const p1 = k("xy", a("0"), a("0"));
    const p2 = k("xy", a("1"), a("1"));
    expect(
      compareSlots(
        [x, p1, p2],
        [p2, p1, x],
        KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
      ),
    ).toBe("different");
  });

  it("treats a changed value as different, not a reorder", () => {
    expect(
      compareSlots([k("at", a("1"), a("2"))], [k("at", a("1"), a("3"))]),
    ).toBe("different");
  });

  it("treats added/removed children as different", () => {
    const x = k("attr", a("smd"));
    expect(compareSlots([x], [x, k("locked", a("yes"))])).toBe("different");
  });

  // The trap this classifier must not fall into: `(at X Y)` swapped to `(at Y X)`
  // is the same multiset of atoms but a different position on the board.
  it("keeps leading positional atoms order-sensitive", () => {
    expect(compareSlots([a("1"), a("2")], [a("2"), a("1")])).toBe("different");
    expect(
      compareSlots(
        [a('"1"'), a("smd"), a("roundrect")],
        [a('"1"'), a("roundrect"), a("smd")],
      ),
    ).toBe("different");
  });

  // Nested content is compared verbatim, so a polygon whose vertices are
  // permuted is a real change even though the multiset is equal.
  it("keeps NESTED order significant (polygon vertices)", () => {
    const pts = (...xy: Slot[]): Slot => k("pts", ...xy);
    const p1 = pts(k("xy", a("0"), a("0")), k("xy", a("5"), a("0")));
    const p2 = pts(k("xy", a("5"), a("0")), k("xy", a("0"), a("0")));
    expect(compareSlots([p1], [p2])).toBe("different");
  });

  it("keeps anonymous repeated heads in authored order", () => {
    const first = k("xy", a("0"), a("0"));
    const second = k("xy", a("5"), a("0"));
    expect(compareSlots([first, second], [second, first])).toBe("different");
  });
});

describe("compareKicadItems", () => {
  it("never calls a type or parent change a reorder", () => {
    const body = [k("layer", a('"F.Cu"'))];
    expect(
      compareKicadItems({ type: "footprint", parent: null, body }, {
        type: "pad",
        parent: null,
        body,
      }),
    ).toBe("different");
    expect(
      compareKicadItems({ type: "pad", parent: null, body }, {
        type: "pad",
        parent: "abc",
        body,
      }),
    ).toBe("different");
  });
});

describe("driftDocDelta", () => {
  const reorderedOnly = {
    items: {
      "u-1": item([k("property", a('"Reference"')), k("property", a('"Value"'))]),
    },
  };
  const swapped = {
    items: {
      "u-1": item([k("property", a('"Value"')), k("property", a('"Reference"'))]),
    },
  };

  it("reports keyed-child order changes as drift by default", () => {
    const d = driftDocDelta(reorderedOnly, swapped);
    expect(d.updated.map((i) => i.uuid)).toEqual(["u-1"]);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.reordered).toHaveLength(0);
  });

  it("does not let a pure order drift pass the report check", () => {
    const d = driftDocDelta(reorderedOnly, swapped);
    expect(
      d.added.length === 0 && d.updated.length === 0 && d.removed.length === 0,
    ).toBe(false);
    expect(docDelta(reorderedOnly, swapped).updated).toHaveLength(1);
  });

  it("still reports real value changes as `updated`", () => {
    const changed = {
      items: { "u-1": item([k("property", a('"Reference"')), k("property", a('"V2"'))]) },
    };
    const d = driftDocDelta(reorderedOnly, changed);
    expect(d.updated.map((i) => i.uuid)).toEqual(["u-1"]);
    expect(d.reordered).toHaveLength(0);
  });

  it("keeps add/remove behaviour identical to docDelta", () => {
    const prev = { items: { "u-1": item([k("a")]) } };
    const next = { items: { "u-2": item([k("b")]) } };
    const d = driftDocDelta(prev, next);
    expect(d.added.map((i) => i.uuid)).toEqual(["u-2"]);
    expect(d.removed).toEqual(["u-1"]);
    expect(d.reordered).toHaveLength(0);
  });

  it("finds no drift at all between a doc and itself", () => {
    const doc = fileToDoc(
      '(kicad_pcb (version 20260206) (footprint "L:C1206" (uuid "u-1") (at 1 2)))',
    );
    const d = driftDocDelta(doc, doc);
    expect(d).toEqual({ added: [], updated: [], removed: [], reordered: [] });
  });
});
