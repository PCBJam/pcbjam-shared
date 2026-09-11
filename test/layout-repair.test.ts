import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  docToFile,
  duplicateLayoutIndices,
  duplicateSingletonHeadIndices,
  fileToDoc,
  itemsWireToDelta,
  kicadItemsMap,
  parseItemsWireDelta,
  repairLayoutY,
  seedDocToY,
  syncLayoutToY,
  yToDoc,
} from "../src/index.js";

const FILE = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0")
  (uuid "20000000-0000-0000-0000-000000000000") (paper "A4")
  (lib_symbols)
  (wire (pts (xy 25.4 25.4) (xy 76.2 25.4)) (stroke (width 0) (type default)) (uuid "aaaaaaaa-0000-0000-0000-000000000001"))
  (sheet_instances (path "/" (page "1")))
)
`;

/**
 * A layout-only save-sync (session 1) merged with a file seed that never saw it
 * (session 2). Concurrent inserts at index 0 are ordered by clientID, so the
 * hollow block can land before OR after the seed block — cover both.
 */
function mergedDoubleHeader(hollowFirst = true): Y.Doc {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.clientID = hollowFirst ? 1 : 2;
  b.clientID = hollowFirst ? 2 : 1;
  syncLayoutToY(fileToDoc(FILE), a, "layout-save");
  seedDocToY(fileToDoc(FILE), b, "seed", "nonce");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return a;
}

describe("duplicated singleton header groups (ysync 0011 follow-up)", () => {
  it("the merge really does produce a second header block", () => {
    const doc = yToDoc(mergedDoubleHeader());
    expect(duplicateSingletonHeadIndices(doc.layout).length).toBeGreaterThan(0);
  });

  for (const hollowFirst of [true, false]) {
    it(`docToFile renders ONE header from an unrepaired doc (hollow block ${hollowFirst ? "first" : "last"})`, () => {
      const text = docToFile(yToDoc(mergedDoubleHeader(hollowFirst)));
      expect((text.match(/\(version /g) ?? []).length).toBe(1);
      expect((text.match(/\(sheet_instances /g) ?? []).length).toBe(1);
      // Byte-identical to the file: the surviving header is the one before the items.
      expect(text).toBe(docToFile(fileToDoc(FILE)));
    });
  }

  for (const hollowFirst of [true, false]) {
  it(`repairLayoutY deletes the repeats, idempotent + convergent (hollow block ${hollowFirst ? "first" : "last"})`, () => {
    const a = mergedDoubleHeader(hollowFirst);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(repairLayoutY(a, "x")).toBe(true);
    expect(repairLayoutY(b, "x")).toBe(true); // concurrent repair on a peer
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(duplicateSingletonHeadIndices(yToDoc(a).layout)).toEqual([]);
    expect(yToDoc(a).layout).toEqual(yToDoc(b).layout);
    expect(repairLayoutY(a, "x")).toBe(false);
    expect(docToFile(yToDoc(a))).toBe(docToFile(fileToDoc(FILE)));
  });
  }
});

/**
 * Bug 06 double seed: two clients seeded the same fresh room. Both blocks carry
 * the header AND the items; `seedNonce` LWW picks the winner and the loser
 * retracts its whole block. Repair used to stay out of that race entirely
 * (deleting a header copy by position plus the retraction deleted BOTH copies
 * whenever the loser was the earlier block). It now keys the surviving copy
 * off the WINNER's client (the nonce is `${clientID}:…`, ysync 0012 #3), so
 * repair deletes exactly what the loser's retractor would — the two agree, and
 * a loser that disconnected before retracting is healed by anyone.
 */
describe("double seed: repair agrees with seedNonce arbitration", () => {
  // Concurrent Y.Map sets resolve to the HIGHER clientID, so the loser is the
  // lower client — and concurrent inserts at index 0 order lower client first,
  // so the loser's block is always the EARLIER one: exactly the case the old
  // positional repair got wrong (it kept the loser's header, the retraction
  // then removed it).
  function doubleSeed() {
    const one = new Y.Doc();
    const two = new Y.Doc();
    one.clientID = 1;
    two.clientID = 2;
    const retractors = new Map<Y.Doc, () => void>();
    retractors.set(one, seedDocToY(fileToDoc(FILE), one, "seed", "1:one"));
    retractors.set(two, seedDocToY(fileToDoc(FILE), two, "seed", "2:two"));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    const nonce = one.getMap("kdoc_meta").get("seedNonce");
    expect(nonce).toBe("2:two");
    const winner = two;
    const loser = one;
    return { winner, loser, retract: retractors.get(loser)! };
  }

  it("the loser's block merges FIRST (the variant positional repair mishandled)", () => {
    const { winner } = doubleSeed();
    const layout = yToDoc(winner).layout;
    const firstVersion = layout.findIndex((s) => "k" in s && s.k === "version");
    const firstItem = layout.findIndex((s) => "item" in s);
    expect(firstVersion).toBeLessThan(firstItem);
    expect(layout.filter((s) => "item" in s)).toHaveLength(2);
  });

  it("repair + retraction leave ONE header and ONE of each item", () => {
    const { winner, loser, retract } = doubleSeed();
    // Unrepaired, the render already shows each root once.
    expect((docToFile(yToDoc(winner)).match(/\(wire /g) ?? []).length).toBe(1);

    expect(repairLayoutY(winner, "x")).toBe(true);
    retract(); // the loser retracts on its own replica concurrently
    Y.applyUpdate(winner, Y.encodeStateAsUpdate(loser));
    Y.applyUpdate(loser, Y.encodeStateAsUpdate(winner));
    expect(yToDoc(winner).layout).toEqual(yToDoc(loser).layout);
    expect(duplicateLayoutIndices(yToDoc(winner).layout)).toEqual([]);
    const text = docToFile(yToDoc(winner));
    expect((text.match(/\(version /g) ?? []).length).toBe(1);
    expect(text).toBe(docToFile(fileToDoc(FILE)));
  });

  it("heals a double seed after the losing seeder disconnected", () => {
    const { winner } = doubleSeed(); // the loser never retracts
    expect(repairLayoutY(winner, "x")).toBe(true);
    expect(repairLayoutY(winner, "x")).toBe(false);
    expect(duplicateLayoutIndices(yToDoc(winner).layout)).toEqual([]);
    expect(docToFile(yToDoc(winner))).toBe(docToFile(fileToDoc(FILE)));
  });

  it("repair on the LOSER's replica before it retracts deletes the same slots", () => {
    const { winner, loser } = doubleSeed();
    expect(repairLayoutY(loser, "x")).toBe(true);
    Y.applyUpdate(winner, Y.encodeStateAsUpdate(loser));
    expect(repairLayoutY(winner, "x")).toBe(false);
    expect(docToFile(yToDoc(winner))).toBe(docToFile(fileToDoc(FILE)));
  });
});

describe("root refs: the item map is membership truth, layout refs are an order hint (ysync 0012 #3)", () => {
  const upsert = (doc: Y.Doc, sexpr: string) =>
    applyDeltaToY(
      doc,
      itemsWireToDelta(
        parseItemsWireDelta(JSON.stringify({ changed: [{ sexpr, parent: null }] })),
        yToDoc(doc).items,
      ),
      "peer",
    );
  const WIRE = `(wire (pts (xy 25.4 25.4) (xy 76.2 25.4)) (stroke (width 0) (type default)) (uuid "aaaaaaaa-0000-0000-0000-000000000001"))`;

  it("renders a concurrently restored root once and both replicas converge", () => {
    const a = new Y.Doc();
    seedDocToY(fileToDoc(FILE), a, "seed", "runner:initialized");
    applyDeltaToY(a, { added: [], updated: [], removed: ["aaaaaaaa-0000-0000-0000-000000000001"] });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    upsert(a, WIRE); // both replicas restore the same uuid (undo, stale snapshot…)
    upsert(b, WIRE);
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub);
    Y.applyUpdate(b, ua);
    expect(a.getArray("kdoc_layout").toArray().filter((s) => "item" in (s as object)).length).toBe(2);
    // Read side alone already renders once …
    expect((docToFile(yToDoc(a)).match(/\(wire /g) ?? []).length).toBe(1);
    // … and repair converges the doc itself.
    expect(repairLayoutY(a, "x")).toBe(true);
    expect(repairLayoutY(b, "x")).toBe(true);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(yToDoc(a).layout).toEqual(yToDoc(b).layout);
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
    // (byte order differs from FILE: a live re-add appends its ref, by design)
    expect((docToFile(yToDoc(a)).match(/\(wire /g) ?? []).length).toBe(1);
    expect(yToDoc(a).layout.filter((s) => "item" in s)).toHaveLength(1);
  });

  it("a root whose layout ref was lost still renders, and repair re-links it", () => {
    const a = new Y.Doc();
    seedDocToY(fileToDoc(FILE), a, "seed", "1:n");
    const layout = a.getArray("kdoc_layout");
    const idx = layout.toArray().findIndex((s) => "item" in (s as object));
    layout.delete(idx, 1); // e.g. a concurrent delete whose item-map delete lost to a set
    expect(kicadItemsMap(a).size).toBe(1);
    expect(docToFile(yToDoc(a))).toBe(docToFile(fileToDoc(FILE)));
    expect(repairLayoutY(a, "x")).toBe(true);
    expect(yToDoc(a).layout.filter((s) => "item" in s)).toHaveLength(1);
    expect(repairLayoutY(a, "x")).toBe(false);
  });
});
