import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  docToY,
  kicadItemsMap,
  seedDocToY,
  syncLayoutToY,
  Y_KDOC_META,
  Y_KDOC_SEED_NONCE,
  yToDoc,
} from "../src/kicad-y.js";
import {
  docToFile,
  field,
  fileToDoc,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "../src/kicad-doc.js";
import { itemsWireToDelta, type ItemsWireDelta } from "../src/items-wire.js";

function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

function atoms(...values: string[]): Slot[] {
  return values.map((atom) => ({ atom }));
}

function editItem(ydoc: Y.Doc, uuid: string, mutate: (body: Slot[]) => Slot[]): void {
  const item = yToDoc(ydoc).items[uuid]!;
  applyDeltaToY(ydoc, {
    added: [],
    updated: [{ uuid, ...item, body: mutate(item.body) }],
    removed: [],
  });
}

function replaceField(body: Slot[], head: string, value: Slot[]): Slot[] {
  return body.map((slot) => ("k" in slot && slot.k === head ? { k: head, v: value } : slot));
}

describe("P0: a first-seed race selects one complete epoch", () => {
  const A = `(kicad_sch
    (version 20250114)
    (paper "A4")
    (lib_symbols (symbol "Device:R" (pin_numbers hide)))
    (wire (pts (xy 0 0) (xy 10 0)) (uuid "wire-a")))`;
  const B = `(kicad_sch
    (version 20250114)
    (paper "A3")
    (lib_symbols (symbol "Device:C" (pin_names hide)))
    (junction (at 20 20) (diameter 0) (uuid "junction-b")))`;

  it("never leaves items or library definitions from the losing seed", () => {
    const docA = fileToDoc(A);
    const docB = fileToDoc(B);
    const a = new Y.Doc();
    const b = new Y.Doc();
    const reconcileA = seedDocToY(docA, a, "seed-a", "nonce-a");
    const reconcileB = seedDocToY(docB, b, "seed-b", "nonce-b");

    exchange(a, b);
    const winner = a.getMap(Y_KDOC_META).get(Y_KDOC_SEED_NONCE);
    expect(b.getMap(Y_KDOC_META).get(Y_KDOC_SEED_NONCE)).toBe(winner);
    if (winner !== "nonce-a") reconcileA();
    if (winner !== "nonce-b") reconcileB();
    exchange(a, b);

    const expected = winner === "nonce-a" ? docA : docB;
    for (const replica of [a, b]) {
      const actual = yToDoc(replica);
      expect(Object.keys(actual.items).sort()).toEqual(Object.keys(expected.items).sort());
      expect(docToFile(actual)).toBe(docToFile(expected));
    }
  });
});

describe("P0: one layout head is one conflict domain", () => {
  const BASE = `(kicad_pcb
    (version 20241229)
    (paper "A4")
    (segment (start 0 0) (end 1 1) (uuid "seg-1")))`;

  it("concurrent replacements yield exactly one complete paper group", () => {
    const a = new Y.Doc();
    docToY(fileToDoc(BASE), a);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    syncLayoutToY(fileToDoc(BASE.replace('"A4"', '"A3"')), a, "a");
    syncLayoutToY(fileToDoc(BASE.replace('"A4"', '"A5"')), b, "b");
    exchange(a, b);

    for (const replica of [a, b]) {
      const papers = yToDoc(replica).layout.filter(
        (slot): slot is { k: string; v: Slot[] } => "k" in slot && slot.k === "paper",
      );
      expect(papers).toHaveLength(1);
      expect([atoms('"A3"'), atoms('"A5"')]).toContainEqual(papers[0]!.v);
    }
  });
});

describe("P0: anonymous sequences resolve atomically", () => {
  const BASE = `(kicad_pcb
    (version 20241229)
    (gr_poly (pts (xy 0 0) (xy 1 1)) (uuid "poly-1")))`;

  it("insert-before versus edit-existing never creates a hybrid sequence", () => {
    const a = new Y.Doc();
    docToY(fileToDoc(BASE), a);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const basePts = field(yToDoc(a).items["poly-1"]!.body, "pts")!;
    const edited = [{ k: "xy", v: atoms("7", "7") }, basePts[1]!] satisfies Slot[];
    const inserted = [{ k: "xy", v: atoms("9", "9") }, ...basePts] satisfies Slot[];
    editItem(a, "poly-1", (body) => replaceField(body, "pts", edited));
    editItem(b, "poly-1", (body) => replaceField(body, "pts", inserted));
    exchange(a, b);

    const result = field(yToDoc(a).items["poly-1"]!.body, "pts")!;
    expect([edited, inserted]).toContainEqual(result);
    expect(field(yToDoc(b).items["poly-1"]!.body, "pts")).toEqual(result);
  });
});

describe("P0: the item graph is total, single-parented, and recoverable", () => {
  const ITEM: KicadItem = {
    type: "segment",
    parent: null,
    body: [{ k: "uuid", v: atoms('"seg-1"') }],
  };

  it("rejects an orphan before it enters Yjs", () => {
    const orphan: KicadDoc = { root: "kicad_pcb", items: { "seg-1": ITEM }, layout: [] };
    expect(() => docToY(orphan, new Y.Doc())).toThrow(/orphan|referenced exactly once/i);
  });

  it("rejects duplicate references before they enter Yjs", () => {
    const duplicate: KicadDoc = {
      root: "kicad_pcb",
      items: { "seg-1": ITEM },
      layout: [{ item: "seg-1" }, { item: "seg-1" }],
    };
    expect(() => docToY(duplicate, new Y.Doc())).toThrow(/duplicate|exactly once/i);
  });

  it("normalizes a dangling merged parent to a valid root", () => {
    const ydoc = new Y.Doc();
    docToY({ root: "kicad_pcb", items: { "seg-1": ITEM }, layout: [{ item: "seg-1" }] }, ydoc);
    kicadItemsMap(ydoc).get("seg-1")!.set("parent", "missing-parent");
    const repaired = yToDoc(ydoc);
    expect(repaired.items["seg-1"]!.parent).toBeNull();
    expect(repaired.layout.filter((slot) => "item" in slot && slot.item === "seg-1")).toHaveLength(1);
  });
});

describe("P0: malformed native wire batches are rejected atomically", () => {
  const VALID = `(segment (start 0 0) (end 1 1) (uuid "seg-1"))`;

  it("does not apply the valid prefix of a malformed batch", () => {
    const wire: ItemsWireDelta = {
      added: [
        { sexpr: VALID, parent: null },
        { sexpr: `(segment (uuid`, parent: null },
      ],
      changed: [],
      removed: [],
    };
    expect(() => itemsWireToDelta(wire, {})).toThrow(/parse|item|s-expr/i);
  });

  it("rejects one uuid appearing in incompatible operation categories", () => {
    const wire: ItemsWireDelta = {
      added: [{ sexpr: VALID, parent: null }],
      changed: [],
      removed: ["seg-1"],
    };
    expect(() => itemsWireToDelta(wire, {})).toThrow(/duplicate|category|removed/i);
  });
});
