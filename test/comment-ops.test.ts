import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyCommentOp,
  commentOpSchema,
  COMMENTER_THREAD_CAP,
  type CommentActor,
} from "../src/comment-ops.js";
import { getThread, listThreads } from "../src/comments-y.js";

const anchor = { pos: { x: 1, y: 2 } };
const guest: CommentActor = { slug: "guest", name: "Guest", role: "commenter" };
const other: CommentActor = { slug: "other", name: "Other", role: "commenter" };
const editor: CommentActor = { slug: "owner", name: "Owner", role: "editor" };

function seed() {
  const doc = new Y.Doc();
  const t = applyCommentOp(doc, { type: "createThread", anchor, body: "root" }, guest, 1000);
  if (!t.ok) throw new Error("seed");
  const reply = applyCommentOp(doc, { type: "addMessage", threadId: t.threadId, body: "reply" }, other, 2000);
  if (!reply.ok) throw new Error("seed reply");
  return { doc, threadId: t.threadId, rootId: t.messageId!, replyId: reply.messageId! };
}

describe("commentOpSchema", () => {
  it("accepts the op set and rejects out-of-policy bodies", () => {
    expect(commentOpSchema.safeParse({ type: "createThread", anchor, body: "hi" }).success).toBe(true);
    expect(commentOpSchema.safeParse({ type: "createThread", anchor, body: "" }).success).toBe(false);
    expect(commentOpSchema.safeParse({ type: "createThread", anchor, body: "x".repeat(4001) }).success).toBe(false);
    expect(commentOpSchema.safeParse({ type: "addMessage", threadId: "short", body: "x" }).success).toBe(false);
    expect(commentOpSchema.safeParse({ type: "toggleReaction", threadId: "t".repeat(10), messageId: "m".repeat(10), emoji: "a|b" }).success).toBe(false);
    expect(commentOpSchema.safeParse({ type: "toggleReaction", threadId: "t".repeat(10), messageId: "m".repeat(10), emoji: "👍🏽" }).success).toBe(true);
    // No author on the wire — an extra key is stripped, never trusted.
    const parsed = commentOpSchema.parse({ type: "createThread", anchor, body: "x", author: "evil" });
    expect(parsed).not.toHaveProperty("author");
  });
});

describe("applyCommentOp — stamping", () => {
  it("stamps author/name/email from the actor and the server clock", () => {
    const doc = new Y.Doc();
    const r = applyCommentOp(
      doc,
      { type: "createThread", anchor, body: "hello", id: "client-chosen-1" },
      { ...guest, email: "g@x.test" },
      1234,
    );
    expect(r).toEqual({ ok: true, threadId: "client-chosen-1", messageId: expect.any(String) });
    const t = getThread(doc, "client-chosen-1")!;
    expect(t.createdBy).toBe("guest");
    expect(t.createdAt).toBe(1234);
    expect(t.messages[0]).toMatchObject({ author: "guest", authorName: "Guest", authorEmail: "g@x.test", body: "hello", createdAt: 1234 });
    // Own write auto-marks seen (0001 C data-level rule).
    expect(t.seen?.guest).toBe(1234);
  });

  it("rejects a client id that is already taken", () => {
    const doc = new Y.Doc();
    applyCommentOp(doc, { type: "createThread", anchor, body: "a", id: "dup-thread-1" }, guest);
    expect(applyCommentOp(doc, { type: "createThread", anchor, body: "b", id: "dup-thread-1" }, guest)).toEqual({ ok: false, code: "id-taken" });
    const r = applyCommentOp(doc, { type: "addMessage", threadId: "dup-thread-1", body: "c", id: "dup-msg-01" }, guest);
    expect(r.ok).toBe(true);
    expect(applyCommentOp(doc, { type: "addMessage", threadId: "dup-thread-1", body: "d", id: "dup-msg-01" }, guest)).toEqual({ ok: false, code: "id-taken" });
  });
});

describe("applyCommentOp — commenter doc rules", () => {
  it("edits and removes only own messages", () => {
    const { doc, threadId, rootId, replyId } = seed();
    expect(applyCommentOp(doc, { type: "editMessage", threadId, messageId: replyId, body: "x" }, guest)).toEqual({ ok: false, code: "not-own" });
    expect(applyCommentOp(doc, { type: "editMessage", threadId, messageId: rootId, body: "edited", mentions: ["other"] }, guest, 3000)).toMatchObject({ ok: true });
    const root = getThread(doc, threadId)!.messages.find((m) => m.id === rootId)!;
    expect(root.body).toBe("edited");
    expect(root.mentions).toEqual(["other"]);
    expect(root.editedAt).toBe(3000);
    expect(applyCommentOp(doc, { type: "removeMessage", threadId, messageId: replyId }, guest)).toEqual({ ok: false, code: "not-own" });
    expect(applyCommentOp(doc, { type: "editMessage", threadId, messageId: "no-such-msg-1", body: "x" }, guest)).toEqual({ ok: false, code: "message-missing" });
    expect(applyCommentOp(doc, { type: "editMessage", threadId: "no-such-thr-1", messageId: rootId, body: "x" }, guest)).toEqual({ ok: false, code: "thread-missing" });
  });

  it("a commenter can't take down a root that others replied to; alone they can", () => {
    const { doc, threadId, rootId, replyId } = seed();
    expect(applyCommentOp(doc, { type: "removeMessage", threadId, messageId: rootId }, guest)).toEqual({ ok: false, code: "root-has-replies" });
    // The other commenter removes their reply → now the root is removable (deletes the thread).
    expect(applyCommentOp(doc, { type: "removeMessage", threadId, messageId: replyId }, other)).toMatchObject({ ok: true });
    expect(applyCommentOp(doc, { type: "removeMessage", threadId, messageId: rootId }, guest)).toMatchObject({ ok: true });
    expect(getThread(doc, threadId)).toBeNull();
  });

  it("resolve / re-anchor only own threads; seen and reactions always", () => {
    const { doc, threadId, replyId } = seed();
    expect(applyCommentOp(doc, { type: "setResolved", threadId, resolved: true }, other)).toEqual({ ok: false, code: "not-own" });
    expect(applyCommentOp(doc, { type: "setResolved", threadId, resolved: true }, guest)).toEqual({ ok: true, threadId });
    expect(getThread(doc, threadId)!.resolved).toBe(true);
    expect(applyCommentOp(doc, { type: "setAnchor", threadId, anchor: { pos: { x: 9, y: 9 } } }, other)).toEqual({ ok: false, code: "not-own" });
    expect(applyCommentOp(doc, { type: "setAnchor", threadId, anchor: { pos: { x: 9, y: 9 } } }, guest)).toEqual({ ok: true, threadId });
    expect(applyCommentOp(doc, { type: "toggleReaction", threadId, messageId: replyId, emoji: "👍" }, guest)).toMatchObject({ ok: true });
    expect(applyCommentOp(doc, { type: "toggleReaction", threadId, messageId: "no-such-msg-1", emoji: "👍" }, guest)).toEqual({ ok: false, code: "message-missing" });
    expect(applyCommentOp(doc, { type: "markSeen", threadId, upTo: 5000 }, other)).toEqual({ ok: true, threadId });
    expect(getThread(doc, threadId)!.seen?.other).toBe(5000);
  });

  it("editors skip the own-only rules", () => {
    const { doc, threadId, rootId } = seed();
    expect(applyCommentOp(doc, { type: "editMessage", threadId, messageId: rootId, body: "mod" }, editor)).toMatchObject({ ok: true });
    expect(applyCommentOp(doc, { type: "setResolved", threadId, resolved: true }, editor)).toMatchObject({ ok: true });
    expect(applyCommentOp(doc, { type: "removeMessage", threadId, messageId: rootId }, editor)).toMatchObject({ ok: true });
    expect(getThread(doc, threadId)).toBeNull();
  });

  it("caps a commenter's open threads per document", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < COMMENTER_THREAD_CAP; i++) {
      expect(applyCommentOp(doc, { type: "createThread", anchor, body: `t${i}` }, guest).ok).toBe(true);
    }
    expect(applyCommentOp(doc, { type: "createThread", anchor, body: "one more" }, guest)).toEqual({ ok: false, code: "thread-cap" });
    // Another commenter and an editor are unaffected.
    expect(applyCommentOp(doc, { type: "createThread", anchor, body: "ok" }, other).ok).toBe(true);
    expect(applyCommentOp(doc, { type: "createThread", anchor, body: "ok" }, editor).ok).toBe(true);
    expect(listThreads(doc).length).toBe(COMMENTER_THREAD_CAP + 2);
  });
});

describe("server copy context (git-integration 0006)", () => {
  it("resolve records the copy and head; createThread provenance takes them from the server", async () => {
    const Y = await import("yjs");
    const { applyCommentOp } = await import("../src/comment-ops.js");
    const { getThread } = await import("../src/comments-y.js");
    const doc = new Y.Doc();
    const editor = { slug: "alice", name: "Alice", role: "editor" as const };
    const copy = { workingCopyId: "wc-1", headCommit: "c03" };
    const created = applyCommentOp(
      doc,
      {
        type: "createThread",
        anchor: { pos: { x: 1, y: 2 }, filePath: "board.kicad_pcb" },
        body: "check this",
        mentions: [],
        provenance: { workingCopyId: "client-claim", headCommit: "forged", docGeneration: 3, dirtyAtWrite: true },
      },
      editor,
      1000,
      copy,
    );
    expect(created.ok).toBe(true);
    const id = (created as { threadId: string }).threadId;
    expect(getThread(doc, id)?.provenance).toEqual({ workingCopyId: "wc-1", headCommit: "c03", docGeneration: 3, dirtyAtWrite: true });
    expect(applyCommentOp(doc, { type: "setResolved", threadId: id, resolved: true }, editor, 2000, copy).ok).toBe(true);
    expect(getThread(doc, id)?.resolution).toEqual({ workingCopyId: "wc-1", headCommit: "c03", at: 2000 });
  });
});
