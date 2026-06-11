import { describe, expect, it } from "vitest";
import {
  collabDeltaSchema,
  emptyCollabDelta,
  isEmptyCollabDelta,
  parseCollabDelta,
} from "../src/collab-wire.js";

describe("collab wire schemas (wasm bridge JSON)", () => {
  it("accepts a representative bridge delta (pl_editor spec shape)", () => {
    const d = parseCollabDelta(
      JSON.stringify({
        changed: [{ id: "aaaa", type: "text", x: 123, y: 45 }],
        added: [
          {
            id: "cccc",
            type: "segment",
            name: "seg",
            x: 5,
            y: 5,
            anchor: 3,
            ex: 25,
            ey: 5,
            eanchor: 3,
            linewidth: 0.2,
          },
        ],
        removed: ["bbbb"],
      }),
    );
    expect(d.changed[0]!.id).toBe("aaaa");
    expect(d.added[0]!["linewidth"]).toBe(0.2); // arbitrary fields pass through
    expect(d.removed).toEqual(["bbbb"]);
  });

  it("defaults omitted arrays (emitters may send partial deltas)", () => {
    const d = parseCollabDelta(JSON.stringify({ changed: [{ id: "x", type: "t" }] }));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("rejects items without id/type and non-JSON input", () => {
    expect(() => parseCollabDelta(JSON.stringify({ added: [{ type: "t" }] }))).toThrow();
    expect(() => parseCollabDelta("not json")).toThrow();
  });

  it("empty/isEmpty helpers", () => {
    expect(isEmptyCollabDelta(emptyCollabDelta())).toBe(true);
    expect(
      isEmptyCollabDelta(collabDeltaSchema.parse({ removed: ["x"] })),
    ).toBe(false);
  });
});
