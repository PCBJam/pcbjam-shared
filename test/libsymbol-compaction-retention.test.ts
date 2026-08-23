import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  compactYdocUpdate,
  docToY,
  kicadLibSymbolsMap,
  yToDoc,
} from "../src/kicad-y.js";
import { docToFile, fileToDoc } from "../src/kicad-doc.js";
import { itemsWireToDelta } from "../src/items-wire.js";

const RESISTOR_DEF =
  `(symbol "Device:R" (property "Reference" "R" (at 2.032 0 90)))`;

const SCHEMATIC = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "11111111-1111-1111-1111-111111111111")
  (lib_symbols ${RESISTOR_DEF})
  (symbol (lib_id "Device:R") (at 100 50 0) (uuid "sym-1"))
)`;

function hydrate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

describe("compactYdocUpdate — hidden library knowledge", () => {
  it("retains an orphan definition through compaction and reactivates it for a later consumer", () => {
    const source = new Y.Doc({ gc: false });
    docToY(fileToDoc(SCHEMATIC), source, "seed");
    applyDeltaToY(
      source,
      { added: [], updated: [], removed: ["sym-1"], reordered: [] },
      "remove-consumer",
    );

    // The definition is Yjs knowledge, not native content while unreferenced.
    expect(kicadLibSymbolsMap(source).get("Device:R")).toBe(RESISTOR_DEF);
    expect(docToFile(yToDoc(source))).not.toContain(`(symbol "Device:R"`);

    const result = compactYdocUpdate(Y.encodeStateAsUpdate(source), { ratio: 0 });
    expect(result?.reason).toBe("compaction");
    const compacted = hydrate(result!.update);

    // Compaction must preserve the same split: retained internally, hidden
    // from a native snapshot until an authoritative item references it.
    expect(kicadLibSymbolsMap(compacted).get("Device:R")).toBe(RESISTOR_DEF);
    expect(docToFile(yToDoc(compacted))).not.toContain(`(symbol "Device:R"`);

    const base = Y.encodeStateAsUpdate(compacted);
    const vector = Y.encodeStateVector(compacted);
    const author = new Y.Doc();
    Y.applyUpdate(author, base);
    applyDeltaToY(
      author,
      itemsWireToDelta(
        {
          added: [
            {
              sexpr: `(symbol (lib_id "Device:R") (at 120 60 0) (uuid "sym-later"))`,
              parent: null,
            },
          ],
          changed: [],
          removed: [],
        },
        {},
      ),
      "later-consumer",
    );
    const consumerUpdate = Y.encodeStateAsUpdate(author, vector);

    // Replayed/duplicate delivery is harmless and still has the definition
    // needed to materialize the later consumer.
    for (const count of [1, 2, 4]) {
      const replica = hydrate(base);
      for (let i = 0; i < count; i++) Y.applyUpdate(replica, consumerUpdate);
      expect(kicadLibSymbolsMap(replica).get("Device:R")).toBe(RESISTOR_DEF);
      const rendered = docToFile(yToDoc(replica));
      expect(rendered).toContain(`(symbol "Device:R"`);
      expect(rendered).toContain(`(lib_id "Device:R")`);
      expect(rendered).toContain("sym-later");
    }
  });
});
