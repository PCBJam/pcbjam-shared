import * as Y from "yjs";
import { liftLegacyComments, listThreads } from "./comments-y.js";

/**
 * Update-level wrappers around the comments-lift helpers (git-integration
 * 0001 E): the closed core is Yjs-free by design — every Y operation it
 * needs takes and returns ENCODED updates through this package (see
 * `computeTextRewriteUpdate`, `commentThreadsFromUpdate`). The lift job and
 * the stats projection use these; the rooms apply the forward updates.
 */

export interface LiftUpdateResult {
  /** Forward update for the PROJECT comments doc (null when nothing moved). */
  projectForward: Uint8Array | null;
  /** Forward update for the FILE doc: source entries deleted + `~lifted` marker. */
  fileForward: Uint8Array;
  moved: number;
  skipped: number;
  /** Threads the file doc held before the lift (moved + skipped). */
  had: number;
}

/**
 * Run {@link liftLegacyComments} on scratch docs hydrated from encoded
 * states and return the two forward updates. `projectUpdate` is the
 * project doc's current state (null = never persisted). Returns null when
 * the file doc holds no threads AND already carries the `~lifted` marker —
 * nothing to do (a doc with no threads and no marker still gets the marker).
 */
export function liftLegacyCommentsUpdate(
  fileUpdate: Uint8Array,
  projectUpdate: Uint8Array | null,
  filePath: string,
  now: number = Date.now(),
): LiftUpdateResult | null {
  const fileDoc = new Y.Doc();
  const projectDoc = new Y.Doc();
  try {
    Y.applyUpdate(fileDoc, fileUpdate);
    const had = listThreads(fileDoc).length;
    const marker = fileDoc.getMap("kdoc_comments").get("~lifted");
    if (had === 0 && marker !== undefined) return null;
    if (projectUpdate) Y.applyUpdate(projectDoc, projectUpdate);
    const projectSv = Y.encodeStateVector(projectDoc);
    const fileSv = Y.encodeStateVector(fileDoc);
    const { moved, skipped } = liftLegacyComments(fileDoc, projectDoc, filePath, now);
    return {
      projectForward: moved > 0 ? Y.encodeStateAsUpdate(projectDoc, projectSv) : null,
      fileForward: Y.encodeStateAsUpdate(fileDoc, fileSv),
      moved,
      skipped,
      had,
    };
  } finally {
    fileDoc.destroy();
    projectDoc.destroy();
  }
}

/** Thread count of an encoded doc state (0 for a doc without comments). */
export function countCommentThreadsInUpdate(update: Uint8Array): number {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return listThreads(doc).length;
  } finally {
    doc.destroy();
  }
}
