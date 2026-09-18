/**
 * streamBodyJson must be byte-for-byte `JSON.stringify(slotsFromNode(body))`
 * wherever it is paused, because plugin exports resume it across UI-thread slices.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docToY, kicadItemsMap } from "../src/kicad-y.js";
import { slotsFromNode, streamBodyJson, Y_KDOC_SEXPR_VERSION } from "../src/kicad-y2.js";
import { fileToDoc, type Slot } from "../src/kicad-doc.js";

const points = Array.from({ length: 400 }, (_, i) => `(xy ${i} ${i * 2})`).join(" ");
const BOARD = `(kicad_pcb (version 20241229)
  (footprint "Lib:FP" (at 10 10) (layer "F.Cu") (uuid "fp-1")
    (property "Reference" "R\\"1\\n" (at 0 0) (uuid "prop-1"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "pad-1")))
  (zone (net 1) (layer "F.Cu") (uuid "zone-1")
    (polygon (pts ${points}))
    (filled_polygon (layer "F.Cu") (pts ${points}))))`;

function seeded(version: number) {
  const ydoc = new Y.Doc();
  ydoc.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, version);
  docToY(fileToDoc(BOARD), ydoc);
  return ydoc;
}
const bodyOf = (ydoc: Y.Doc, id: string) => kicadItemsMap(ydoc).get(id)!.get("body");
const expected = (body: unknown): Slot[] => (body instanceof Y.Map ? slotsFromNode(body as Y.Map<unknown>) : (body as Slot[]));
function run(body: unknown, pauseEvery: number, omit?: Set<string>) {
  let text = "", ticks = 0, pauses = 0;
  const stream = streamBodyJson(body, (piece) => { text += piece; }, () => ++ticks % pauseEvery === 0, omit);
  while (!stream.next().done) pauses++;
  return { text, pauses };
}

describe.each([1, 2])("streamBodyJson (body format v%i)", (version) => {
  it("equals the one-shot serialization for every item, however often it pauses", () => {
    const ydoc = seeded(version);
    for (const id of kicadItemsMap(ydoc).keys()) {
      const body = bodyOf(ydoc, id), want = JSON.stringify(expected(body));
      expect(run(body, 1).text).toBe(want);
      expect(run(body, 7).text).toBe(want);
      expect(run(body, 1e9)).toEqual({ text: want, pauses: 0 });
    }
  });
  it("pauses inside one large item", () => {
    expect(run(bodyOf(seeded(version), "zone-1"), 50).pauses).toBeGreaterThan(5);
  });
  it("omits named heads at any depth without walking them", () => {
    const body = bodyOf(seeded(version), "zone-1");
    const kept = JSON.parse(run(body, 3, new Set(["filled_polygon"])).text) as Slot[];
    const strip = (slots: Slot[]): Slot[] => slots.filter((s) => !("k" in s && s.k === "filled_polygon")).map((s) => ("k" in s ? { k: s.k, v: strip(s.v) } : s));
    expect(kept).toEqual(strip(expected(body)));
    expect(JSON.stringify(kept)).not.toContain("filled_polygon");
    expect(JSON.parse(run(body, 3, new Set(["xy"])).text)).toEqual(
      (function noXy(slots: Slot[]): Slot[] { return slots.filter((s) => !("k" in s && s.k === "xy")).map((s) => ("k" in s ? { k: s.k, v: noXy(s.v) } : s)); })(expected(body)),
    );
  });
});

describe("streamBodyJson input validation", () => {
  it("rejects shapes that are not slots and unbounded nesting", () => {
    const drain = (body: unknown) => { for (const _ of streamBodyJson(body, () => {}, () => false)); };
    expect(() => drain("text")).toThrow(/Invalid document data/);
    expect(() => drain([{ other: 1 }])).toThrow(/Invalid document data/);
    expect(() => drain([{ atom: 5 }])).toThrow(/Invalid document data/);
    let deep: Slot[] = [{ atom: "x" }];
    for (let i = 0; i < 60; i++) deep = [{ k: "n", v: [...deep, { k: "pad", v: Array(9).fill({ atom: "1" }) }] }];
    expect(() => drain(deep)).toThrow(/exceeds limits/);
  });
});
