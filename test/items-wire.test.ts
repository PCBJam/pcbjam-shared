import { describe, expect, it } from "vitest";
import {
  deltaToItemsWire,
  descendants,
  isEmptyItemsWireDelta,
  itemsWireToDelta,
  parseItemsWireDelta,
} from "../src/items-wire.js";
import { fileToDoc } from "../src/kicad-doc.js";
import { parseSexpr } from "../src/sexpr.js";

const FP = `(footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
  (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
  (pad "1" smd (at 0 0) (uuid "pad-1"))
  (pad "2" smd (at 2 0) (uuid "pad-2")))`;

/** Current-state fixture: the footprint + a free segment. */
function current() {
  return fileToDoc(`(kicad_pcb ${FP} (segment (start 0 0) (end 1 1) (uuid "seg-1")))`).items;
}

describe("descendants", () => {
  it("walks the parent links transitively", () => {
    expect(descendants(current(), "fp-1").sort()).toEqual(["fld-1", "pad-1", "pad-2"]);
    expect(descendants(current(), "seg-1")).toEqual([]);
  });
});

describe("itemsWireToDelta (editor → Y)", () => {
  it("an added wire item flattens into added subtree items", () => {
    const wire = parseItemsWireDelta(JSON.stringify({ added: [{ sexpr: FP }] }));
    const d = itemsWireToDelta(wire, {});
    expect(d.added.map((i) => i.uuid).sort()).toEqual(["fld-1", "fp-1", "pad-1", "pad-2"]);
    expect(d.updated).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("a changed item updates only what differs and removes vanished children", () => {
    // pad-2 is gone; pad-1 moved; fld-1 untouched.
    const changedFp = `(footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
  (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
  (pad "1" smd (at 5 5) (uuid "pad-1")))`;
    const d = itemsWireToDelta(
      parseItemsWireDelta(JSON.stringify({ changed: [{ sexpr: changedFp }] })),
      current(),
    );
    expect(d.updated.map((i) => i.uuid).sort()).toEqual(["fp-1", "pad-1"]); // fp body lost a ref
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual(["pad-2"]);
  });

  it("an unchanged re-send is an empty delta", () => {
    const d = itemsWireToDelta(
      parseItemsWireDelta(JSON.stringify({ changed: [{ sexpr: FP }] })),
      current(),
    );
    expect(d.added).toEqual([]);
    expect(d.updated).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("removed roots cascade over their descendants", () => {
    const d = itemsWireToDelta(
      parseItemsWireDelta(JSON.stringify({ removed: ["fp-1"] })),
      current(),
    );
    expect(d.removed.sort()).toEqual(["fld-1", "fp-1", "pad-1", "pad-2"]);
  });

  it("honors the wire parent for nested items sent alone", () => {
    const d = itemsWireToDelta(
      parseItemsWireDelta(
        JSON.stringify({ changed: [{ sexpr: `(pad "1" smd (at 9 9) (uuid "pad-1"))`, parent: "fp-1" }] }),
      ),
      current(),
    );
    expect(d.updated.map((i) => i.uuid)).toEqual(["pad-1"]);
    expect(d.updated[0]!.parent).toBe("fp-1");
  });
});

describe("deltaToItemsWire (Y → editor)", () => {
  it("renders the full subtree sexpr and prunes delta items covered by an ancestor", () => {
    const view = current();
    const wire = deltaToItemsWire(
      {
        added: [],
        updated: [
          { uuid: "fp-1", ...view["fp-1"]! },
          { uuid: "pad-1", ...view["pad-1"]! }, // covered by fp-1 → pruned
        ],
        removed: ["seg-1"],
      },
      view,
    );
    expect(wire.changed).toHaveLength(1);
    expect(parseSexpr(wire.changed[0]!.sexpr)).toEqual(parseSexpr(FP)); // subtree embedded
    expect(wire.changed[0]!.parent).toBe(null);
    expect(wire.removed).toEqual(["seg-1"]);
  });

  it("a lone child update renders just that child with its parent uuid", () => {
    const view = current();
    const wire = deltaToItemsWire(
      { added: [], updated: [{ uuid: "pad-1", ...view["pad-1"]! }], removed: [] },
      view,
    );
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.parent).toBe("fp-1");
    expect(parseSexpr(wire.changed[0]!.sexpr)).toEqual(
      parseSexpr(`(pad "1" smd (at 0 0) (uuid "pad-1"))`),
    );
  });
});

describe("wire schema", () => {
  it("defaults omitted arrays and parent", () => {
    const d = parseItemsWireDelta(JSON.stringify({ added: [{ sexpr: "(x (uuid \"u\"))" }] }));
    expect(d.added[0]!.parent).toBe(null);
    expect(d.changed).toEqual([]);
    expect(isEmptyItemsWireDelta(parseItemsWireDelta("{}"))).toBe(true);
  });
});
