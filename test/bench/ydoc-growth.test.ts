/**
 * ysync 0009 growth bounds — the measured rationale for v2 (design doc §1/§8),
 * committed as assertions so a regression in the write path (e.g. a differ bug
 * that rewrites whole bodies again) is caught by CI, not by prod doc bloat.
 *
 * The scenario mirrors the real write pattern: a footprint move re-emits the
 * item's full body (the bridge always ships whole items), but only the `at`
 * slot differs — pads/fields are separate items with relative coords. Under
 * gc-OFF (the attribution plan, §6) v1 retained the full old body per move
 * (~1.9 KB measured); v2 must retain ~the changed field only.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDeltaToY, docToY, yToDoc } from "../../src/kicad-y.js";
import { fileToDoc, type Slot } from "../../src/kicad-doc.js";

const FP = `(kicad_pcb
  (version 20241229)
  (footprint "Lib:FP"
    (at 10 10)
    (layer "F.Cu")
    (descr "a plausibly sized footprint body")
    (tags "bench")
    (attr smd)
    (uuid "fp-1")
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "prop-1")
      (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (uuid "prop-2")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.9125 0) (size 1.025 1.4) (layers "F.Cu" "F.Paste" "F.Mask")
      (roundrect_rratio 0.24) (uuid "pad-1"))
    (pad "2" smd roundrect (at 0.9125 0) (size 1.025 1.4) (layers "F.Cu" "F.Paste" "F.Mask")
      (roundrect_rratio 0.24) (uuid "pad-2"))
  )
)`;

/** Move fp-1 by rewriting its FULL body with only the `at` slot changed. */
function move(ydoc: Y.Doc, x: number): void {
  const doc = yToDoc(ydoc);
  const fp = doc.items["fp-1"]!;
  const body = fp.body.map(
    (s): Slot =>
      "k" in s && s.k === "at" ? { k: "at", v: [{ atom: String(x) }, { atom: "10" }] } : s,
  );
  applyDeltaToY(ydoc, { added: [], updated: [{ uuid: "fp-1", ...fp, body }], removed: [] }, "edit");
}

function persistedSize(ydoc: Y.Doc): number {
  return Y.encodeStateAsUpdate(ydoc).length;
}

describe("gc-off persisted growth per footprint move", () => {
  it("v2 retains ~the changed field: < 100 B/move (spec bound)", () => {
    const ydoc = new Y.Doc({ gc: false });
    docToY(fileToDoc(FP), ydoc, "seed");
    move(ydoc, 11); // warmup: first move may restructure
    const before = persistedSize(ydoc);
    const MOVES = 50;
    for (let i = 0; i < MOVES; i++) move(ydoc, 12 + i);
    const perMove = (persistedSize(ydoc) - before) / MOVES;
    expect(perMove).toBeLessThan(100);
  });

  it("v1 baseline retains the whole body (the problem v2 solves)", () => {
    const ydoc = new Y.Doc({ gc: false });
    ydoc.getMap("kdoc_meta").set("sexprVersion", 1);
    docToY(fileToDoc(FP), ydoc, "seed");
    move(ydoc, 11);
    const before = persistedSize(ydoc);
    const MOVES = 50;
    for (let i = 0; i < MOVES; i++) move(ydoc, 12 + i);
    const perMove = (persistedSize(ydoc) - before) / MOVES;
    expect(perMove).toBeGreaterThan(200); // whole-body retention, ~this fixture's body size
  });

  it("v2 incremental wire updates stay small per move", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(FP), ydoc, "seed");
    move(ydoc, 11);
    let bytes = 0;
    const onUpdate = (u: Uint8Array): void => {
      bytes += u.length;
    };
    ydoc.on("update", onUpdate);
    const MOVES = 50;
    for (let i = 0; i < MOVES; i++) move(ydoc, 12 + i);
    ydoc.off("update", onUpdate);
    expect(bytes / MOVES).toBeLessThan(150);
  });
});
