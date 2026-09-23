/**
 * git-integration 0003 — `.pcbjam/comments.json`: export strips emails and
 * per-user state and carries tombstones; merge is additive (§7.2): unknown
 * threads import whole, known threads union messages (later edit wins),
 * resolved wins except a newer reopen, file tombstones delete, document
 * tombstones block re-import, re-merging the same file changes nothing.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addMessage,
  commentTombstones,
  createThread,
  deleteThread,
  editMessage,
  exportComments,
  exportCommentsFromUpdate,
  listThreads,
  mergeCommentsFileUpdate,
  markThreadSeen,
  mergeCommentsFile,
  parseCommentsFile,
  removeMessage,
  serializeCommentsFile,
  setThreadResolved,
  toggleReaction,
} from "../src/index.js";

const anchor = { pos: { x: 1, y: 2 }, filePath: "board.kicad_pcb" };

function seeded(): { doc: Y.Doc; t1: string; t2: string } {
  const doc = new Y.Doc();
  const t1 = createThread(doc, { anchor, author: "alice", authorName: "Alice", authorEmail: "a@x.io", body: "root", now: 10 });
  addMessage(doc, t1, { author: "bob", authorEmail: "b@x.io", body: "reply", mentions: ["alice"], now: 11 });
  markThreadSeen(doc, t1, "carol", 11);
  toggleReaction(doc, t1, listThreads(doc)[0]!.rootId, "carol", "👍");
  const t2 = createThread(doc, { anchor, author: "bob", body: "second", now: 20 });
  return { doc, t1, t2 };
}

describe("exportComments", () => {
  it("strips emails and per-user state, carries tombstones, round-trips through JSON", () => {
    const { doc, t1, t2 } = seeded();
    deleteThread(doc, t2, 30);
    const file = exportComments(doc, { projectId: "p1", now: 40 });
    const text = serializeCommentsFile(file);
    expect(text).not.toContain("@x.io");
    expect(text).not.toContain("seen");
    expect(text).not.toContain("react");
    expect(file.threads).toHaveLength(1);
    expect(file.threads[0]).toMatchObject({ id: t1, createdBy: "alice", createdByName: "Alice", updatedAt: 11 });
    expect(file.threads[0]!.messages.map((m) => m.body)).toEqual(["root", "reply"]);
    expect(file.threads[0]!.messages[1]!.mentions).toEqual(["alice"]);
    expect(file.tombstones).toEqual({ threads: [t2], messages: [] });
    expect(parseCommentsFile(text)).toEqual(file);
    expect(parseCommentsFile("{}")).toBeNull();
  });

  it("removeMessage / thread-deleting removals leave tombstones", () => {
    const { doc, t1 } = seeded();
    const reply = listThreads(doc)[0]!.messages[1]!.id;
    expect(removeMessage(doc, t1, reply)).toBe("removed");
    expect(commentTombstones(doc).messages).toEqual([reply]);
    const rootId = listThreads(doc)[0]!.rootId;
    expect(removeMessage(doc, t1, rootId)).toBe("thread-deleted");
    expect(commentTombstones(doc).threads).toEqual([t1]);
  });
});

describe("mergeCommentsFile", () => {
  it("imports unknown threads whole (origin import), unions messages, later edit wins, idempotent", () => {
    const { doc: source, t1 } = seeded();
    const desktop = new Y.Doc();
    Y.applyUpdate(desktop, Y.encodeStateAsUpdate(source));
    // Desktop side: a new reply, an edit of the root, and a brand-new thread.
    addMessage(desktop, t1, { author: "dave", body: "from desktop", now: 50 });
    const rootId = listThreads(desktop)[0]!.rootId;
    editMessage(desktop, t1, rootId, "root (edited)", 51);
    const t3 = createThread(desktop, { anchor, author: "dave", body: "new on desktop", now: 52 });
    const file = exportComments(desktop, { now: 60 });

    const first = mergeCommentsFile(source, file, 70);
    expect(first).toMatchObject({ threadsImported: 1, messagesAdded: 1, messagesUpdated: 1, deleted: 0, resolved: 0 });
    const merged = listThreads(source);
    expect(merged.map((t) => t.id)).toContain(t3);
    expect(merged.find((t) => t.id === t3)!.origin).toBe("import");
    const m1 = merged.find((t) => t.id === t1)!;
    expect(m1.messages.map((m) => m.body)).toEqual(["root (edited)", "reply", "from desktop"]);
    // Per-user state untouched by the merge.
    expect(m1.seen?.carol).toBe(11);
    expect(m1.reactions?.[rootId]?.["👍"]).toEqual(["carol"]);
    // Emails in the document survive (the file never carried them).
    expect(m1.authorEmail).toBe("a@x.io");

    const second = mergeCommentsFile(source, file, 80);
    expect(second).toEqual({ threadsImported: 0, messagesAdded: 0, messagesUpdated: 0, resolved: 0, reopenKept: 0, deleted: 0, skippedTombstoned: 0 });
    expect(listThreads(source)).toEqual(merged);
  });

  it("resolved wins; a newer reopen in the document survives; anchors are the document's", () => {
    const { doc, t1, t2 } = seeded();
    const desktop = new Y.Doc();
    Y.applyUpdate(desktop, Y.encodeStateAsUpdate(doc));
    setThreadResolved(desktop, t1, true, { headCommit: "abc" }, 100);
    setThreadResolved(desktop, t2, true, undefined, 100);
    // Move the pin on desktop — must NOT be applied.
    const file = exportComments(desktop, { now: 110 });
    file.threads.find((t) => t.id === t1)!.anchor = { pos: { x: 99, y: 99 }, filePath: "board.kicad_pcb" };
    // The document reopened t2 AFTER the desktop resolve.
    setThreadResolved(doc, t2, true, undefined, 90);
    setThreadResolved(doc, t2, false, undefined, 120);

    const s = mergeCommentsFile(doc, file, 130);
    expect(s).toMatchObject({ resolved: 1, reopenKept: 1 });
    const after = listThreads(doc);
    const a1 = after.find((t) => t.id === t1)!;
    expect(a1.resolved).toBe(true);
    expect(a1.resolution).toEqual({ headCommit: "abc", at: 100 });
    expect(a1.anchor.pos).toEqual({ x: 1, y: 2 });
    expect(after.find((t) => t.id === t2)!.resolved).toBe(false);

    // A resolved document thread the file has open stays resolved.
    const fileOpen = exportComments(new Y.Doc(), { now: 140 });
    fileOpen.threads.push({ ...file.threads.find((t) => t.id === t1)!, resolved: false, resolution: undefined });
    mergeCommentsFile(doc, fileOpen, 150);
    expect(listThreads(doc).find((t) => t.id === t1)!.resolved).toBe(true);
  });

  it("file tombstones delete; document tombstones block re-import; absence is not deletion", () => {
    const { doc, t1, t2 } = seeded();
    const desktop = new Y.Doc();
    Y.applyUpdate(desktop, Y.encodeStateAsUpdate(doc));
    deleteThread(desktop, t2, 100);
    const reply = listThreads(desktop)[0]!.messages[1]!.id;
    removeMessage(desktop, t1, reply);
    const file = exportComments(desktop, { now: 110 });
    expect(file.tombstones).toEqual({ threads: [t2], messages: [reply] });

    const s = mergeCommentsFile(doc, file, 120);
    expect(s.deleted).toBe(2);
    expect(listThreads(doc).map((t) => t.id)).toEqual([t1]);
    expect(listThreads(doc)[0]!.messages).toHaveLength(1);
    expect(commentTombstones(doc)).toEqual({ threads: [t2], messages: [reply] });

    // A file that still carries the deleted thread does not resurrect it.
    const stale = exportComments(seeded().doc, { now: 130 });
    const staleT2 = stale.threads[1]!;
    staleT2.id = t2;
    const s2 = mergeCommentsFile(doc, { ...stale, threads: [staleT2], tombstones: { threads: [], messages: [] } }, 140);
    expect(s2.skippedTombstoned).toBe(1);
    expect(listThreads(doc).map((t) => t.id)).toEqual([t1]);

    // A file with no threads at all deletes nothing.
    const empty = exportComments(new Y.Doc(), { now: 150 });
    mergeCommentsFile(doc, empty, 160);
    expect(listThreads(doc)).toHaveLength(1);
  });
});

describe("update wrappers", () => {
  it("export from bytes and merge as a forward update round-trip", () => {
    const { doc, t1 } = seeded();
    const file = exportCommentsFromUpdate(Y.encodeStateAsUpdate(doc), { now: 5 });
    expect(file.threads.map((t) => t.id)).toContain(t1);
    expect(exportCommentsFromUpdate(null).threads).toEqual([]);
    const empty = new Y.Doc();
    const { update, summary } = mergeCommentsFileUpdate(null, file, 6);
    expect(summary.threadsImported).toBe(2);
    Y.applyUpdate(empty, update);
    expect(listThreads(empty).map((t) => t.id).sort()).toEqual(file.threads.map((t) => t.id).sort());
    // Applying the forward update to the ORIGINAL document changes nothing it knows.
    const again = mergeCommentsFileUpdate(Y.encodeStateAsUpdate(doc), file, 7);
    expect(again.summary.threadsImported).toBe(0);
  });
});
