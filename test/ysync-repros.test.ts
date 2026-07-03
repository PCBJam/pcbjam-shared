import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDeltaToY, docToY, Y_KDOC_LAYOUT, yToDoc } from "../src/kicad-y.js";
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

  it.fails("the parent still renders after a child-only removal", () => {
    const doc = yToDoc(removeChildOnly());
    expect(doc.items["fld-1"]).toBeUndefined(); // the item itself IS deleted
    // CORRECT: the parent's body no longer references the child, so it renders.
    // TODAY: fp-1's body still holds {item:"fld-1"} → "renderItem: missing item".
    const text = renderItem(doc, "fp-1");
    expect(text).not.toContain("fld-1");
    expect(text).toContain("pad-1"); // the sibling child survives
  });

  it.fails("the doc still materializes (docToFile) after a child-only removal", () => {
    const doc = yToDoc(removeChildOnly());
    // CORRECT: the room stays materializable (the "file recoverable from the
    // Y.Doc alone" invariant, ysync 0005). TODAY: docToFile throws through the
    // same dangling slot, poisoning ydoc-mode opens of the room.
    const text = docToFile(doc);
    expect(text).not.toContain("fld-1");
    expect(text).toContain("seg-1"); // untouched root keeps its slot
  });
});

// ── Bug 06 — concurrent first-seed duplicates kdoc_layout ────────────────────
// 06-bug-concurrent-seed-duplicates-layout.md: seed-vs-adopt is a client-side
// check-then-act, so two clients opening the same fresh room can both observe
// "empty" and both run docToY. kdoc_meta/kdoc_items converge (Y.Map LWW), but
// kdoc_layout is a Y.Array: each client's delete sees only its own (empty)
// view, both insert sequences survive the merge, and nothing ever heals it.

describe("bug 06 — concurrent first-seed duplicates kdoc_layout", () => {
  function concurrentSeed(): { kdoc: ReturnType<typeof fileToDoc>; a: Y.Doc; b: Y.Doc } {
    const kdoc = fileToDoc(PCB);
    const a = new Y.Doc();
    const b = new Y.Doc();
    // Both clients pass the ydocHasState check before seeing each other (the
    // network round-trip window / the whole BroadcastChannel settleMs)…
    docToY(kdoc, a, "seed-a");
    docToY(kdoc, b, "seed-b");
    // …then their seed transactions exchange.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return { kdoc, a, b };
  }

  it("both clients converge on the same merged state (CRDT determinism)", () => {
    const { a, b } = concurrentSeed();
    // Green baseline: the merge is deterministic — both docs corrupt IDENTICALLY,
    // which is why nothing downstream can tell the room is damaged.
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(b)));
  });

  it.fails("the merged layout holds each root slot exactly once", () => {
    const { a } = concurrentSeed();
    const layout = a.getArray<Slot>(Y_KDOC_LAYOUT).toArray();
    const fpSlots = layout.filter((s) => "item" in s && s.item === "fp-1");
    // CORRECT: seeding the same file twice must be idempotent per root uuid.
    // TODAY: 2 slots — one per seeder — and every preamble form is doubled too.
    expect(fpSlots).toHaveLength(1);
  });

  it.fails("the merged doc materializes the single-seed output", () => {
    const { kdoc, a } = concurrentSeed();
    const single = new Y.Doc();
    docToY(kdoc, single);
    // CORRECT: same file, same room → same materialization as one seeder.
    // TODAY: every root item renders twice (each duplicate {item} slot resolves;
    // the per-render `seen` set only guards cycles), the preamble doubles, and
    // ydocHasState is now true so no client ever re-seeds — permanent corruption.
    expect(docToFile(yToDoc(a))).toBe(docToFile(yToDoc(single)));
  });
});
