import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addMessage, createThread } from "../src/comments-y.js";
import { commentAuthorColors } from "../src/presence-colors.js";
import { PRESENCE_COLORS } from "../src/presence-wire.js";

const anchor = { pos: { x: 0, y: 0 } };

describe("commentAuthorColors (0009 C)", () => {
  it("assigns palette slots by first-appearance order", () => {
    const doc = new Y.Doc();
    const t1 = createThread(doc, { anchor, author: "alice", body: "a", now: 1 });
    addMessage(doc, t1, { author: "bob", body: "b", now: 2 });
    createThread(doc, { anchor, author: "carol", body: "c", now: 3 });

    const colors = commentAuthorColors(doc);
    expect(colors.get("alice")).toBe(PRESENCE_COLORS[0]);
    expect(colors.get("bob")).toBe(PRESENCE_COLORS[1]);
    expect(colors.get("carol")).toBe(PRESENCE_COLORS[2]);
  });

  it("is stable — an author keeps their slot on later comments", () => {
    const doc = new Y.Doc();
    const t1 = createThread(doc, { anchor, author: "alice", body: "a", now: 1 });
    createThread(doc, { anchor, author: "bob", body: "b", now: 2 });
    addMessage(doc, t1, { author: "alice", body: "again", now: 3 });

    const colors = commentAuthorColors(doc);
    expect(colors.get("alice")).toBe(PRESENCE_COLORS[0]);
    expect(colors.get("bob")).toBe(PRESENCE_COLORS[1]);
    expect(colors.size).toBe(2);
  });

  it("wraps round-robin past the palette size", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < PRESENCE_COLORS.length + 1; i++) {
      createThread(doc, { anchor, author: `user-${i}`, body: "x", now: i + 1 });
    }
    const colors = commentAuthorColors(doc);
    expect(colors.get(`user-${PRESENCE_COLORS.length}`)).toBe(PRESENCE_COLORS[0]);
  });

  it("is identical on a replicated doc (deterministic across clients)", () => {
    const a = new Y.Doc();
    createThread(a, { anchor, author: "alice", body: "a", now: 1 });
    createThread(a, { anchor, author: "bob", body: "b", now: 2 });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect([...commentAuthorColors(b)]).toEqual([...commentAuthorColors(a)]);
  });

  it("is empty for a doc with no comments", () => {
    expect(commentAuthorColors(new Y.Doc()).size).toBe(0);
  });
});
