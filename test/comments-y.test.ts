import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addMessage,
  createThread,
  deleteThread,
  editMessage,
  getThread,
  listThreads,
  observeComments,
  removeMessage,
  resolveAnchor,
  setThreadResolved,
} from "../src/comments-y.js";
import { docToFile, fileToDoc } from "../src/kicad-doc.js";
import { applyDeltaToY, docToY, yToDoc } from "../src/kicad-y.js";

/** Two Y.Docs joined by relaying their updates (a stand-in for any provider). */
function pair(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "from-a"));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "from-b"));
  return { a, b };
}

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

const BASE = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1"))
  (footprint "TestLib:R"
    (layer "F.Cu")
    (uuid "fp-1")
    (at 100 50)
  )
)`;

const ANCHOR_FREE = { pos: { x: 10, y: 20 } };

describe("comment CRUD", () => {
  it("create / reply / edit / resolve / delete round-trip", () => {
    const doc = new Y.Doc();
    const t = createThread(doc, {
      anchor: ANCHOR_FREE,
      author: "alice",
      body: "check this",
      now: 1000,
    });

    let thread = getThread(doc, t)!;
    expect(thread.messages.map((m) => m.body)).toEqual(["check this"]);
    expect(thread.resolved).toBe(false);
    expect(thread.createdBy).toBe("alice");

    const reply = addMessage(doc, t, { author: "bob", body: "agreed", now: 2000 })!;
    expect(editMessage(doc, t, reply, "agreed!", 3000)).toBe(true);
    expect(setThreadResolved(doc, t, true)).toBe(true);

    thread = getThread(doc, t)!;
    expect(thread.messages.map((m) => m.body)).toEqual(["check this", "agreed!"]);
    expect(thread.messages[1]!.editedAt).toBe(3000);
    expect(thread.resolved).toBe(true);

    expect(removeMessage(doc, t, reply)).toBe("removed");
    expect(getThread(doc, t)!.messages).toHaveLength(1);
    expect(deleteThread(doc, t)).toBe(true);
    expect(listThreads(doc)).toEqual([]);
  });

  it("deleting the root message (or the last one) deletes the thread", () => {
    const doc = new Y.Doc();
    const t = createThread(doc, { anchor: ANCHOR_FREE, author: "a", body: "root", now: 1 });
    const root = getThread(doc, t)!.rootId;
    addMessage(doc, t, { author: "b", body: "reply", now: 2 });

    expect(removeMessage(doc, t, root)).toBe("thread-deleted");
    expect(listThreads(doc)).toEqual([]);

    const t2 = createThread(doc, { anchor: ANCHOR_FREE, author: "a", body: "solo", now: 3 });
    const solo = getThread(doc, t2)!.messages[0]!.id;
    expect(removeMessage(doc, t2, solo)).toBe("thread-deleted");
    expect(listThreads(doc)).toEqual([]);
  });

  it("observeComments fires on every mutation and unsubscribes cleanly", () => {
    const doc = new Y.Doc();
    let fired = 0;
    const off = observeComments(doc, () => fired++);

    const t = createThread(doc, { anchor: ANCHOR_FREE, author: "a", body: "x", now: 1 });
    addMessage(doc, t, { author: "b", body: "y", now: 2 });
    setThreadResolved(doc, t, true);
    expect(fired).toBe(3);

    off();
    deleteThread(doc, t);
    expect(fired).toBe(3);
  });
});

describe("merge semantics", () => {
  it("concurrent reply + resolve on one thread both survive", () => {
    const { a, b, merge } = split();
    const t = createThread(a, { anchor: ANCHOR_FREE, author: "alice", body: "root", now: 1 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    addMessage(a, t, { author: "alice", body: "ping", now: 2 });
    setThreadResolved(b, t, true);
    merge();

    for (const doc of [a, b]) {
      const thread = getThread(doc, t)!;
      expect(thread.messages.map((m) => m.body)).toEqual(["root", "ping"]);
      expect(thread.resolved).toBe(true);
    }
  });

  it("concurrent edits of ONE message converge LWW (no duplicates)", () => {
    const { a, b, merge } = split();
    const t = createThread(a, { anchor: ANCHOR_FREE, author: "alice", body: "root", now: 1 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const root = getThread(a, t)!.rootId;

    editMessage(a, t, root, "from-a", 10);
    editMessage(b, t, root, "from-b", 11);
    merge();

    const inA = getThread(a, t)!;
    const inB = getThread(b, t)!;
    expect(inA.messages).toHaveLength(1);
    expect(inA.messages[0]!.body).toEqual(inB.messages[0]!.body);
    expect(["from-a", "from-b"]).toContain(inA.messages[0]!.body);
  });

  it("threads created concurrently on two peers both arrive", () => {
    const { a, b } = pair();
    const ta = createThread(a, { anchor: ANCHOR_FREE, author: "alice", body: "A", now: 1 });
    const tb = createThread(b, { anchor: ANCHOR_FREE, author: "bob", body: "B", now: 2 });

    for (const doc of [a, b]) {
      const ids = listThreads(doc).map((t) => t.id);
      expect(ids).toContain(ta);
      expect(ids).toContain(tb);
    }
  });
});

describe("anchor resolution", () => {
  it("tracks the anchor item's position through a slot update; detaches on delete", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(BASE), ydoc);

    const anchor = {
      itemUuid: "fp-1",
      pos: { x: 100e6, y: 50e6 },
      offset: { x: 5e6, y: 0 },
    };

    // (at 100 50) mm × 1e6 IU/mm + offset.
    expect(resolveAnchor(ydoc, anchor, 1e6)).toEqual({ x: 105e6, y: 50e6, detached: false });

    // Move the footprint by replacing its slot body (the normal ysync flow).
    const moved = fileToDoc(BASE.replace("(at 100 50)", "(at 120 60)"));
    applyDeltaToY(ydoc, {
      added: [],
      removed: [],
      updated: [{ uuid: "fp-1", ...moved.items["fp-1"]! }],
    });
    expect(resolveAnchor(ydoc, anchor, 1e6)).toEqual({ x: 125e6, y: 60e6, detached: false });

    // Delete the item → the pin falls back to its captured absolute position.
    applyDeltaToY(ydoc, { added: [], removed: ["fp-1"], updated: [] });
    expect(resolveAnchor(ydoc, anchor, 1e6)).toEqual({ x: 100e6, y: 50e6, detached: true });
  });

  it("item-less anchors sit at their absolute position, never detached", () => {
    const ydoc = new Y.Doc();
    expect(resolveAnchor(ydoc, { pos: { x: 7, y: 9 } }, 1e6)).toEqual({
      x: 7,
      y: 9,
      detached: false,
    });
  });
});

describe("file-byte isolation (the invariant that keeps comments out of .kicad_*)", () => {
  it("materialized bytes are identical with and without comments", () => {
    const clean = new Y.Doc();
    docToY(fileToDoc(BASE), clean);
    const cleanText = docToFile(yToDoc(clean));

    const commented = new Y.Doc();
    docToY(fileToDoc(BASE), commented);
    const t = createThread(commented, {
      anchor: { itemUuid: "fp-1", pos: { x: 0, y: 0 } },
      author: "alice",
      body: "does not belong in the file",
      now: 1,
    });
    addMessage(commented, t, { author: "bob", body: "indeed", now: 2 });

    expect(docToFile(yToDoc(commented))).toBe(cleanText);
  });

  it("re-running docToY over a commented doc leaves the threads untouched", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(BASE), ydoc);
    const t = createThread(ydoc, { anchor: ANCHOR_FREE, author: "a", body: "hi", now: 1 });

    docToY(fileToDoc(BASE), ydoc); // a re-seed of the kicad content keys
    expect(getThread(ydoc, t)!.messages[0]!.body).toBe("hi");
  });
});
