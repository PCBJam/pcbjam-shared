/** Client-side snapshot reconciliation and update composition primitives. */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docToY,
  mergeYUpdates,
  upsertDocToY,
  yToDoc,
} from "../src/kicad-y.js";
import { docToFile, fileToDoc, type Slot } from "../src/kicad-doc.js";

const BASE = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
  (segment (start 2 2) (end 3 3) (width 0.2) (uuid "seg-2"))
  (via (at 5 5) (size 0.8) (uuid "via-1"))
)`;

function seeded(): Y.Doc {
  const ydoc = new Y.Doc();
  docToY(fileToDoc(BASE), ydoc);
  return ydoc;
}

function snapshot(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc);
}

/** Move seg-1 by rewriting its (start …) slot. */
function moveSeg1(ydoc: Y.Doc, x: number): void {
  const doc = yToDoc(ydoc);
  const seg = doc.items["seg-1"]!;
  seg.body = seg.body.map(
    (s): Slot =>
      "k" in s && s.k === "start" ? { k: "start", v: [{ atom: `${x}` }, { atom: "0" }] } : s,
  );
  upsertDocToY(doc, ydoc, "test-edit");
}

describe("upsertDocToY — minimal diff", () => {
  it("identical content writes nothing (the ≤2-byte empty diff)", () => {
    const ydoc = seeded();
    const sv = Y.encodeStateVector(ydoc);
    upsertDocToY(yToDoc(ydoc), ydoc, "noop");
    expect(Y.encodeStateAsUpdate(ydoc, sv).length).toBeLessThanOrEqual(2);
  });

  it("an item edit touches only that item; unchanged items keep their state", () => {
    const ydoc = seeded();
    const before = Y.encodeStateAsUpdate(ydoc).length;
    moveSeg1(ydoc, 9);
    const out = yToDoc(ydoc);
    expect(docToFile(out)).toContain("(start 9 0)");
    // seg-2/via-1 unchanged, layout untouched → the doc grew by a slot write,
    // not by a reseed (a wholesale rewrite would roughly double the state).
    expect(Y.encodeStateAsUpdate(ydoc).length).toBeLessThan(before * 1.5);
  });

  it("applies additions and deletions", () => {
    const ydoc = seeded();
    const doc = yToDoc(ydoc);
    delete doc.items["seg-2"];
    doc.layout = doc.layout.filter((slot) => !("item" in slot && slot.item === "seg-2"));
    upsertDocToY(doc, ydoc, "del");
    expect(yToDoc(ydoc).items["seg-2"]).toBeUndefined();
    expect(Object.keys(yToDoc(ydoc).items)).toHaveLength(2);
  });
});

describe("mergeYUpdates — bisect composer", () => {
  it("re-merging frames already contained in the base is a no-op", () => {
    const ydoc = seeded();
    const frames: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => frames.push(u));
    moveSeg1(ydoc, 3);
    moveSeg1(ydoc, 4);
    const full = snapshot(ydoc);

    // base already contains everything → merged state renders identically.
    const merged = mergeYUpdates([full, ...frames]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, merged);
    expect(docToFile(yToDoc(doc))).toBe(docToFile(yToDoc(ydoc)));
  });

  it("prefixes reproduce intermediate states (what the bisect lints)", () => {
    const ydoc = seeded();
    const base = snapshot(ydoc);
    const frames: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => frames.push(u));
    moveSeg1(ydoc, 3);
    const afterFirst = docToFile(yToDoc(ydoc));
    moveSeg1(ydoc, 4);

    const midDoc = new Y.Doc();
    Y.applyUpdate(midDoc, mergeYUpdates([base, frames[0]!]));
    expect(docToFile(yToDoc(midDoc))).toBe(afterFirst);
  });
});
