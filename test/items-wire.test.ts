import { describe, expect, it } from "vitest";
import {
  deltaToItemsWire,
  descendants,
  isEmptyItemsWireDelta,
  itemsWireToDelta,
  parseItemsWireDelta,
  wireItemUuids,
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

  it("a lone child update lifts to its root's full re-render", () => {
    // A bare child blob cannot be re-attached by the C++ appliers (pcbnew's
    // envelope wrap even makes a lone pad unparseable — drift-trio finding,
    // standalone-hardening 0008): the wire must carry the parent footprint.
    const view = current();
    const wire = deltaToItemsWire(
      { added: [], updated: [{ uuid: "pad-1", ...view["pad-1"]! }], removed: [] },
      view,
    );
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.parent).toBe(null);
    expect(parseSexpr(wire.changed[0]!.sexpr)).toEqual(parseSexpr(FP)); // full subtree
  });

  it("a child added under a surviving root becomes the root's content change", () => {
    const view = current();
    const newPad: (typeof view)[string] = {
      type: "pad",
      parent: "fp-1",
      body: view["pad-1"]!.body,
    };
    const wire = deltaToItemsWire(
      { added: [{ uuid: "pad-9", ...newPad }], updated: [], removed: [] },
      { ...view, "pad-9": newPad },
    );
    expect(wire.added).toHaveLength(0);
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.parent).toBe(null);
  });

  it("a changed child whose root is removed in the same delta is dropped", () => {
    const view = current();
    const wire = deltaToItemsWire(
      { added: [], updated: [{ uuid: "pad-1", ...view["pad-1"]! }], removed: ["fp-1"] },
      view,
    );
    expect(wire.added).toHaveLength(0);
    expect(wire.changed).toHaveLength(0);
    expect(wire.removed).toEqual(["fp-1"]);
  });

  it("a dangling parent chain falls back to the child itself", () => {
    const view = current();
    const orphan: (typeof view)[string] = {
      type: "pad",
      parent: "gone-1",
      body: view["pad-1"]!.body,
    };
    const wire = deltaToItemsWire(
      { added: [], updated: [{ uuid: "pad-x", ...orphan }], removed: [] },
      { ...view, "pad-x": orphan },
    );
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.parent).toBe("gone-1");
  });
});

describe("unwrapWireItem (native tool blob shapes)", () => {
  it("pl_editor-style (kicad_wks …) envelope unwraps to the item", () => {
    const wire = parseItemsWireDelta(
      JSON.stringify({
        added: [
          {
            sexpr: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (tbtext "Title" (uuid "t-1") (pos 100 20 ltcorner)))`,
          },
        ],
      }),
    );
    const d = itemsWireToDelta(wire, {});
    expect(d.added.map((i) => i.uuid)).toEqual(["t-1"]);
    expect(d.added[0]!.type).toBe("tbtext");
  });

  it("pcbnew-style (kicad_pcb …) envelope with layers unwraps to the item", () => {
    const wire = parseItemsWireDelta(
      JSON.stringify({
        changed: [
          {
            sexpr: `(kicad_pcb (version 20241229) (generator "pcbnew") (layers (0 "F.Cu" signal))
  (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (uuid "s-1")))`,
          },
        ],
      }),
    );
    const d = itemsWireToDelta(wire, {});
    expect(d.added.map((i) => i.uuid)).toEqual(["s-1"]); // not in current → added
  });

  it("eeschema-style multi-form (lib_symbols + symbol) unwraps to the symbol", () => {
    const wire = parseItemsWireDelta(
      JSON.stringify({
        added: [
          {
            sexpr: `(lib_symbols (symbol "Device:R" (pin_numbers hide)))
(symbol (lib_id "Device:R") (at 10 10 0) (uuid "sym-1") (property "Reference" "R1" (at 0 0 0)))`,
          },
        ],
      }),
    );
    const d = itemsWireToDelta(wire, {});
    expect(d.added.map((i) => i.uuid)).toEqual(["sym-1"]);
  });

  it("skips payloads with zero or multiple uuid items instead of throwing", () => {
    // A skipped entry must never abort conversion (the batch-loss bug): the
    // caller learns about it through onSkip, the delta stays usable.
    const skipped: Array<{ sexpr: string; err: unknown }> = [];
    const d = itemsWireToDelta(
      parseItemsWireDelta(JSON.stringify({ added: [{ sexpr: "(layers (0 \"F.Cu\"))" }] })),
      {},
      (w, err) => skipped.push({ sexpr: w.sexpr, err }),
    );
    expect(d.added).toEqual([]);
    expect(d.updated).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0]!.err)).toMatch(/expected exactly 1/);
  });
});

describe("un-resolvable entry does not discard the batch", () => {
  // The field-blob shape from the field: pcbnew's writer emits NOTHING for a
  // standalone PCB_FIELD_T, so blobForItem yields a board envelope with no
  // item in it (`(kicad_pcb … (layers …))` and nothing else).
  const EMPTY_ENVELOPE =
    `(kicad_pcb (version 20241229) (generator "pcbnew") (layers (0 "F.Cu" signal)))`;

  it("converts the good entries and reports the bad one (the 67-entry loss)", () => {
    const movedFp = FP.replace("(at 10 10)", "(at 66.6 55.5)");
    const skipped: string[] = [];
    const d = itemsWireToDelta(
      parseItemsWireDelta(
        JSON.stringify({
          changed: [{ sexpr: movedFp }, { sexpr: EMPTY_ENVELOPE }],
        }),
      ),
      current(),
      (w) => skipped.push(w.sexpr),
    );
    expect(d.updated.map((i) => i.uuid)).toEqual(["fp-1"]); // the move survived
    expect(d.removed).toEqual([]); // the skip removed nothing
    expect(skipped).toEqual([EMPTY_ENVELOPE]);
  });

  it("without an onSkip handler the bad entry is dropped silently", () => {
    const d = itemsWireToDelta(
      parseItemsWireDelta(JSON.stringify({ changed: [{ sexpr: EMPTY_ENVELOPE }, { sexpr: FP }] })),
      {},
    );
    expect(d.added.map((i) => i.uuid).sort()).toEqual(["fld-1", "fp-1", "pad-1", "pad-2"]);
  });

  it("wireItemUuids skips the same way (adopt path)", () => {
    const skipped: string[] = [];
    const uuids = wireItemUuids(
      parseItemsWireDelta(JSON.stringify({ added: [{ sexpr: EMPTY_ENVELOPE }, { sexpr: FP }] })),
      (w) => skipped.push(w.sexpr),
    );
    expect([...uuids].sort()).toEqual(["fld-1", "fp-1", "pad-1", "pad-2"]);
    expect(skipped).toEqual([EMPTY_ENVELOPE]);
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
