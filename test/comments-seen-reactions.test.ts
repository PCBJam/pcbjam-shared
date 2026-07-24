import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addMessage,
  createThread,
  getThread,
  markThreadSeen,
  removeMessage,
  setThreadResolved,
  threadMentionsUnread,
  threadUnreadCount,
  toggleReaction,
} from "../src/comments-y.js";

const anchor = { pos: { x: 0, y: 0 } };

/** Two DISCONNECTED docs, merged manually — for real concurrent-edit merges. */
function split(): { a: Y.Doc; b: Y.Doc; merge(): void } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  return {
    a,
    b,
    merge() {
      const ua = Y.encodeStateAsUpdate(a);
      const ub = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(a, ub);
      Y.applyUpdate(b, ua);
    },
  };
}

describe("seen watermarks (comments-ux 0001 C)", () => {
  it("own writes are auto-seen; others start unread", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });

    const t = getThread(doc, id)!;
    expect(threadUnreadCount(t, "alice")).toBe(0);
    expect(threadUnreadCount(t, "bob")).toBe(1);
  });

  it("markThreadSeen clears unread; a later reply re-arms it", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });

    expect(markThreadSeen(doc, id, "bob", 1000)).toBe(true);
    expect(threadUnreadCount(getThread(doc, id)!, "bob")).toBe(0);

    addMessage(doc, id, { author: "alice", body: "again", now: 2000 });
    const t = getThread(doc, id)!;
    expect(threadUnreadCount(t, "bob")).toBe(1);
    // Alice's own reply advanced her watermark too.
    expect(threadUnreadCount(t, "alice")).toBe(0);
  });

  it("is forward-only: a stale mark can never un-read newer messages", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });

    markThreadSeen(doc, id, "bob", 5000);
    markThreadSeen(doc, id, "bob", 1000); // stale tab
    expect(getThread(doc, id)!.seen?.bob).toBe(5000);
  });

  it("defaults the watermark to the newest message", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });
    addMessage(doc, id, { author: "alice", body: "more", now: 3000 });

    markThreadSeen(doc, id, "bob");
    expect(getThread(doc, id)!.seen?.bob).toBe(3000);
  });

  it("resolved threads never count as unread", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });

    setThreadResolved(doc, id, true);
    expect(threadUnreadCount(getThread(doc, id)!, "bob")).toBe(0);
  });

  it("concurrent reply + mark-seen both survive a merge", () => {
    const { a, b, merge } = split();
    const id = createThread(a, { anchor, author: "alice", body: "hi", now: 1000 });
    merge();

    markThreadSeen(b, id, "bob", 1000);
    addMessage(a, id, { author: "alice", body: "while apart", now: 2000 });
    merge();

    const t = getThread(b, id)!;
    expect(t.seen?.bob).toBe(1000);
    expect(threadUnreadCount(t, "bob")).toBe(1);
  });
});

describe("emoji reactions (comments-ux 0001 D)", () => {
  it("toggles on and off, aggregated per message → emoji → slugs", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });
    const rootId = getThread(doc, id)!.rootId;

    expect(toggleReaction(doc, id, rootId, "bob", "👍")).toBe(true);
    expect(getThread(doc, id)!.reactions).toEqual({ [rootId]: { "👍": ["bob"] } });

    toggleReaction(doc, id, rootId, "bob", "👍");
    expect(getThread(doc, id)!.reactions).toBeUndefined();
  });

  it("concurrent same-emoji reactions by two users both survive", () => {
    const { a, b, merge } = split();
    const id = createThread(a, { anchor, author: "alice", body: "hi", now: 1000 });
    merge();
    const rootId = getThread(a, id)!.rootId;

    toggleReaction(a, id, rootId, "alice", "🎉");
    toggleReaction(b, id, rootId, "bob", "🎉");
    merge();

    expect(getThread(a, id)!.reactions).toEqual({ [rootId]: { "🎉": ["alice", "bob"] } });
    expect(getThread(b, id)!.reactions).toEqual({ [rootId]: { "🎉": ["alice", "bob"] } });
  });

  it("skin-tone variants are distinct reactions", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });
    const rootId = getThread(doc, id)!.rootId;

    toggleReaction(doc, id, rootId, "alice", "👍");
    toggleReaction(doc, id, rootId, "bob", "👍🏽");
    expect(Object.keys(getThread(doc, id)!.reactions![rootId])).toHaveLength(2);
  });

  it("rejects unknown targets and separator-carrying emoji", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });
    const rootId = getThread(doc, id)!.rootId;

    expect(toggleReaction(doc, id, "no-such-message", "bob", "👍")).toBe(false);
    expect(toggleReaction(doc, "no-such-thread", rootId, "bob", "👍")).toBe(false);
    expect(toggleReaction(doc, id, rootId, "bob", "x|y")).toBe(false);
  });

  it("removeMessage sweeps the removed message's reaction keys", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, { anchor, author: "alice", body: "hi", now: 1000 });
    const replyId = addMessage(doc, id, { author: "alice", body: "re", now: 2000 })!;

    toggleReaction(doc, id, replyId, "bob", "👍");
    expect(removeMessage(doc, id, replyId)).toBe("removed");
    expect(getThread(doc, id)!.reactions).toBeUndefined();
  });
});

describe("mentions (comments-ux 0001 E data model)", () => {
  it("persists mentions and flags mention-unread until seen", () => {
    const doc = new Y.Doc();
    const id = createThread(doc, {
      anchor,
      author: "alice",
      body: "ping @bob",
      mentions: ["bob"],
      now: 1000,
    });

    const t = getThread(doc, id)!;
    expect(t.messages[0].mentions).toEqual(["bob"]);
    expect(threadMentionsUnread(t, "bob")).toBe(true);
    expect(threadMentionsUnread(t, "carol")).toBe(false);

    markThreadSeen(doc, id, "bob");
    expect(threadMentionsUnread(getThread(doc, id)!, "bob")).toBe(false);
  });
});
