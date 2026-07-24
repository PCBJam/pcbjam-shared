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
 *             messages: Y.Map<messageId, plain CommentMessage>,
 *             seen:<slug> → ms epoch            (comments-ux 0001 C)
 *             react:<msgId>|<slug>|<emoji> → ms (comments-ux 0001 D) }
 * Messages are whole-value LWW by id; display order is (createdAt, id).
 *
 * Per-user state (seen, reactions) lives in FLAT thread keys, never inside
 * message values (whole-value LWW would drop concurrent writers) and never in
 * sub-Y.Maps (concurrent lazy creation loses one side): each user writes only
 * their own keys, so merges are trivially safe.
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
    /** Display name / email at write time (see comments-wire.ts `authorFields`). */
    authorName?: string;
    authorEmail?: string;
    body: string;
    /** Mentioned slugs, from accepted composer completions (0001 E). */
    mentions?: string[];
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
    if (opts.authorName) thread.set("authorName", opts.authorName);
    if (opts.authorEmail) thread.set("authorEmail", opts.authorEmail);
    thread.set("createdAt", now);
    thread.set("rootId", rootId);

    const messages = new Y.Map<unknown>();
    const root: CommentMessage = {
      id: rootId,
      author: opts.author,
      ...(opts.authorName ? { authorName: opts.authorName } : {}),
      ...(opts.authorEmail ? { authorEmail: opts.authorEmail } : {}),
      body: opts.body,
      ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
      createdAt: now,
    };
    messages.set(rootId, root);
    thread.set("messages", messages);

    // Your own write is definitionally seen (0001 C).
    thread.set(`${SEEN_PREFIX}${opts.author}`, now);

    commentsYMap(ydoc).set(threadId, thread);
  });

  return threadId;
}

/** Reply to a thread. Returns the new message id, or null on unknown thread. */
export function addMessage(
  ydoc: Y.Doc,
  threadId: string,
  opts: {
    author: string;
    authorName?: string;
    authorEmail?: string;
    body: string;
    /** Mentioned slugs, from accepted composer completions (0001 E). */
    mentions?: string[];
    id?: string;
    now?: number;
  },
): string | null {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread && messagesOf(thread);

  if (!messages) return null;

  const id = opts.id ?? uid();
  const now = opts.now ?? Date.now();
  const msg: CommentMessage = {
    id,
    author: opts.author,
    ...(opts.authorName ? { authorName: opts.authorName } : {}),
    ...(opts.authorEmail ? { authorEmail: opts.authorEmail } : {}),
    body: opts.body,
    ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
    createdAt: now,
  };

  ydoc.transact(() => {
    messages.set(id, msg);
    // Your own reply is definitionally seen (0001 C) — forward-only, so a
    // racing markThreadSeen can't be regressed either.
    const seenKey = `${SEEN_PREFIX}${opts.author}`;
    const prev = thread.get(seenKey);
    if (typeof prev !== "number" || prev < now) thread.set(seenKey, now);
  });
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

  ydoc.transact(() => {
    messages.delete(messageId);

    // Sweep the removed message's reaction keys so they don't linger as
    // orphans (concurrent reactions to a message being deleted are lost — a
    // reaction to a gone message has nothing to attach to anyway).
    const stale = [...thread.keys()].filter((k) =>
      k.startsWith(`${REACT_PREFIX}${messageId}${REACT_SEP}`),
    );
    for (const k of stale) thread.delete(k);
  });
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

const SEEN_PREFIX = "seen:";
const REACT_PREFIX = "react:";
const REACT_SEP = "|";

function reactKey(messageId: string, slug: string, emoji: string): string {
  return `${REACT_PREFIX}${messageId}${REACT_SEP}${slug}${REACT_SEP}${emoji}`;
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

  // Aggregate the flat per-user keys (seen watermarks, reaction toggles).
  const seen: Record<string, number> = {};
  const reactions: Record<string, Record<string, string[]>> = {};

  for (const [key, value] of thread.entries()) {
    if (key.startsWith(SEEN_PREFIX)) {
      if (typeof value === "number") seen[key.slice(SEEN_PREFIX.length)] = value;
    } else if (key.startsWith(REACT_PREFIX)) {
      // emoji may itself never contain the separator (toggleReaction rejects
      // it), so a 3-way split is unambiguous; the tail re-join is belt and
      // braces against foreign writers.
      const parts = key.slice(REACT_PREFIX.length).split(REACT_SEP);
      const [messageId, slug] = parts;
      const emoji = parts.slice(2).join(REACT_SEP);
      if (messageId && slug && emoji) {
        ((reactions[messageId] ??= {})[emoji] ??= []).push(slug);
      }
    }
  }

  for (const perMessage of Object.values(reactions)) {
    for (const slugs of Object.values(perMessage)) slugs.sort();
  }

  const parsed = commentThreadSchema.safeParse({
    id: thread.get("id"),
    anchor: thread.get("anchor"),
    resolved: thread.get("resolved"),
    createdBy: thread.get("createdBy"),
    authorName: thread.get("authorName"),
    authorEmail: thread.get("authorEmail"),
    createdAt: thread.get("createdAt"),
    rootId: thread.get("rootId"),
    messages: list,
    ...(Object.keys(seen).length ? { seen } : {}),
    ...(Object.keys(reactions).length ? { reactions } : {}),
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

/**
 * Advance a user's seen watermark on a thread (comments-ux 0001 C). Forward-
 * only: a stale tab marking seen can never un-read newer messages. `upTo`
 * defaults to the newest message's createdAt (else now). Own-key write —
 * concurrency-safe by construction.
 */
export function markThreadSeen(
  ydoc: Y.Doc,
  threadId: string,
  slug: string,
  upTo?: number,
): boolean {
  const thread = commentsYMap(ydoc).get(threadId);

  if (!thread || !slug) return false;

  let at = upTo;
  if (at === undefined) {
    const messages = messagesOf(thread);
    at = 0;
    if (messages) {
      for (const raw of messages.values()) {
        const parsed = commentMessageSchema.safeParse(raw);
        if (parsed.success && parsed.data.createdAt > at) at = parsed.data.createdAt;
      }
    }
    if (at === 0) at = Date.now();
  }

  const key = `${SEEN_PREFIX}${slug}`;
  const prev = thread.get(key);
  if (typeof prev === "number" && prev >= at) return true;

  thread.set(key, at);
  return true;
}

/** Messages in a (plain) thread newer than the user's seen watermark, own
 *  messages excluded. Resolved threads never count as unread. */
export function threadUnreadCount(thread: CommentThread, slug: string): number {
  if (thread.resolved) return 0;

  const at = thread.seen?.[slug] ?? 0;
  return thread.messages.filter((m) => m.author !== slug && m.createdAt > at).length;
}

/** True when any of the thread's unread-for-`slug` messages mentions them. */
export function threadMentionsUnread(thread: CommentThread, slug: string): boolean {
  if (thread.resolved) return false;

  const at = thread.seen?.[slug] ?? 0;
  return thread.messages.some(
    (m) => m.author !== slug && m.createdAt > at && (m.mentions ?? []).includes(slug),
  );
}

/**
 * Toggle `slug`'s `emoji` reaction on a message (comments-ux 0001 D). Own-key
 * set/delete only — two users reacting concurrently with the same emoji both
 * survive. Rejects unknown thread/message and separator-carrying emoji.
 */
export function toggleReaction(
  ydoc: Y.Doc,
  threadId: string,
  messageId: string,
  slug: string,
  emoji: string,
): boolean {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread && messagesOf(thread);

  if (!messages || !messages.has(messageId)) return false;
  if (!slug || !emoji || emoji.includes(REACT_SEP) || slug.includes(REACT_SEP)) return false;

  const key = reactKey(messageId, slug, emoji);

  if (thread.has(key)) thread.delete(key);
  else thread.set(key, Date.now());

  return true;
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
