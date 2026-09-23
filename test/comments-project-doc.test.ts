/**
 * git-integration 0001 — the wire and helper additions for the project
 * comments document: optional anchor/provenance fields keep old payloads
 * valid, `listThreads` filters by document, `liftLegacyComments` is
 * idempotent and tombstones the source, `setThreadResolved` records where a
 * resolve happened and when a reopen did, `detachedState` classifies.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COMMENTS_LIFTED_KEY,
  addMessage,
  commentThreadSchema,
  commentsLiftedMarker,
  commentsYMap,
  createThread,
  detachedState,
  liftLegacyComments,
  listThreads,
  markThreadSeen,
  setThreadAnchor,
  setThreadResolved,
  threadMatches,
  toggleReaction,
} from "../src/index.js";

const anchor = (filePath?: string, itemUuid?: string) => ({
  pos: { x: 1, y: 2 },
  ...(filePath ? { filePath } : {}),
  ...(itemUuid ? { itemUuid } : {}),
});

describe("wire compatibility", () => {
  it("a legacy thread (no filePath/provenance) still parses; new fields round-trip", () => {
    const legacy = {
      id: "t1",
      anchor: { pos: { x: 0, y: 0 } },
      resolved: false,
      createdBy: "alice",
      createdAt: 1,
      rootId: "m1",
      messages: [{ id: "m1", author: "alice", body: "hi", createdAt: 1 }],
    };
    expect(commentThreadSchema.safeParse(legacy).success).toBe(true);
    const full = {
      ...legacy,
      anchor: { pos: { x: 0, y: 0 }, filePath: "board.kicad_pcb", sheetPath: "/abc" },
      provenance: { workingCopyId: "wc1", headCommit: "deadbeef", docGeneration: 3, dirtyAtWrite: true },
      resolution: { workingCopyId: "wc1", headCommit: "deadbeef", at: 5 },
      reopenedAt: 6,
      origin: "import",
    };
    const parsed = commentThreadSchema.parse(full);
    expect(parsed.anchor.filePath).toBe("board.kicad_pcb");
    expect(parsed.provenance?.dirtyAtWrite).toBe(true);
    expect(parsed.origin).toBe("import");
  });
});

describe("filtered listing", () => {
  it("lists only the threads of one document; legacy threads without filePath match any", () => {
    const doc = new Y.Doc();
    createThread(doc, { anchor: anchor("board.kicad_pcb"), author: "a", body: "board" });
    createThread(doc, { anchor: anchor("root.kicad_sch"), author: "a", body: "sch" });
    createThread(doc, { anchor: anchor(), author: "a", body: "legacy" });
    expect(listThreads(doc)).toHaveLength(3);
    const board = listThreads(doc, { filePath: "board.kicad_pcb" });
    expect(board.map((t) => t.messages[0]!.body).sort()).toEqual(["board", "legacy"]);
    expect(listThreads(doc, { filePath: "other.kicad_sch" }).map((t) => t.messages[0]!.body)).toEqual(["legacy"]);
  });

  it("sheetPath narrows within a file; a thread without sheetPath matches every instance", () => {
    const t = {
      ...commentThreadSchema.parse({
        id: "t",
        anchor: { pos: { x: 0, y: 0 }, filePath: "sub.kicad_sch", sheetPath: "/a/b" },
        resolved: false,
        createdBy: "a",
        createdAt: 1,
        rootId: "m",
        messages: [{ id: "m", author: "a", body: "x", createdAt: 1 }],
      }),
    };
    expect(threadMatches(t, { filePath: "sub.kicad_sch" })).toBe(true);
    expect(threadMatches(t, { filePath: "sub.kicad_sch", sheetPath: "/a/b" })).toBe(true);
    expect(threadMatches(t, { filePath: "sub.kicad_sch", sheetPath: "/a/c" })).toBe(false);
    const noSheet = { ...t, anchor: { ...t.anchor, sheetPath: undefined } };
    expect(threadMatches(noSheet, { filePath: "sub.kicad_sch", sheetPath: "/a/c" })).toBe(true);
  });

  it("skips the ~lifted marker and any non-map entry", () => {
    const doc = new Y.Doc();
    createThread(doc, { anchor: anchor("f"), author: "a", body: "x" });
    commentsYMap(doc).set(COMMENTS_LIFTED_KEY, { at: 1, count: 1 } as never);
    commentsYMap(doc).set("garbage", "nope" as never);
    expect(listThreads(doc)).toHaveLength(1);
    expect(commentsLiftedMarker(doc)).toEqual({ at: 1, count: 1 });
  });
});

describe("liftLegacyComments", () => {
  it("moves threads with sub-maps, flat keys and filePath; tombstones the source; idempotent", () => {
    const file = new Y.Doc();
    const project = new Y.Doc();
    const t1 = createThread(file, { anchor: anchor(undefined, "u1"), author: "alice", body: "root", now: 10 });
    addMessage(file, t1, { author: "bob", body: "reply", now: 11 });
    markThreadSeen(file, t1, "carol", 11);
    toggleReaction(file, t1, "m", "carol", "👍"); // unknown message → no-op
    const rootId = listThreads(file)[0]!.rootId;
    toggleReaction(file, t1, rootId, "carol", "👍");
    setThreadResolved(file, t1, true, { headCommit: "abc" }, 12);
    const t2 = createThread(file, { anchor: anchor("already.kicad_sch"), author: "alice", body: "keeps path", now: 13 });

    const first = liftLegacyComments(file, project, "board.kicad_pcb", 100);
    expect(first).toEqual({ moved: 2, skipped: 0 });

    const lifted = listThreads(project);
    expect(lifted.map((t) => t.id).sort()).toEqual([t1, t2].sort());
    const l1 = lifted.find((t) => t.id === t1)!;
    expect(l1.anchor).toEqual({ pos: { x: 1, y: 2 }, itemUuid: "u1", filePath: "board.kicad_pcb" });
    expect(l1.messages.map((m) => m.body)).toEqual(["root", "reply"]);
    expect(l1.seen?.carol).toBe(11);
    expect(l1.reactions?.[rootId]?.["👍"]).toEqual(["carol"]);
    expect(l1.resolved).toBe(true);
    expect(l1.resolution).toEqual({ headCommit: "abc", at: 12 });
    expect(l1.provenance).toBeUndefined();
    // An existing filePath is kept, never overwritten.
    expect(lifted.find((t) => t.id === t2)!.anchor.filePath).toBe("already.kicad_sch");

    // Source: threads gone, marker present — an old client sees nothing.
    expect(listThreads(file)).toEqual([]);
    expect(commentsYMap(file).size).toBe(1);
    expect(commentsLiftedMarker(file)).toEqual({ at: 100, count: 2 });

    // Second run: nothing to move, no duplicates, marker refreshed.
    const second = liftLegacyComments(file, project, "board.kicad_pcb", 200);
    expect(second).toEqual({ moved: 0, skipped: 0 });
    expect(listThreads(project)).toHaveLength(2);
    expect(commentsLiftedMarker(file)?.at).toBe(200);
  });

  it("a thread the project doc already holds is skipped, and the lift still tombstones", () => {
    const file = new Y.Doc();
    const project = new Y.Doc();
    const id = createThread(file, { anchor: anchor(), author: "a", body: "x", now: 1 });
    createThread(project, { anchor: anchor("board.kicad_pcb"), author: "a", body: "already", id, now: 1 });
    expect(liftLegacyComments(file, project, "board.kicad_pcb")).toEqual({ moved: 0, skipped: 1 });
    expect(listThreads(project)).toHaveLength(1);
    expect(listThreads(project)[0]!.messages[0]!.body).toBe("already");
    expect(commentsLiftedMarker(file)).not.toBeNull();
  });

  it("two peers lifting the same file concurrently converge without duplicates", () => {
    const fileA = new Y.Doc();
    const id = createThread(fileA, { anchor: anchor(), author: "a", body: "x", now: 1 });
    const fileB = new Y.Doc();
    Y.applyUpdate(fileB, Y.encodeStateAsUpdate(fileA));
    const projA = new Y.Doc();
    const projB = new Y.Doc();
    liftLegacyComments(fileA, projA, "f.kicad_pcb");
    liftLegacyComments(fileB, projB, "f.kicad_pcb");
    Y.applyUpdate(projA, Y.encodeStateAsUpdate(projB));
    Y.applyUpdate(projB, Y.encodeStateAsUpdate(projA));
    Y.applyUpdate(fileA, Y.encodeStateAsUpdate(fileB));
    Y.applyUpdate(fileB, Y.encodeStateAsUpdate(fileA));
    for (const d of [projA, projB]) {
      const threads = listThreads(d);
      expect(threads).toHaveLength(1);
      expect(threads[0]!.id).toBe(id);
      expect(threads[0]!.messages).toHaveLength(1);
    }
    expect(listThreads(fileA)).toEqual([]);
    expect(listThreads(fileB)).toEqual([]);
  });
});

describe("setThreadResolved provenance", () => {
  it("records resolution on resolve and reopenedAt on reopen", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor: anchor("f"), author: "a", body: "x" });
    expect(setThreadResolved(doc, id, true, { workingCopyId: "wc", headCommit: "h" }, 50)).toBe(true);
    let t = listThreads(doc)[0]!;
    expect(t.resolved).toBe(true);
    expect(t.resolution).toEqual({ workingCopyId: "wc", headCommit: "h", at: 50 });
    expect(t.reopenedAt).toBeUndefined();
    setThreadResolved(doc, id, false, undefined, 60);
    t = listThreads(doc)[0]!;
    expect(t.resolved).toBe(false);
    expect(t.resolution).toBeUndefined();
    expect(t.reopenedAt).toBe(60);
    // Default `at` is the clock.
    setThreadResolved(doc, id, true);
    expect(listThreads(doc)[0]!.resolution?.at).toBeGreaterThan(0);
  });
});

describe("detachedState", () => {
  const thread = (fp?: string, uuid?: string) =>
    commentThreadSchema.parse({
      id: "t",
      anchor: anchor(fp, uuid),
      resolved: false,
      createdBy: "a",
      createdAt: 1,
      rootId: "m",
      messages: [{ id: "m", author: "a", body: "x", createdAt: 1 }],
    });
  const files = new Set(["board.kicad_pcb"]);
  const items = new Set(["u1"]);
  const ctx = {
    fileExists: (fp: string | undefined) => fp === undefined || files.has(fp),
    hasItem: (uuid: string) => items.has(uuid),
  };
  it("classifies anchored / detached / absent, item-less pins are anchored", () => {
    expect(detachedState(thread("board.kicad_pcb", "u1"), ctx)).toBe("anchored");
    expect(detachedState(thread("board.kicad_pcb", "gone"), ctx)).toBe("detached");
    expect(detachedState(thread("board.kicad_pcb"), ctx)).toBe("anchored");
    expect(detachedState(thread("missing.kicad_sch", "u1"), ctx)).toBe("absent");
    expect(detachedState(thread(undefined, "gone"), ctx)).toBe("detached");
  });
});

describe("setThreadAnchor keeps the document", () => {
  it("carries filePath/sheetPath over when the new anchor omits them; an explicit value wins", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor: { pos: { x: 0, y: 0 }, filePath: "a.kicad_sch", sheetPath: "/s" }, author: "a", body: "x" });
    expect(setThreadAnchor(doc, id, { pos: { x: 5, y: 6 }, itemUuid: "u" })).toBe(true);
    expect(listThreads(doc)[0]!.anchor).toEqual({ pos: { x: 5, y: 6 }, itemUuid: "u", filePath: "a.kicad_sch", sheetPath: "/s" });
    setThreadAnchor(doc, id, { pos: { x: 1, y: 1 }, filePath: "b.kicad_sch" });
    expect(listThreads(doc)[0]!.anchor).toEqual({ pos: { x: 1, y: 1 }, filePath: "b.kicad_sch", sheetPath: "/s" });
    expect(setThreadAnchor(doc, "nope", { pos: { x: 0, y: 0 } })).toBe(false);
  });
});
