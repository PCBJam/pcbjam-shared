import * as Y from "yjs";
import {
  commentMessageSchema,
  commentThreadSchema,
  Y_KDOC_COMMENTS,
  type CommentAnchor,
  type CommentMessage,
  type CommentThread,
} from "./comments-wire.js";
import { args, field } from "./kicad-doc.js";
import { kicadItemsMap, yToItemUnchecked } from "./kicad-y.js";

/**
 * Y-side comment helpers (collab-presence 0004). Pure building blocks over a
 * passed-in Y.Doc — transport-unaware per the ysync 0008 rule; the GPL editor
 * owns observation lifecycles and rendering.
 *
 * Storage shape under `Y_KDOC_COMMENTS` (Y.Map<threadId, thread Y.Map>):
 *   thread: { id, anchor (plain), resolved, createdBy, createdAt, rootId,
 *             messages: Y.Map<messageId, plain CommentMessage> }
 * Messages are whole-value LWW by id; display order is (createdAt, id).
 */

export function commentsYMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(Y_KDOC_COMMENTS);
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function messagesOf(thread: Y.Map<unknown>): Y.Map<unknown> | undefined {
  const m = thread.get("messages");
  return m instanceof Y.Map ? m : undefined;
}

/** Create a thread (pin) with its opening message. Returns the thread id. */
export function createThread(
  ydoc: Y.Doc,
  opts: {
    anchor: CommentAnchor;
    author: string;
    body: string;
    id?: string;
    now?: number;
  },
): string {
  const threadId = opts.id ?? uid();
  const now = opts.now ?? Date.now();
  const rootId = uid();

  ydoc.transact(() => {
    const thread = new Y.Map<unknown>();
    thread.set("id", threadId);
    thread.set("anchor", opts.anchor);
    thread.set("resolved", false);
    thread.set("createdBy", opts.author);
    thread.set("createdAt", now);
    thread.set("rootId", rootId);

    const messages = new Y.Map<unknown>();
    const root: CommentMessage = { id: rootId, author: opts.author, body: opts.body, createdAt: now };
    messages.set(rootId, root);
    thread.set("messages", messages);

    commentsYMap(ydoc).set(threadId, thread);
  });

  return threadId;
}

/** Reply to a thread. Returns the new message id, or null on unknown thread. */
export function addMessage(
  ydoc: Y.Doc,
  threadId: string,
  opts: { author: string; body: string; id?: string; now?: number },
): string | null {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread && messagesOf(thread);

  if (!messages) return null;

  const id = opts.id ?? uid();
  const msg: CommentMessage = {
    id,
    author: opts.author,
    body: opts.body,
    createdAt: opts.now ?? Date.now(),
  };
  messages.set(id, msg);
  return id;
}

/** Replace a message's body (whole-message LWW). False on unknown ids. */
export function editMessage(
  ydoc: Y.Doc,
  threadId: string,
  messageId: string,
  body: string,
  now?: number,
): boolean {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread && messagesOf(thread);
  const parsed = messages && commentMessageSchema.safeParse(messages.get(messageId));

  if (!parsed || !parsed.success) return false;

  messages.set(messageId, { ...parsed.data, body, editedAt: now ?? Date.now() });
  return true;
}

/**
 * Remove a message. Removing the ROOT message — or the last one standing —
 * deletes the whole thread (the pin), figma-style.
 */
export function removeMessage(
  ydoc: Y.Doc,
  threadId: string,
  messageId: string,
): "removed" | "thread-deleted" | false {
  const comments = commentsYMap(ydoc);
  const thread = comments.get(threadId);
  const messages = thread && messagesOf(thread);

  if (!messages || !messages.has(messageId)) return false;

  if (thread.get("rootId") === messageId || messages.size <= 1) {
    comments.delete(threadId);
    return "thread-deleted";
  }

  messages.delete(messageId);
  return "removed";
}

/** Re-pin a thread (drag): replace its anchor wholesale (LWW — a concurrent
 *  drag of the same pin converges to one position). */
export function setThreadAnchor(ydoc: Y.Doc, threadId: string, anchor: CommentAnchor): boolean {
  const thread = commentsYMap(ydoc).get(threadId);

  if (!thread) return false;

  thread.set("anchor", anchor);
  return true;
}

/** Resolve (close) / reopen a thread. Independent LWW key — never conflicts
 *  with concurrent replies. */
export function setThreadResolved(ydoc: Y.Doc, threadId: string, resolved: boolean): boolean {
  const thread = commentsYMap(ydoc).get(threadId);

  if (!thread) return false;

  thread.set("resolved", resolved);
  return true;
}

/** Delete a whole thread (pin + all replies). */
export function deleteThread(ydoc: Y.Doc, threadId: string): boolean {
  const comments = commentsYMap(ydoc);

  if (!comments.has(threadId)) return false;

  comments.delete(threadId);
  return true;
}

function threadToPlain(thread: Y.Map<unknown>): CommentThread | null {
  const messages = messagesOf(thread);
  const list: CommentMessage[] = [];

  if (messages) {
    for (const raw of messages.values()) {
      const parsed = commentMessageSchema.safeParse(raw);
      if (parsed.success) list.push(parsed.data);
    }
  }

  list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const parsed = commentThreadSchema.safeParse({
    id: thread.get("id"),
    anchor: thread.get("anchor"),
    resolved: thread.get("resolved"),
    createdBy: thread.get("createdBy"),
    createdAt: thread.get("createdAt"),
    rootId: thread.get("rootId"),
    messages: list,
  });

  return parsed.success ? parsed.data : null;
}

/** All threads as plain data (malformed entries dropped), oldest first. */
export function listThreads(ydoc: Y.Doc): CommentThread[] {
  const out: CommentThread[] = [];

  for (const thread of commentsYMap(ydoc).values()) {
    const plain = threadToPlain(thread);
    if (plain) out.push(plain);
  }

  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function getThread(ydoc: Y.Doc, threadId: string): CommentThread | null {
  const thread = commentsYMap(ydoc).get(threadId);
  return thread ? threadToPlain(thread) : null;
}

/** Deep-observe the comments map. Returns the unobserve function. */
export function observeComments(ydoc: Y.Doc, cb: () => void): () => void {
  const map = commentsYMap(ydoc);
  const handler = () => cb();
  map.observeDeep(handler);
  return () => map.unobserveDeep(handler);
}

/**
 * Resolve an anchor to its current world position (editor IU).
 *
 * When the anchor names an item that still exists in `kdoc_items` and carries
 * an `(at x y …)` field, the pin TRACKS it: position = item origin (file mm ×
 * `iuPerMm` — 1e6 for pcbnew, 1e4 for eeschema) + the stored offset. A deleted
 * item (or one with no position) detaches the pin to its captured `pos`.
 */
export function resolveAnchor(
  ydoc: Y.Doc,
  anchor: CommentAnchor,
  iuPerMm: number,
): { x: number; y: number; detached: boolean } {
  if (anchor.itemUuid) {
    const ym = kicadItemsMap(ydoc).get(anchor.itemUuid);

    if (ym) {
      const item = yToItemUnchecked(ym);
      const at = field(item.body, "at");
      const [xs, ys] = at ? args(at) : [];
      const x = Number(xs);
      const y = Number(ys);

      if (Number.isFinite(x) && Number.isFinite(y)) {
        return {
          x: x * iuPerMm + (anchor.offset?.x ?? 0),
          y: y * iuPerMm + (anchor.offset?.y ?? 0),
          detached: false,
        };
      }
    }

    return { ...anchor.pos, detached: true };
  }

  return { ...anchor.pos, detached: false };
}
