import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docToFile,
  fileToDoc,
  type KicadDoc,
  type Slot,
} from "../src/kicad-doc.js";
import { itemsWireToDelta, parseItemsWireDelta } from "../src/items-wire.js";
import { docToY, yToDoc } from "../src/kicad-y.js";

function firstField(slots: Slot[], head: string): Extract<Slot, { k: string }> {
  const slot = slots.find(
    (candidate): candidate is Extract<Slot, { k: string }> =>
      "k" in candidate && candidate.k === head,
  );
  if (!slot) throw new Error(`missing field ${head}`);
  return slot;
}

const SEGMENT = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1")))`;

describe("plain JSON values are isolated at the Yjs boundary", () => {
  it("does not retain caller-owned Slot trees on write", () => {
    const source = fileToDoc(SEGMENT);
    const ydoc = new Y.Doc();
    docToY(source, ydoc, "seed");
    const expected = docToFile(yToDoc(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

    firstField(source.items["seg-1"]!.body, "start").v[0] = { atom: "99" };

    expect(docToFile(yToDoc(ydoc))).toBe(expected);
    expect(docToFile(yToDoc(peer))).toBe(expected);
    expect(Y.encodeStateAsUpdate(ydoc, vector).length).toBeLessThanOrEqual(2);
  });

  it("does not expose Yjs-owned Slot trees on materialization", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(SEGMENT), ydoc, "seed");
    const expected = docToFile(yToDoc(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

    const snapshot = yToDoc(ydoc);
    firstField(snapshot.items["seg-1"]!.body, "start").v[0] = { atom: "99" };

    expect(docToFile(yToDoc(ydoc))).toBe(expected);
    expect(docToFile(yToDoc(peer))).toBe(expected);
    expect(Y.encodeStateAsUpdate(ydoc, vector).length).toBeLessThanOrEqual(2);
  });
});

describe("UUID identity is unambiguous at every trust boundary", () => {
  it("rejects duplicate UUID-bearing source forms instead of demoting one inline", () => {
    expect(() => fileToDoc(
      `(kicad_pcb
        (segment (start 0 0) (end 1 1) (uuid "same"))
        (via (at 2 2) (size 1) (uuid "same")))`,
    )).toThrow(/duplicate.*uuid/i);
  });

  it("rejects a map key that disagrees with the direct native UUID field", () => {
    const malformed: KicadDoc = {
      root: "kicad_pcb",
      layout: [{ item: "map-key" }],
      items: {
        "map-key": {
          type: "segment",
          parent: null,
          body: [{ k: "uuid", v: [{ atom: '"body-key"' }] }],
        },
      },
    };
    expect(() => docToY(malformed, new Y.Doc(), "must-reject")).toThrow(/uuid/i);
  });

  it("supports prototype-like UUID strings without changing record semantics", () => {
    const parsed = fileToDoc(
      `(kicad_pcb (segment (start 0 0) (end 1 1) (uuid "__proto__")))`,
    );
    expect(Object.hasOwn(parsed.items, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed.items)).toBeNull();
    expect(docToFile(parsed)).toContain('(uuid "__proto__")');
  });
});

describe("wire recovery is limited to the known pcbnew empty envelope", () => {
  it("rejects an item-like payload that lost its UUID", () => {
    const wire = parseItemsWireDelta(JSON.stringify({
      changed: [{ sexpr: `(segment (start 0 0) (end 1 1) (width 0.2))` }],
    }));
    expect(() => itemsWireToDelta(wire, {})).toThrow(/uuid|missing/i);
  });
});
