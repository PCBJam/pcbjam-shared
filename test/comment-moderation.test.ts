import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addMessage, createThread, getThread, listThreads, markThreadSeen, toggleReaction } from "../src/comments-y.js";
import {
  commentAuthors,
  commentReportBodySchema,
  commentThreadsFromUpdate,
  MODERATED_BODY,
  REMOVED_AUTHOR,
  REMOVED_BODY,
  removeMessageByModeration,
  restoreMessage,
  restoreThread,
  tombstoneAuthor,
} from "../src/comment-moderation.js";
import { applyCommentOp } from "../src/comment-ops.js";

const anchor = { pos: { x: 1, y: 1 } };

function seed() {
  const doc = new Y.Doc();
  // t1: spammer's root + owner's reply; t2: owner's root + spammer reply;
  // t3: spammer only (root + own reply).
  const t1 = createThread(doc, { anchor, author: "spam", authorName: "Spam", body: "buy", now: 1 });
  const r1 = addMessage(doc, t1, { author: "owner", body: "no", now: 2 })!;
  const t2 = createThread(doc, { anchor, author: "owner", body: "hi", now: 3 });
  const r2 = addMessage(doc, t2, { author: "spam", body: "cheap", now: 4 })!;
  const t3 = createThread(doc, { anchor, author: "spam", body: "solo", now: 5 });
  addMessage(doc, t3, { author: "spam", body: "solo2", now: 6 });
  markThreadSeen(doc, t2, "spam", 9);
  toggleReaction(doc, t2, getThread(doc, t2)!.rootId, "spam", "👍");
  toggleReaction(doc, t2, getThread(doc, t2)!.rootId, "owner", "👍");
  return { doc, t1, r1, t2, r2, t3 };
}

describe("remove / restore a message", () => {
  it("keeps the author, replaces the body, and is inert afterwards", () => {
    const { doc, t1, r1 } = seed();
    const r = removeMessageByModeration(doc, t1, r1, 100);
    expect(r.ok).toBe(true);
    const m = getThread(doc, t1)!.messages.find((x) => x.id === r1)!;
    expect(m).toMatchObject({ author: "owner", body: MODERATED_BODY, moderation: "removed", editedAt: 100, mentions: [] });
    // Twice is a no-op; a commenter (even the author) can't edit a tombstone.
    expect(removeMessageByModeration(doc, t1, r1).ok).toBe(false);
    expect(applyCommentOp(doc, { type: "editMessage", threadId: t1, messageId: r1, body: "x" }, { slug: "owner", role: "commenter" })).toEqual({ ok: false, code: "not-own" });
    // Restore puts the original back, marker gone.
    expect(r.ok && restoreMessage(doc, t1, r1, r.original)).toBe(true);
    const back = getThread(doc, t1)!.messages.find((x) => x.id === r1)!;
    expect(back.body).toBe("no");
    expect(back.moderation).toBeUndefined();
  });
});

describe("tombstoneAuthor (ban)", () => {
  it("tombstones the author's messages, deletes all-own threads, drops their flat keys, archives originals", () => {
    const { doc, t1, t2, r2, t3 } = seed();
    const report = tombstoneAuthor(doc, "spam", 500);
    expect(report.threadsDeleted).toBe(1);
    expect(report.messages).toBe(2);
    expect(getThread(doc, t3)).toBeNull();
    expect(report.archivedThreads.map((a) => a.threadId)).toEqual([t3]);
    expect(report.archivedThreads[0]!.original.messages.length).toBe(2);
    expect(report.archivedMessages.map((a) => a.original.body).sort()).toEqual(["buy", "cheap"]);

    const th1 = getThread(doc, t1)!;
    expect(th1.createdBy).toBe(REMOVED_AUTHOR);
    expect(th1.authorName).toBe("[writer removed]");
    const root1 = th1.messages.find((m) => m.id === th1.rootId)!;
    expect(root1).toMatchObject({ author: REMOVED_AUTHOR, body: REMOVED_BODY, moderation: "banned-author", createdAt: 1, editedAt: 500 });
    expect(root1.authorEmail).toBeUndefined();
    // The owner's reply survives untouched.
    expect(th1.messages.find((m) => m.author === "owner")!.body).toBe("no");

    const th2 = getThread(doc, t2)!;
    expect(th2.createdBy).toBe("owner");
    expect(th2.messages.find((m) => m.id === r2)!.author).toBe(REMOVED_AUTHOR);
    expect(th2.seen?.spam).toBeUndefined();
    expect(th2.reactions?.[th2.rootId]?.["👍"]).toEqual(["owner"]);

    expect(commentAuthors(doc).sort()).toEqual(["owner"]);
    // Idempotent.
    const again = tombstoneAuthor(doc, "spam", 501);
    expect(again.messages + again.threadsDeleted).toBe(0);
  });

  it("restores an archived thread with its ids, seen and reactions", () => {
    const { doc, t3 } = seed();
    const report = tombstoneAuthor(doc, "spam");
    const archived = report.archivedThreads.find((a) => a.threadId === t3)!.original;
    expect(restoreThread(doc, archived)).toBe(true);
    const back = getThread(doc, t3)!;
    expect(back.messages.map((m) => m.body)).toEqual(["solo", "solo2"]);
    expect(back.seen?.spam).toBe(6); // the reply auto-marked seen at 6
    expect(restoreThread(doc, archived)).toBe(false); // already there
  });
});

describe("helpers", () => {
  it("parses threads from an encoded update; validates report bodies", () => {
    const { doc } = seed();
    const threads = commentThreadsFromUpdate(Y.encodeStateAsUpdate(doc));
    expect(threads.length).toBe(listThreads(doc).length);
    expect(commentReportBodySchema.safeParse({ threadId: "t".repeat(10), reason: "spam" }).success).toBe(true);
    expect(commentReportBodySchema.safeParse({ threadId: "t".repeat(10), reason: "meh" }).success).toBe(false);
    expect(commentReportBodySchema.safeParse({ threadId: "t".repeat(10), reason: "other", note: "x".repeat(501) }).success).toBe(false);
  });
});
