import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docToFile, fileToDoc, type KicadDoc } from "../src/kicad-doc.js";
import { docToY, upsertDocToY, yToDoc } from "../src/kicad-y.js";

function hydrate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

function concurrentMerge(base: KicadDoc, left: KicadDoc, right: KicadDoc): KicadDoc[] {
  const seed = new Y.Doc();
  docToY(base, seed, "seed");
  const baseUpdate = Y.encodeStateAsUpdate(seed);
  const baseVector = Y.encodeStateVector(seed);

  const change = (clientID: number, value: KicadDoc): Uint8Array => {
    const replica = hydrate(baseUpdate);
    replica.clientID = clientID;
    upsertDocToY(value, replica, `writer-${clientID}`);
    return Y.encodeStateAsUpdate(replica, baseVector);
  };
  // Give the edit branch the higher Y.Map tie-break id. In the unsafe v2
  // positional encoding this selects its replacement of the first element
  // while still retaining the insert branch's extra elements: a forced hybrid.
  const updates = [change(900_002, left), change(900_001, right)];

  return [[0, 1], [1, 0]].map((order) => {
    const merged = hydrate(baseUpdate);
    for (const index of order) Y.applyUpdate(merged, updates[index]!);
    return yToDoc(merged);
  });
}

function expectOneAuthoredValue(
  merged: KicadDoc[],
  authored: readonly KicadDoc[],
): void {
  const actual = merged.map(docToFile);
  expect(new Set(actual).size).toBe(1);
  expect(authored.map(docToFile)).toContain(actual[0]);
}

describe("v3 conflict domains never manufacture a native snapshot hybrid", () => {
  it("keeps a direct anonymous repeated sequence atomic under insert-vs-edit", () => {
    const base = fileToDoc(
      `(kicad_pcb (mystery (xy 0 0) (xy 1 1) (uuid "item-1")))`,
    );
    const edited = fileToDoc(
      `(kicad_pcb (mystery (xy 7 7) (xy 1 1) (uuid "item-1")))`,
    );
    const inserted = fileToDoc(
      `(kicad_pcb (mystery (xy 9 9) (xy 0 0) (xy 1 1) (uuid "item-1")))`,
    );

    expectOneAuthoredValue(concurrentMerge(base, edited, inserted), [edited, inserted]);
  });

  it("keeps all leading positional atoms in one authored tuple", () => {
    const base = fileToDoc(
      `(kicad_pcb (pad "1" smd rect (uuid "pad-1")))`,
    );
    const shapeEdit = fileToDoc(
      `(kicad_pcb (pad "1" smd roundrect (uuid "pad-1")))`,
    );
    const kindEdit = fileToDoc(
      `(kicad_pcb (pad "1" thru_hole rect locked (uuid "pad-1")))`,
    );

    expectOneAuthoredValue(concurrentMerge(base, shapeEdit, kindEdit), [shapeEdit, kindEdit]);
  });

  it("keeps singleton semantic identity stable across a concurrent one-to-two transition", () => {
    const base = fileToDoc(
      `(kicad_pcb (thing (property "Reference" "R1") (uuid "item-1")))`,
    );
    const edited = fileToDoc(
      `(kicad_pcb (thing (property "Reference" "R2") (uuid "item-1")))`,
    );
    const added = fileToDoc(
      `(kicad_pcb (thing (property "Reference" "R1") (property "Value" "10k") (uuid "item-1")))`,
    );

    const merged = concurrentMerge(base, edited, added);
    expect(new Set(merged.map(docToFile)).size).toBe(1);
    for (const doc of merged) {
      const properties = doc.items["item-1"]!.body.filter(
        (slot) => "k" in slot && slot.k === "property",
      );
      expect(properties).toHaveLength(2);
      expect(properties.map((slot) => "k" in slot ? slot.v[0] : null)).toEqual([
        { atom: '"Reference"' },
        { atom: '"Value"' },
      ]);
      expect("k" in properties[0]! ? properties[0]!.v[1] : null).toEqual({ atom: '"R2"' });
    }
  });
});
