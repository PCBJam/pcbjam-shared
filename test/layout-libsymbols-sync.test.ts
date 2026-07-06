import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  docToY,
  kicadLibSymbolsMap,
  syncLayoutToY,
  upsertLibSymbolsToY,
  Y_KDOC_LAYOUT,
  yToDoc,
} from "../src/kicad-y.js";
import {
  docToFile,
  fileToDoc,
  libSymbolsFromLayout,
  type Slot,
} from "../src/kicad-doc.js";
import {
  deltaToItemsWire,
  itemsWireToDelta,
  wireItemUuids,
  wireLibSymbols,
} from "../src/items-wire.js";

/** Miss 08 — non-item document state: lib_symbols channel + layout save-sync. */

const SYM_DEF = `(symbol "Device:R" (pin_numbers hide) (property "Reference" "R" (at 2.032 0 90)) (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54))))`;
const SYM_DEF2 = `(symbol "Device:C" (property "Reference" "C" (at 0.635 2.54 0)))`;

const SCH = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "11111111-1111-1111-1111-111111111111")
  (paper "A4")
  (title_block (title "Old title") (rev "A"))
  (lib_symbols ${SYM_DEF})
  (symbol (lib_id "Device:R") (at 100 50 0) (uuid "sym-1")
    (property "Reference" "R1" (at 100 45 0) (uuid "fld-1")))
  (wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (uuid "wire-1"))
  (sheet_instances (path "/" (page "1")))
)`;

describe("lib_symbols channel (miss 08A)", () => {
  it("docToY extracts defs into kdoc_libsymbols and blanks the layout slot", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(SCH), ydoc, "seed");
    expect(kicadLibSymbolsMap(ydoc).get("Device:R")).toContain(`"Device:R"`);
    const layout = ydoc.getArray<Slot>(Y_KDOC_LAYOUT).toArray();
    const slot = layout.find((s) => "k" in s && s.k === "lib_symbols");
    expect(slot && "k" in slot && slot.v).toEqual([]);
  });

  it("yToDoc re-injects the definitions; docToFile carries them", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(SCH), ydoc, "seed");
    const out = docToFile(yToDoc(ydoc));
    expect(out).toContain(`(lib_symbols (symbol "Device:R"`);
    expect(out).toContain(`(lib_id "Device:R")`); // the instance survives too
  });

  it("a wire-carried definition lands in the map and re-materializes sorted", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(SCH), ydoc, "seed");
    // A peer places a NEW symbol: the emit's multi-form blob carries the def.
    const wire = {
      added: [
        {
          sexpr: `(lib_symbols ${SYM_DEF2}) (symbol (lib_id "Device:C") (at 120 60 0) (uuid "sym-2"))`,
          parent: null,
        },
      ],
      changed: [],
      removed: [],
    };
    const defs = wireLibSymbols(wire);
    expect(Object.keys(defs)).toEqual(["Device:C"]);
    upsertLibSymbolsToY(ydoc, defs, "edit");
    applyDeltaToY(ydoc, itemsWireToDelta(wire, {}), "edit");

    const out = docToFile(yToDoc(ydoc));
    // Both defs present, sorted by lib id (KiCad's own writer order).
    expect(out.indexOf(`(symbol "Device:C"`)).toBeGreaterThan(0);
    expect(out.indexOf(`(symbol "Device:C"`)).toBeLessThan(out.indexOf(`(symbol "Device:R"`));
  });

  it("deltaToItemsWire prefixes a symbol's definition for the apply side", () => {
    const doc = fileToDoc(SCH);
    const delta = {
      added: [{ uuid: "sym-1", ...doc.items["sym-1"]! }],
      updated: [],
      removed: [],
    };
    const defs = libSymbolsFromLayout(doc.layout, doc.items);
    const wire = deltaToItemsWire(delta, doc.items, (id) => defs[id]);
    expect(wire.added[0]!.sexpr).toMatch(/^\(lib_symbols \(symbol "Device:R"/);
    expect(wire.added[0]!.sexpr).toContain(`(lib_id "Device:R")`);
    // Non-symbol items get no prefix.
    const wireDelta = deltaToItemsWire(
      { added: [{ uuid: "wire-1", ...doc.items["wire-1"]! }], updated: [], removed: [] },
      doc.items,
      (id) => defs[id],
    );
    expect(wireDelta.added[0]!.sexpr).not.toContain("lib_symbols");
  });

  it("wireItemUuids flattens subtrees", () => {
    const doc = fileToDoc(SCH);
    const wire = deltaToItemsWire(
      { added: [{ uuid: "sym-1", ...doc.items["sym-1"]! }], updated: [], removed: [] },
      doc.items,
    );
    const ids = wireItemUuids(wire);
    expect(ids.has("sym-1")).toBe(true);
    expect(ids.has("fld-1")).toBe(true); // nested field
  });
});

describe("layout save-sync (miss 08B)", () => {
  function seeded(): Y.Doc {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(SCH), ydoc, "seed");
    return ydoc;
  }

  it("a title_block edit in the saved file replaces the doc's group", () => {
    const ydoc = seeded();
    const saved = SCH.replace(`(title "Old title")`, `(title "New title")`);
    expect(syncLayoutToY(fileToDoc(saved), ydoc, "save")).toBe(true);
    expect(docToFile(yToDoc(ydoc))).toContain(`(title "New title")`);
    // Idempotent: a second sync of the same file changes nothing.
    expect(syncLayoutToY(fileToDoc(saved), ydoc, "save")).toBe(false);
  });

  it("item slots and item bodies are never touched", () => {
    const ydoc = seeded();
    // The saved file has the wire at a DIFFERENT position (an unsynced editor
    // nuance) — layout sync must not care: items are the item channel's job.
    const saved = SCH.replace("(xy 50.8 50.8)", "(xy 60 60)").replace(
      `(title "Old title")`,
      `(title "T2")`,
    );
    syncLayoutToY(fileToDoc(saved), ydoc, "save");
    const out = docToFile(yToDoc(ydoc));
    expect(out).toContain("(xy 50.8 50.8)"); // item body untouched
    expect(out).toContain(`(title "T2")`); // layout group updated
  });

  it("a removed head is deleted; a new head lands before the first item", () => {
    const ydoc = seeded();
    const saved = SCH.replace(`  (title_block (title "Old title") (rev "A"))\n`, "");
    syncLayoutToY(fileToDoc(saved), ydoc, "save");
    expect(docToFile(yToDoc(ydoc))).not.toContain("title_block");

    const withNew = saved.replace(`(paper "A4")`, `(paper "A4")\n  (text_size 1.5)`);
    syncLayoutToY(fileToDoc(withNew), ydoc, "save");
    const out = docToFile(yToDoc(ydoc));
    // Before the first ITEM slot (the placed symbol instance) — the injected
    // lib_symbols defs legitimately render earlier.
    expect(out.indexOf("(text_size")).toBeLessThan(out.indexOf("(symbol (lib_id"));
  });

  it("net table stays seed-frozen; lib_symbols defs are additive-only", () => {
    const PCB = `(kicad_pcb (version 20241229) (generator "pcbnew")
      (net 0 "") (net 1 "SIG")
      (segment (start 0 0) (end 1 1) (uuid "seg-1"))
    )`;
    const ydoc = new Y.Doc();
    docToY(fileToDoc(PCB), ydoc, "seed");
    const saved = PCB.replace(`(net 1 "SIG")`, `(net 1 "RENAMED")`);
    syncLayoutToY(fileToDoc(saved), ydoc, "save");
    expect(docToFile(yToDoc(ydoc))).toContain(`(net 1 "SIG")`); // frozen

    const sch = seeded();
    upsertLibSymbolsToY(sch, { "Device:C": SYM_DEF2 }, "peer");
    // The local save doesn't know Device:C — the sync must not delete it.
    syncLayoutToY(fileToDoc(SCH), sch, "save");
    expect(kicadLibSymbolsMap(sch).get("Device:C")).toBe(SYM_DEF2);
  });
});
