import { describe, expect, it } from "vitest";
import {
  ACTIVITY_REF_CAP,
  emptyActivityChanges,
  isEmptyActivityChanges,
  mergeActivityChanges,
  noteItemChange,
  parseActivityChanges,
} from "../src/activity-wire.js";

describe("activity wire", () => {
  it("counts per type with capped refs and merges", () => {
    const a = emptyActivityChanges();
    noteItemChange(a, "footprint", "changed", "U1");
    noteItemChange(a, "footprint", "changed", "U1");
    noteItemChange(a, "segment", "added");
    const b = noteItemChange(emptyActivityChanges(), "footprint", "removed", "C4");
    b.other = 2;
    const m = mergeActivityChanges(a, b);
    expect(m.items.footprint).toEqual({ added: 0, removed: 1, changed: 2, refs: ["U1", "C4"] });
    expect(m.items.segment).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(m.other).toBe(2);
    const many = emptyActivityChanges();
    for (let i = 0; i < 40; i++) noteItemChange(many, "footprint", "changed", `R${i}`);
    expect(many.items.footprint!.refs).toHaveLength(ACTIVITY_REF_CAP);
  });

  it("parses defensively", () => {
    expect(parseActivityChanges({ items: { footprint: { added: 1, removed: -2, changed: "x", refs: ["U1", 3] } } })).toEqual({
      items: { footprint: { added: 1, removed: 0, changed: 0, refs: ["U1"] } },
    });
    expect(parseActivityChanges({ items: { "Bad Type": {} } })).toBeNull();
    expect(parseActivityChanges(null)).toBeNull();
    expect(isEmptyActivityChanges(emptyActivityChanges())).toBe(true);
  });
});
