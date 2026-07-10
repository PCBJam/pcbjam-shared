import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  docToY,
  seedDocToY,
  Y_KDOC_LAYOUT,
  Y_KDOC_META,
  Y_KDOC_SEED_NONCE,
  yToDoc,
} from "../src/kicad-y.js";
import { docToFile, fileToDoc, renderItem, type Slot } from "../src/kicad-doc.js";

/**
 * Reproduction tests for the 2026-07-02 ysync review — shared-lib bugs
 * (docs/features/ysync-review on the ysync-review worktree/branch).
 *
 * Convention: each repro asserts the CORRECT behavior and is marked `it.fails`
 * with a comment naming the bug doc. The suite stays green while the bug is
 * open; fixing the bug flips the test to "unexpected pass", which forces the
 * marker's removal — the repro then becomes the regression test.
 */

const PCB = `(kicad_pcb
  (version 20241229)
  (footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
    (pad "1" smd (at 0 0) (uuid "pad-1")))
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
)`;

// ── Bug 03 — child-only removal leaves a dangling {item} slot ────────────────
// 03-bug-child-removal-dangling-slot.md: deleting a footprint user field emits
// exactly `{removed:[childUuid]}` (flushDiff lifts adds/changes to a parent
// re-blob but not removals). `applyDeltaToY` deletes the item from kdoc_items
// and cleans ROOT layout slots, but never prunes the `{item: uuid}` slot from
// the surviving PARENT's body → renderItem/docToFile throw "missing item".

describe("bug 03 — child-only removal leaves a dangling {item} slot in the parent body", () => {
  function removeChildOnly(): Y.Doc {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(PCB), ydoc, "seed");
    // The wire for "delete the Reference field": a bare child removal, no
    // parent re-blob alongside (the footprint's scalar baseline is unchanged).
    applyDeltaToY(ydoc, { added: [], updated: [], removed: ["fld-1"] }, "local-edit");
    return ydoc;
  }

  it("the parent still renders after a child-only removal", () => {
    const doc = yToDoc(removeChildOnly());
    expect(doc.items["fld-1"]).toBeUndefined(); // the item itself IS deleted
    // The parent's body no longer references the child (applyDeltaToY prunes
    // the {item} slot from the surviving parent), so it renders.
    const text = renderItem(doc, "fp-1");
    expect(text).not.toContain("fld-1");
    expect(text).toContain("pad-1"); // the sibling child survives
  });

  it("the doc still materializes (docToFile) after a child-only removal", () => {
    const doc = yToDoc(removeChildOnly());
    // The room stays materializable (the "file recoverable from the Y.Doc
    // alone" invariant, ysync 0005), whatever wire shape the emitter sent.
    const text = docToFile(doc);
    expect(text).not.toContain("fld-1");
    expect(text).toContain("seg-1"); // untouched root keeps its slot
  });
});

// ── Bug 06 — concurrent first-seed duplicates kdoc_layout ────────────────────
// 06-bug-concurrent-seed-duplicates-layout.md: seed-vs-adopt is a client-side
// check-then-act, so two clients opening the same fresh room can both observe
// "empty" and both seed. kdoc_meta/kdoc_items converge (Y.Map LWW), but
// kdoc_layout is a Y.Array: each client's delete sees only its own (empty)
// view, both insert sequences survive the merge, and nothing ever heals it.
// FIX: `seedDocToY` stamps a nonce into kdoc_meta in the seed transaction and
// returns a retractor; the LWW loser retracts exactly its own layout inserts
// (the runtime binding drives this off a kdoc_meta observer).

describe("bug 06 — concurrent first-seed, arbitrated (seedDocToY)", () => {
  function concurrentSeed() {
    const kdoc = fileToDoc(PCB);
    const a = new Y.Doc();
    const b = new Y.Doc();
    // Both clients pass the ydocHasState check before seeing each other (the
    // network round-trip window / the whole BroadcastChannel settleMs)…
    const retractA = seedDocToY(kdoc, a, "seed-a", "nonce-a");
    const retractB = seedDocToY(kdoc, b, "seed-b", "nonce-b");
    // …then their seed transactions exchange.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return { kdoc, a, b, retractA, retractB };
  }

  /** What the binding does on each client: the LWW loser retracts its inserts. */
  function arbitrate(s: ReturnType<typeof concurrentSeed>): void {
    const winner = s.a.getMap(Y_KDOC_META).get(Y_KDOC_SEED_NONCE);
    expect(s.b.getMap(Y_KDOC_META).get(Y_KDOC_SEED_NONCE)).toBe(winner); // same LWW outcome
    if (winner !== "nonce-a") s.retractA();
    if (winner !== "nonce-b") s.retractB();
    Y.applyUpdate(s.a, Y.encodeStateAsUpdate(s.b));
    Y.applyUpdate(s.b, Y.encodeStateAsUpdate(s.a));
  }

  it("both clients converge on the same merged state (CRDT determinism)", () => {
    const { a, b } = concurrentSeed();
    // Green baseline: the merge is deterministic on both docs — which is what
    // makes the nonce arbitration sound (both clients see the same winner).
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
  });

  it("the merged layout holds each root slot exactly once", () => {
    const s = concurrentSeed();
    arbitrate(s);
    const layout = s.a.getArray<Slot>(Y_KDOC_LAYOUT).toArray();
    const fpSlots = layout.filter((x) => "item" in x && x.item === "fp-1");
    expect(fpSlots).toHaveLength(1);
  });

  it("the merged doc materializes the single-seed output", () => {
    const s = concurrentSeed();
    arbitrate(s);
    const single = new Y.Doc();
    docToY(s.kdoc, single);
    // Same file, same room → same materialization as one seeder, on BOTH tabs.
    expect(docToFile(yToDoc(s.a))).toBe(docToFile(yToDoc(single)));
    expect(docToFile(yToDoc(s.b))).toBe(docToFile(yToDoc(single)));
  });

  it("retraction only removes the seed's own inserts — later edits survive", () => {
    const s = concurrentSeed();
    // The loser appends a NEW root slot (a later local edit) before arbitration fires.
    const winner = s.a.getMap(Y_KDOC_META).get(Y_KDOC_SEED_NONCE);
    const loserDoc = winner === "nonce-a" ? s.b : s.a;
    applyDeltaToY(
      loserDoc,
      {
        added: [
          {
            uuid: "seg-2",
            type: "segment",
            parent: null,
            body: [
              { k: "start", v: [{ atom: "5" }, { atom: "5" }] },
              { k: "end", v: [{ atom: "6" }, { atom: "6" }] },
            ],
          },
        ],
        updated: [],
        removed: [],
      },
      "edit",
    );
    arbitrate(s);
    const layout = s.a.getArray<Slot>(Y_KDOC_LAYOUT).toArray();
    expect(layout.filter((x) => "item" in x && x.item === "fp-1")).toHaveLength(1);
    expect(layout.filter((x) => "item" in x && x.item === "seg-2")).toHaveLength(1);
  });
});
