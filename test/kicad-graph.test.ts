import { describe, expect, it } from "vitest";
import type { KicadDoc, KicadItem, Slot } from "../src/kicad-doc.js";
import {
  analyzeKicadDocGraph,
  assertValidKicadDoc,
  canonicalizeKicadDocGraph,
} from "../src/kicad-graph.js";

function item(uuid: string, parent: string | null, body: Slot[] = []): KicadItem {
  return {
    type: "test_item",
    parent,
    body: [{ k: "uuid", v: [{ atom: JSON.stringify(uuid) }] }, ...body],
  };
}

describe("KicadDoc graph contract", () => {
  it("accepts a valid nested graph and leaves it unchanged by identity", () => {
    const doc: KicadDoc = {
      root: "kicad_pcb",
      items: {
        root: item("root", null, [{ k: "nested", v: [{ item: "child" }] }]),
        child: item("child", "root"),
      },
      layout: [{ item: "root" }],
    };

    expect(analyzeKicadDocGraph(doc)).toMatchObject({ valid: true, issues: [] });
    expect(assertValidKicadDoc(doc)).toBe(doc);
    expect(canonicalizeKicadDocGraph(doc)).toBe(doc);
  });

  it("reports cycles, bad parents, dangling/wrong/duplicate refs, and orphans without hanging", () => {
    const doc: KicadDoc = {
      root: "kicad_pcb",
      items: {
        "cycle-b": item("cycle-b", "cycle-a", [{ item: "cycle-a" }]),
        "cycle-a": item("cycle-a", "cycle-b", [{ item: "cycle-b" }]),
        root: item("root", null),
        orphan: item("orphan", null),
        self: item("self", "self", [{ item: "self" }]),
        missing: item("missing", "not-present"),
      },
      layout: [
        { item: "root" },
        { item: "root" },
        { item: "cycle-a" },
        { item: "not-an-item" },
      ],
    };

    const analysis = analyzeKicadDocGraph(doc);
    expect(analysis.valid).toBe(false);
    expect(new Set(analysis.issues.map((issue) => issue.kind))).toEqual(
      new Set([
        "missing-parent",
        "self-parent",
        "parent-cycle",
        "dangling-reference",
        "parent-reference-mismatch",
        "duplicate-reference",
        "orphan-item",
      ]),
    );
    expect(
      analysis.issues.find((issue) => issue.kind === "parent-cycle"),
    ).toEqual({ kind: "parent-cycle", cycle: ["cycle-a", "cycle-b"] });
    expect(() => assertValidKicadDoc(doc)).toThrow(/cycle|missing parent|duplicate|orphan/i);
  });

  it("canonicalizes an invalid merge to one deterministic valid forest", () => {
    const merged: KicadDoc = {
      root: "kicad_pcb",
      // Deliberately reverse key order; cycle-breaking and missing-ref appends
      // must use ids, not record insertion order.
      items: {
        e: item("e", null),
        d: item("d", "d", [{ item: "d" }]),
        c: item("c", "missing-parent"),
        b: item("b", "a", [{ item: "a" }]),
        a: item("a", "b", [{ item: "b" }, { item: "dangling" }]),
      },
      layout: [
        { item: "dangling" },
        { item: "e" },
        { item: "e" },
        { item: "b" },
      ],
    };

    const repaired = canonicalizeKicadDocGraph(merged);

    // Lexicographically smallest cycle member is rooted; b remains its child.
    expect(repaired.items.a!.parent).toBeNull();
    expect(repaired.items.b!.parent).toBe("a");
    expect(repaired.items.c!.parent).toBeNull();
    expect(repaired.items.d!.parent).toBeNull();
    expect(repaired.items.a!.body).toEqual([
      { k: "uuid", v: [{ atom: '"a"' }] },
      { item: "b" },
    ]);
    expect(repaired.items.b!.body).toEqual([
      { k: "uuid", v: [{ atom: '"b"' }] },
    ]);
    expect(repaired.layout).toEqual([
      { item: "e" },
      { item: "a" },
      { item: "c" },
      { item: "d" },
    ]);
    expect(analyzeKicadDocGraph(repaired)).toMatchObject({ valid: true, issues: [] });

    // Normalization is a fixed point, including object identity on the second pass.
    expect(canonicalizeKicadDocGraph(repaired)).toBe(repaired);
  });

  it("requires exactly one direct UUID field equal to the item-map key", () => {
    const make = (body: Slot[]): KicadDoc => ({
      root: "kicad_pcb",
      items: { x: { type: "segment", parent: null, body } },
      layout: [{ item: "x" }],
    });
    const cases: Array<[Slot[], string]> = [
      [[], "missing-item-uuid"],
      [
        [
          { k: "uuid", v: [{ atom: '"x"' }] },
          { k: "uuid", v: [{ atom: '"x"' }] },
        ],
        "duplicate-item-uuid",
      ],
      [[{ k: "uuid", v: [{ atom: '"other"' }] }], "item-uuid-mismatch"],
      [[{ k: "uuid", v: [{ atom: '"x"' }, { atom: '"extra"' }] }], "item-uuid-mismatch"],
    ];

    for (const [body, kind] of cases) {
      const malformed = make(body);
      expect(analyzeKicadDocGraph(malformed).issues).toContainEqual(
        expect.objectContaining({ kind, uuid: "x" }),
      );
      expect(() => assertValidKicadDoc(malformed)).toThrow(/uuid/i);
      const repaired = canonicalizeKicadDocGraph(malformed);
      expect(repaired.items.x!.body).toEqual([
        { k: "uuid", v: [{ atom: '"x"' }] },
      ]);
      expect(analyzeKicadDocGraph(repaired).valid).toBe(true);
      expect(canonicalizeKicadDocGraph(repaired)).toBe(repaired);
    }
  });
});
