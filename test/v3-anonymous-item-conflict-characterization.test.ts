import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docToFile, fileToDoc } from "../src/kicad-doc.js";
import { docToY, kicadItemsMap, upsertDocToY, yToDoc } from "../src/kicad-y.js";

const BASE = fileToDoc(`(kicad_pcb
  (mystery
    (width 0.2)
    (xy 0 0)
    (xy 1 1)
    (uuid "item-1")))`);

const WIDTH_EDIT = fileToDoc(`(kicad_pcb
  (mystery
    (width 0.8)
    (xy 0 0)
    (xy 1 1)
    (uuid "item-1")))`);

const SEQUENCE_EDIT = fileToDoc(`(kicad_pcb
  (mystery
    (width 0.2)
    (xy 9 9)
    (xy 0 0)
    (xy 1 1)
    (uuid "item-1")))`);

const BOTH_INTENTS = fileToDoc(`(kicad_pcb
  (mystery
    (width 0.8)
    (xy 9 9)
    (xy 0 0)
    (xy 1 1)
    (uuid "item-1")))`);

function hydrate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

describe("v3 direct-anonymous item conflict boundary", () => {
  it("converges on one whole authored body and therefore drops one disjoint intent", () => {
    const seed = new Y.Doc();
    docToY(BASE, seed, "seed");
    const body = kicadItemsMap(seed).get("item-1")!.get("body");

    // This plain register is deliberate. A direct repeated anonymous head has
    // no stable child identity, so v3 widens its conflict domain to the item
    // body instead of letting positional fields merge into an unauthored hybrid.
    expect(Array.isArray(body)).toBe(true);

    const baseUpdate = Y.encodeStateAsUpdate(seed);
    const baseVector = Y.encodeStateVector(seed);
    const branch = (clientID: number, value: typeof BASE): Uint8Array => {
      const replica = hydrate(baseUpdate);
      replica.clientID = clientID;
      upsertDocToY(value, replica, `writer-${clientID}`);
      return Y.encodeStateAsUpdate(replica, baseVector);
    };
    const widthUpdate = branch(700_001, WIDTH_EDIT);
    const sequenceUpdate = branch(700_002, SEQUENCE_EDIT);

    const deliveries: Uint8Array[][] = [
      [widthUpdate, sequenceUpdate],
      [sequenceUpdate, widthUpdate],
      [widthUpdate, widthUpdate, sequenceUpdate, sequenceUpdate],
      [Y.mergeUpdates([sequenceUpdate, widthUpdate, sequenceUpdate])],
    ];
    const results = deliveries.map((updates) => {
      const replica = hydrate(baseUpdate);
      for (const update of updates) Y.applyUpdate(replica, update);
      return docToFile(yToDoc(replica));
    });

    expect(new Set(results).size, "delivery order/batching/duplicates converge").toBe(1);
    expect(
      [WIDTH_EDIT, SEQUENCE_EDIT].map(docToFile),
      "the winner is one complete body actually authored by a client",
    ).toContain(results[0]);
    expect(
      results[0],
      "v3 cannot preserve both disjoint intents across this widened conflict domain",
    ).not.toBe(docToFile(BOTH_INTENTS));
  });
});

/*
 * Refining only the repeated `xy` group requires a new tagged group register or
 * an identity-bearing sequence. Neither representation exists in v3. Reusing an
 * ordinary `xy#N` value would make existing v3 readers decode the group as one
 * nested `(xy (xy ...) ...)`, while adding a new sentinel key would make them
 * render/overwrite an unknown field. Therefore finer merging requires a
 * protocol-version bump (and migration/old-writer exclusion), not a silent v3
 * codec change.
 */
