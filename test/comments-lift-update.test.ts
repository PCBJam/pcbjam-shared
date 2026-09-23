import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  commentsLiftedMarker,
  countCommentThreadsInUpdate,
  createThread,
  liftLegacyCommentsUpdate,
  listThreads,
} from "../src/index.js";

const anchor = { pos: { x: 1, y: 2 } };

describe("liftLegacyCommentsUpdate", () => {
  it("returns forward updates that lift into a fresh project doc and tombstone the source", () => {
    const file = new Y.Doc();
    const id = createThread(file, { anchor, author: "a", body: "x", now: 1 });
    const fileUpdate = Y.encodeStateAsUpdate(file);

    const r = liftLegacyCommentsUpdate(fileUpdate, null, "board.kicad_pcb", 9)!;
    expect(r).toMatchObject({ moved: 1, skipped: 0, had: 1 });
    expect(r.projectForward).not.toBeNull();

    const project = new Y.Doc();
    Y.applyUpdate(project, r.projectForward!);
    expect(listThreads(project).map((t) => [t.id, t.anchor.filePath])).toEqual([[id, "board.kicad_pcb"]]);

    // The file forward applies on top of the ORIGINAL file state.
    const file2 = new Y.Doc();
    Y.applyUpdate(file2, fileUpdate);
    Y.applyUpdate(file2, r.fileForward);
    expect(listThreads(file2)).toEqual([]);
    expect(commentsLiftedMarker(file2)).toEqual({ at: 9, count: 1 });

    // Second run over the lifted state: nothing to do.
    expect(liftLegacyCommentsUpdate(Y.encodeStateAsUpdate(file2), Y.encodeStateAsUpdate(project), "board.kicad_pcb")).toBeNull();
  });

  it("skips ids the project doc already holds and still tombstones", () => {
    const file = new Y.Doc();
    const id = createThread(file, { anchor, author: "a", body: "x", now: 1 });
    const project = new Y.Doc();
    createThread(project, { anchor: { ...anchor, filePath: "b" }, author: "a", body: "already", id, now: 1 });
    const r = liftLegacyCommentsUpdate(Y.encodeStateAsUpdate(file), Y.encodeStateAsUpdate(project), "b")!;
    expect(r).toMatchObject({ moved: 0, skipped: 1, had: 1, projectForward: null });
    expect(countCommentThreadsInUpdate(Y.encodeStateAsUpdate(project))).toBe(1);
  });

  it("an empty doc without a marker gets the marker; with the marker it is a no-op", () => {
    const file = new Y.Doc();
    file.getMap("kdoc_items"); // touch so the update is non-trivial
    const r = liftLegacyCommentsUpdate(Y.encodeStateAsUpdate(file), null, "f")!;
    expect(r).toMatchObject({ moved: 0, had: 0, projectForward: null });
    Y.applyUpdate(file, r.fileForward);
    expect(commentsLiftedMarker(file)).not.toBeNull();
    expect(liftLegacyCommentsUpdate(Y.encodeStateAsUpdate(file), null, "f")).toBeNull();
  });
});
