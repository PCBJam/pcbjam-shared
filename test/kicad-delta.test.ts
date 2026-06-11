import { describe, expect, it } from "vitest";
import {
  docDelta,
  emptyKicadDelta,
  isEmptyKicadDelta,
  kicadDeltaSchema,
} from "../src/kicad-delta.js";
import { fileToDoc, renderItem, sexprToItems } from "../src/kicad-doc.js";
import { parseSexpr } from "../src/sexpr.js";

const FP_SEXPR = `(footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
  (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
  (pad "1" smd (at 0 0) (uuid "pad-1")))`;

describe("sexprToItems / renderItem (per-item converters)", () => {
  it("flattens one item's s-expr into the item + its descendants", () => {
    const { uuid, items } = sexprToItems(FP_SEXPR);
    expect(uuid).toBe("fp-1");
    expect(Object.keys(items).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);
    expect(items["fp-1"]!.parent).toBe(null);
    expect(items["pad-1"]!.parent).toBe("fp-1");
  });

  it("honors the parent argument for the top item", () => {
    const { items } = sexprToItems(`(pad "2" smd (at 1 1) (uuid "pad-2"))`, "fp-9");
    expect(items["pad-2"]!.parent).toBe("fp-9");
  });

  it("renderItem is the inverse (per-item round trip)", () => {
    const { uuid, items } = sexprToItems(FP_SEXPR);
    expect(parseSexpr(renderItem({ items }, uuid))).toEqual(parseSexpr(FP_SEXPR));
  });

  it("rejects a form without a (uuid …)", () => {
    expect(() => sexprToItems(`(pad "1" smd (at 0 0))`)).toThrow(/no direct/);
  });
});

describe("docDelta", () => {
  const BASE = `(kicad_pcb
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
  (via (at 5 5) (size 0.8) (uuid "via-1"))
)`;

  it("empty delta for identical docs", () => {
    const d = docDelta(fileToDoc(BASE), fileToDoc(BASE));
    expect(isEmptyKicadDelta(d)).toBe(true);
  });

  it("reports added / updated / removed exactly", () => {
    const next = fileToDoc(`(kicad_pcb
  (segment (start 0 0) (end 1 1) (width 0.4) (uuid "seg-1"))
  (gr_text "hi" (at 2 2) (uuid "txt-1"))
)`);
    const d = docDelta(fileToDoc(BASE), next);
    expect(d.added.map((i) => i.uuid)).toEqual(["txt-1"]);
    expect(d.updated.map((i) => i.uuid)).toEqual(["seg-1"]);
    expect(d.removed).toEqual(["via-1"]);
    expect(kicadDeltaSchema.safeParse(d).success).toBe(true);
  });

  it("a parent change alone is an update", () => {
    const a = fileToDoc(`(kicad_pcb (footprint "l:R" (uuid "fp-1") (pad "1" (uuid "p-1"))))`);
    const b = structuredClone(a);
    b.items["p-1"]!.parent = "fp-other";
    const d = docDelta(a, b);
    expect(d.updated.map((i) => i.uuid)).toEqual(["p-1"]);
  });

  it("schema helpers", () => {
    expect(isEmptyKicadDelta(emptyKicadDelta())).toBe(true);
    expect(kicadDeltaSchema.safeParse({ added: [], updated: [] }).success).toBe(false); // removed required
  });
});
