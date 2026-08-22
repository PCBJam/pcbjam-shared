import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  activeKicadState,
  compactYdocUpdate,
  docToY,
  kicadItemsMap,
} from "../src/kicad-y.js";
import { fileToDoc } from "../src/kicad-doc.js";

const PCB = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
)`;

function seeded(): Y.Doc {
  const ydoc = new Y.Doc({ gc: false });
  docToY(fileToDoc(PCB), ydoc, "seed");
  return ydoc;
}

describe("compaction forward-compatibility fence", () => {
  it("refuses to erase an unknown field beside the active-epoch pointer", () => {
    const ydoc = seeded();
    ydoc.getMap("kdoc_state").set("futureEpochIndex", {
      mustSurvive: true,
    });

    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc), { ratio: 0 })).toBeNull();
  });

  it("refuses to erase an unknown field inside the active v3 epoch", () => {
    const ydoc = seeded();
    const future = new Y.Map<unknown>();
    future.set("mustSurvive", { nested: [1, 2, 3] });
    activeKicadState(ydoc)!.set("futureFeature", future);

    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc), { ratio: 0 })).toBeNull();
  });

  it("refuses to erase an unknown field inside an item envelope", () => {
    const ydoc = seeded();
    kicadItemsMap(ydoc).get("seg-1")!.set("futureSemantics", {
      mustSurvive: true,
    });

    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc), { ratio: 0 })).toBeNull();
  });
});
