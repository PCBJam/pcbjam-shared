/**
 * ysync 0009 §5 — the onLoad conversion/compaction point (`compactYdocUpdate`).
 * Exercised exactly as the sync server does: persisted blob in, replacement
 * update (or null = hydrate as-is) out.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  compactYdocUpdate,
  docToY,
  ydocSexprVersion,
  yToDoc,
} from "../src/kicad-y.js";
import { createThread, listThreads } from "../src/comments-y.js";
import { SEXPR_VERSION_CURRENT, Y_KDOC_SEXPR_VERSION } from "../src/kicad-y2.js";
import { docToFile, fileToDoc, type Slot } from "../src/kicad-doc.js";

const BASE = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
  (via (at 5 5) (size 0.8) (uuid "via-1"))
)`;

function v1Blob(): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, 1);
  docToY(fileToDoc(BASE), ydoc);
  createThread(ydoc, {
    anchor: { pos: { x: 1, y: 2 } },
    author: "u-1",
    body: "check this trace",
    id: "th-1",
    now: 1000,
  });
  return Y.encodeStateAsUpdate(ydoc);
}

function hydrate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

describe("compactYdocUpdate — version upgrade", () => {
  it("re-seeds a v1 blob as a fresh v2 doc, losslessly", () => {
    const res = compactYdocUpdate(v1Blob());
    expect(res).not.toBeNull();
    expect(res!.reason).toBe("version-upgrade");
    expect(res!.fromVersion).toBe(1);
    const doc = hydrate(res!.update);
    expect(ydocSexprVersion(doc)).toBe(SEXPR_VERSION_CURRENT);
    expect(docToFile(yToDoc(doc))).toBe(docToFile(fileToDoc(BASE)));
  });

  it("carries comment threads across the epoch boundary", () => {
    const res = compactYdocUpdate(v1Blob())!;
    const threads = listThreads(hydrate(res.update));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe("th-1");
    expect(threads[0]!.messages[0]!.body).toBe("check this trace");
  });
});

describe("compactYdocUpdate — size-gated compaction", () => {
  it("leaves a healthy current-version blob alone", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(BASE), ydoc);
    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc))).toBeNull();
  });

  it("compacts a bloated (gc-off, edit-heavy) current-version blob", () => {
    const ydoc = new Y.Doc({ gc: false });
    docToY(fileToDoc(BASE), ydoc);
    for (let i = 0; i < 2000; i++) {
      const doc = yToDoc(ydoc);
      const seg = doc.items["seg-1"]!;
      const body = seg.body.map(
        (s): Slot =>
          "k" in s && s.k === "width" ? { k: "width", v: [{ atom: `0.${100 + i}` }] } : s,
      );
      applyDeltaToY(ydoc, { added: [], updated: [{ uuid: "seg-1", ...seg, body }], removed: [] });
    }
    const blob = Y.encodeStateAsUpdate(ydoc);
    const res = compactYdocUpdate(blob);
    expect(res).not.toBeNull();
    expect(res!.reason).toBe("compaction");
    expect(res!.update.length).toBeLessThan(blob.length / 3);
    expect(docToFile(yToDoc(hydrate(res!.update)))).toBe(docToFile(yToDoc(ydoc)));
  });
});

describe("compactYdocUpdate — hydrate-as-is cases", () => {
  it("never touches a doc newer than this build", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(BASE), ydoc);
    ydoc.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, SEXPR_VERSION_CURRENT + 1);
    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc))).toBeNull();
  });

  it("skips docs with no kdoc root (editor-snapshot-seeded / non-kdoc rooms)", () => {
    const ydoc = new Y.Doc();
    applyDeltaToY(ydoc, {
      added: [
        { uuid: "seg-1", type: "segment", parent: null, body: [{ k: "width", v: [{ atom: "1" }] }] },
      ],
      updated: [],
      removed: [],
    });
    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc))).toBeNull();
  });

  it("skips an empty doc", () => {
    expect(compactYdocUpdate(Y.encodeStateAsUpdate(new Y.Doc()))).toBeNull();
  });
});
