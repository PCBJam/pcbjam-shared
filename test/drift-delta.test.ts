import { describe, expect, it } from "vitest";
import {
  compareDriftLayouts,
  compareKicadItems,
  compareSlots,
  docDelta,
  driftDocDelta,
} from "../src/kicad-delta.js";
import { fileToDoc, type KicadItem, type Slot } from "../src/kicad-doc.js";

/**
 * Order-only classification for drift reporting (kicad-delta.ts).
 *
 * The contract under test, stated once: an order difference among an item's
 * TOP-LEVEL keyed children is `reordered` (y-sexpr v2 produces those
 * legitimately), while positional atoms and anything nested stay strictly
 * order-sensitive so geometry can never be waved through.
 */

const k = (key: string, ...v: Slot[]): Slot => ({ k: key, v });
const a = (atom: string): Slot => ({ atom });
const item = (body: Slot[]): KicadItem => ({ type: "footprint", parent: null, body });

describe("compareSlots", () => {
  it("reports identical lists as equal", () => {
    const slots = [k("layer", a('"F.Cu"')), k("at", a("1"), a("2"))];
    expect(compareSlots(slots, [...slots])).toBe("equal");
  });

  it("treats a swap of top-level keyed children as a reorder", () => {
    const x = k("property", a('"Reference"'));
    const y = k("property", a('"Value"'));
    expect(compareSlots([x, y], [y, x])).toBe("reordered");
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

  it("routes order-only changes to `reordered`, not `updated`", () => {
    const d = driftDocDelta(reorderedOnly, swapped);
    expect(d.updated).toHaveLength(0);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.reordered.map((i) => i.uuid)).toEqual(["u-1"]);
  });

  // The whole point: a reorder-only drift must not be reportable.
  it("is empty-by-the-report-check when only order differs", () => {
    const d = driftDocDelta(reorderedOnly, swapped);
    expect(
      d.added.length === 0 && d.updated.length === 0 && d.removed.length === 0,
    ).toBe(true);
    // ...whereas the sync-path delta still sees it, because applying a reorder
    // is a real edit.
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

/**
 * Field report 2026-09-18: a swapped Si5351B left its definition in the additive
 * `kdoc_libsymbols` map; KiCad's screen dropped it with its last user, so the
 * layouts differed forever with zero item changes.
 */
describe("compareDriftLayouts — orphaned Y-side lib_symbols are not drift", () => {
  const R = `(symbol "Device:R" (property "Reference" "R" (at 0 0 0)))`;
  const C = `(symbol "Device:C" (property "Reference" "C" (at 0 0 0)))`;
  const sch = (defs: string, syms: string) =>
    fileToDoc(`(kicad_sch (version 20250114) (generator "eeschema") (lib_symbols ${defs}) ${syms})`);
  const placedR = `(symbol (lib_id "Device:R") (at 1 1 0) (uuid "s-r"))`;
  const placedC = `(symbol (lib_id "Device:C") (at 2 2 0) (uuid "s-c"))`;

  it("excuses a definition only the Y.Doc has when nothing references it", () => {
    expect(compareDriftLayouts(sch(`${R} ${C}`, placedR), sch(R, placedR))).toBe("equal");
  });

  it("still reports a REFERENCED definition the editor save lacks", () => {
    expect(compareDriftLayouts(sch(`${R} ${C}`, `${placedR} ${placedC}`), sch(R, `${placedR} ${placedC}`))).toBe(
      "different",
    );
  });

  it("still reports a definition only the editor save has", () => {
    expect(compareDriftLayouts(sch(R, placedR), sch(`${R} ${C}`, placedR))).toBe("different");
  });

  it("still reports a shared definition whose content differs", () => {
    const R2 = R.replace('"R"', '"RR"');
    expect(compareDriftLayouts(sch(R, placedR), sch(R2, placedR))).toBe("different");
  });

  it("honours lib_name as the reference key", () => {
    const named = `(symbol (lib_name "R_1") (lib_id "Device:R") (at 1 1 0) (uuid "s-r"))`;
    const R1 = R.replace('"Device:R"', '"R_1"');
    expect(compareDriftLayouts(sch(`${R1} ${C}`, named), sch(R1, named))).toBe("equal");
    expect(compareDriftLayouts(sch(`${R1} ${R}`, named), sch(R1, named))).toBe("equal");
  });
});
