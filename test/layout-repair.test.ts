import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docToFile,
  duplicateSingletonHeadIndices,
  fileToDoc,
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
 * retracts its whole block. The repair must stay out of that race — deleting a
 * header copy by position here plus the retraction deleted BOTH copies whenever
 * the loser was the earlier block (ysync-two-tab "concurrent seed" e2e).
 */
describe("double seed is left to seedNonce arbitration", () => {
  for (const loserFirst of [true, false]) {
    it(`repairLayoutY is a no-op on a double seed and the retraction leaves one header (loser block ${loserFirst ? "first" : "last"})`, () => {
      const winner = new Y.Doc();
      const loser = new Y.Doc();
      winner.clientID = loserFirst ? 2 : 1;
      loser.clientID = loserFirst ? 1 : 2;
      seedDocToY(fileToDoc(FILE), winner, "seed", "nonce-winner");
      const retract = seedDocToY(fileToDoc(FILE), loser, "seed", "nonce-loser");
      Y.applyUpdate(winner, Y.encodeStateAsUpdate(loser));
      Y.applyUpdate(loser, Y.encodeStateAsUpdate(winner));

      expect(duplicateSingletonHeadIndices(yToDoc(winner).layout)).toEqual([]);
      expect(repairLayoutY(winner, "x")).toBe(false);
      expect(repairLayoutY(loser, "x")).toBe(false);

      retract();
      Y.applyUpdate(winner, Y.encodeStateAsUpdate(loser));
      const text = docToFile(yToDoc(winner));
      expect((text.match(/\(version /g) ?? []).length).toBe(1);
      expect(text).toBe(docToFile(fileToDoc(FILE)));
    });
  }
});
