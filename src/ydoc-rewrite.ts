import * as Y from "yjs";
import { docToFile, fileToDoc } from "./kicad-doc.js";
import { mergeYUpdates, upsertDocToY, yToDoc } from "./kicad-y.js";

/** Transaction origin of a server-side text rewrite (a file op fixing a reference). */
export const KICAD_FILE_OP_REWRITE_ORIGIN = "kicad-file-op-rewrite";

/**
 * Rewrite a collab document's TEXT as a forward Yjs operation (project-page
 * 0003 §7.1). `current` is the doc's encoded state (`.ydoc` blob shape);
 * `rewrite` maps its materialized s-expr text to the new text. The edit goes
 * through {@link upsertDocToY}, which touches only the slots that differ — a
 * one-property change stays a one-item update, so history, attribution and
 * the comments stored in the same Y.Doc are untouched and no new epoch starts
 * (unlike a whole-doc replace).
 *
 * Returns the incremental `update` (for a live room) and the `merged` full
 * state (for writing a COLD doc's blob directly), or null when the rewrite
 * changes nothing. Pure — callers need not import yjs.
 */
export function computeTextRewriteUpdate(
  current: Uint8Array,
  rewrite: (text: string) => string,
): { update: Uint8Array; merged: Uint8Array } | null {
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, current);
    const before = docToFile(yToDoc(ydoc));
    const after = rewrite(before);
    if (after === before) return null;
    const sv = Y.encodeStateVector(ydoc);
    upsertDocToY(fileToDoc(after), ydoc, KICAD_FILE_OP_REWRITE_ORIGIN);
    const update = Y.encodeStateAsUpdate(ydoc, sv);
    if (update.length <= 2) return null;
    return { update, merged: mergeYUpdates([current, update]) };
  } finally {
    ydoc.destroy();
  }
}
