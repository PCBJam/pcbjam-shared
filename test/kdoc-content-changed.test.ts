import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addMessage, createThread, toggleReaction } from "../src/comments-y.js";
import { Y_KDOC_ITEMS, Y_KDOC_LAYOUT, Y_KDOC_META, transactionTouchesKdocContent } from "../src/kicad-y.js";

const anchor = { pos: { x: 1, y: 1 } };

/** Run `fn` inside one transaction and report the helper's verdict for it. */
function verdict(doc: Y.Doc, fn: () => void): boolean {
  let seen: boolean | null = null;
  const listener = (tr: Y.Transaction): void => {
    seen = transactionTouchesKdocContent(tr);
  };
  doc.on("afterTransaction", listener);
  doc.transact(fn, "test");
  doc.off("afterTransaction", listener);
  if (seen === null) throw new Error("no transaction observed");
  return seen;
}

describe("transactionTouchesKdocContent (kicad-validity 0002)", () => {
  it("comment-only transactions are not content", () => {
    const doc = new Y.Doc();
    doc.getMap(Y_KDOC_META).set("root", "kicad_pcb");
    let threadId = "";
    expect(
      verdict(doc, () => {
        threadId = createThread(doc, { anchor, author: "a", authorName: "A", body: "hi", now: 1 });
      }),
    ).toBe(false);
    expect(verdict(doc, () => addMessage(doc, threadId, { author: "b", body: "yo", now: 2 }))).toBe(false);
    expect(verdict(doc, () => toggleReaction(doc, threadId, "x", "b", "👍", 3))).toBe(false);
  });

  it("kdoc root writes are content, including nested and deleted entries", () => {
    const doc = new Y.Doc();
    expect(verdict(doc, () => doc.getMap(Y_KDOC_META).set("root", "kicad_pcb"))).toBe(true);
    const items = doc.getMap<Y.Map<unknown>>(Y_KDOC_ITEMS);
    const item = new Y.Map<unknown>();
    expect(verdict(doc, () => items.set("u1", item))).toBe(true);
    // Nested write inside an item map walks up to the items root.
    expect(verdict(doc, () => item.set("body", ["x"]))).toBe(true);
    expect(verdict(doc, () => doc.getArray(Y_KDOC_LAYOUT).push([{ k: "x" }]))).toBe(true);
    expect(verdict(doc, () => items.delete("u1"))).toBe(true);
  });

  it("a mixed transaction counts as content; an unknown root counts as content", () => {
    const doc = new Y.Doc();
    const threadId = createThread(doc, { anchor, author: "a", authorName: "A", body: "hi", now: 1 });
    expect(
      verdict(doc, () => {
        addMessage(doc, threadId, { author: "b", body: "yo", now: 2 });
        doc.getMap(Y_KDOC_META).set("root", "kicad_sch");
      }),
    ).toBe(true);
    expect(verdict(doc, () => doc.getMap("some_future_root").set("k", 1))).toBe(true);
  });

  it("remote updates are classified the same way", () => {
    const src = new Y.Doc();
    const dst = new Y.Doc();
    const threadId = createThread(src, { anchor, author: "a", authorName: "A", body: "hi", now: 1 });
    Y.applyUpdate(dst, Y.encodeStateAsUpdate(src));
    const sv = Y.encodeStateVector(dst);
    addMessage(src, threadId, { author: "b", body: "yo", now: 2 });
    const commentOnly = Y.encodeStateAsUpdate(src, sv);
    const sv2 = Y.encodeStateVector(src);
    src.getMap(Y_KDOC_META).set("root", "kicad_pcb");
    const content = Y.encodeStateAsUpdate(src, sv2);

    const seen: boolean[] = [];
    dst.on("afterTransaction", (tr) => seen.push(transactionTouchesKdocContent(tr)));
    Y.applyUpdate(dst, commentOnly, "remote");
    Y.applyUpdate(dst, content, "remote");
    expect(seen).toEqual([false, true]);
  });
});
