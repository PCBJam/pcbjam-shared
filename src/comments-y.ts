import * as Y from "yjs";
import {
  commentMessageSchema,
  commentThreadSchema,
  commentsLiftedMarkerSchema,
  COMMENTS_LIFTED_KEY,
  Y_KDOC_COMMENTS,
  type CommentAnchor,
  type CommentMessage,
  type CommentProvenance,
  type CommentResolution,
  type CommentThread,
  type CommentsLiftedMarker,
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
    /** Capture context (git-integration 0001, C-D3); absent until working copies exist. */
    provenance?: CommentProvenance;
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
    if (opts.provenance && Object.keys(opts.provenance).length) {
      thread.set("provenance", opts.provenance);
    }
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

/**
 * Resolve (close) / reopen a thread. Independent LWW key — never conflicts
 * with concurrent replies. A resolve records where it happened (C-D8,
 * `resolution`; `at` defaults to now); a reopen clears it and stamps
 * `reopenedAt` so a later comments-file merge can tell a newer reopen from an
 * older desktop resolve (design-comments §7.2, C-N1).
 */
export function setThreadResolved(
  ydoc: Y.Doc,
  threadId: string,
  resolved: boolean,
  resolution?: Partial<CommentResolution>,
  now: number = Date.now(),
): boolean {
  const thread = commentsYMap(ydoc).get(threadId);

  if (!thread) return false;

  ydoc.transact(() => {
    thread.set("resolved", resolved);
    if (resolved) {
      thread.set("resolution", { ...resolution, at: resolution?.at ?? now });
    } else {
      if (thread.has("resolution")) thread.delete("resolution");
      thread.set("reopenedAt", now);
    }
  });
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
    provenance: thread.get("provenance"),
    resolution: thread.get("resolution"),
    reopenedAt: thread.get("reopenedAt"),
    origin: thread.get("origin"),
    ...(Object.keys(seen).length ? { seen } : {}),
    ...(Object.keys(reactions).length ? { reactions } : {}),
  });

  return parsed.success ? parsed.data : null;
}

/**
 * Which document a session is bound to, for {@link listThreads} filtering
 * (git-integration 0001). `filePath` selects the threads anchored on that
 * project file; a legacy thread without `anchor.filePath` (never lifted —
 * only possible in a file doc) counts as the session's own. `sheetPath`,
 * when given, additionally requires an equal `anchor.sheetPath` (a thread
 * without one matches every instance of the sheet file).
 */
export interface ThreadFilter {
  filePath: string;
  sheetPath?: string;
}

/** True when `thread` belongs to the document `filter` describes. */
export function threadMatches(thread: CommentThread, filter: ThreadFilter): boolean {
  const fp = thread.anchor.filePath;
  if (fp !== undefined && fp !== filter.filePath) return false;
  if (filter.sheetPath !== undefined) {
    const sp = thread.anchor.sheetPath;
    if (sp !== undefined && sp !== filter.sheetPath) return false;
  }
  return true;
}

/**
 * All threads as plain data (malformed entries dropped — including the
 * `~lifted` marker), oldest first; with `filter`, only the threads of that
 * document.
 */
export function listThreads(ydoc: Y.Doc, filter?: ThreadFilter): CommentThread[] {
  const out: CommentThread[] = [];

  for (const [key, thread] of commentsYMap(ydoc).entries()) {
    if (key.startsWith("~") || !(thread instanceof Y.Map)) continue;
    const plain = threadToPlain(thread);
    if (plain && (!filter || threadMatches(plain, filter))) out.push(plain);
  }

  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** The lift marker a file doc carries once its threads moved (or null). */
export function commentsLiftedMarker(ydoc: Y.Doc): CommentsLiftedMarker | null {
  const raw = commentsYMap(ydoc).get(COMMENTS_LIFTED_KEY);
  const parsed = commentsLiftedMarkerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Move a FILE doc's legacy threads into the PROJECT comments document
 * (design-comments §8, C-D9). Idempotent by thread id: a thread the project
 * doc already holds is skipped, sub-maps and per-user flat keys are copied
 * verbatim, `anchor.filePath` is set to `filePath` (an existing value is
 * kept), provenance stays absent. The source entries are then deleted and
 * the `~lifted` marker written, so an old client reads an empty map. Runs as
 * two transactions (one per doc); safe to run twice — the second run finds
 * an empty source and returns 0. A source doc with no threads and no marker
 * gets the marker too, so the lazy trigger stops re-checking it.
 */
export function liftLegacyComments(
  fileDoc: Y.Doc,
  projectDoc: Y.Doc,
  filePath: string,
  now: number = Date.now(),
): { moved: number; skipped: number } {
  const source = commentsYMap(fileDoc);
  const target = commentsYMap(projectDoc);
  let moved = 0;
  let skipped = 0;
  const entries: Array<[string, Y.Map<unknown>]> = [];
  for (const [key, thread] of source.entries()) {
    if (key.startsWith("~") || !(thread instanceof Y.Map)) continue;
    entries.push([key, thread]);
  }

  projectDoc.transact(() => {
    for (const [key, thread] of entries) {
      if (target.has(key)) {
        skipped += 1;
        continue;
      }
      const copy = new Y.Map<unknown>();
      for (const [k, v] of thread.entries()) {
        if (v instanceof Y.Map) {
          const sub = new Y.Map<unknown>();
          for (const [mk, mv] of v.entries()) sub.set(mk, structuredCloneish(mv));
          copy.set(k, sub);
        } else if (k === "anchor" && v && typeof v === "object") {
          const anchor = v as Record<string, unknown>;
          copy.set(k, { ...anchor, filePath: typeof anchor.filePath === "string" ? anchor.filePath : filePath });
        } else {
          copy.set(k, structuredCloneish(v));
        }
      }
      target.set(key, copy);
      moved += 1;
    }
  });

  fileDoc.transact(() => {
    for (const [key] of entries) source.delete(key);
    const marker: CommentsLiftedMarker = { at: now, count: moved + skipped };
    source.set(COMMENTS_LIFTED_KEY, marker as unknown as Y.Map<unknown>);
  });

  return { moved, skipped };
}

/** Plain-value copy (Y.Map values here are JSON-ish: objects, numbers, strings). */
function structuredCloneish<T>(v: T): T {
  return v && typeof v === "object" ? (JSON.parse(JSON.stringify(v)) as T) : v;
}

/**
 * A thread's state in a session bound to one document (design-comments
 * §6.1): `anchored` when its item resolves (or it is item-less), `detached`
 * when the file is present but the item is gone, `absent` when the thread's
 * file is not part of the working copy at all.
 */
export type ThreadState = "anchored" | "detached" | "absent";

export function detachedState(
  thread: CommentThread,
  ctx: {
    /** Does the thread's file exist in this working copy? (Legacy threads without `filePath` → true.) */
    fileExists: (filePath: string | undefined) => boolean;
    /** Does the anchor item resolve in that file's document? Only consulted when `fileExists`. */
    hasItem: (itemUuid: string, filePath: string | undefined) => boolean;
  },
): ThreadState {
  const fp = thread.anchor.filePath;
  if (!ctx.fileExists(fp)) return "absent";
  if (thread.anchor.itemUuid && !ctx.hasItem(thread.anchor.itemUuid, fp)) return "detached";
  return "anchored";
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
 *
 * `ydoc` is the doc holding the ITEMS — since git-integration 0001 that is
 * the FILE doc, while the thread itself lives in the project document.
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
        return finiteOr(
          {
            x: x * iuPerMm + (anchor.offset?.x ?? 0),
            y: y * iuPerMm + (anchor.offset?.y ?? 0),
            detached: false,
          },
        );
      }
    }

    return finiteOr({ ...anchor.pos, detached: true });
  }

  return finiteOr({ ...anchor.pos, detached: false });
}

/** Findings W-1: a world position must never be non-finite (the wasm pins
 *  bridge serializes it as JSON null and throws). The `x*iuPerMm + offset`
 *  product can overflow even when the inputs passed the wire schema; a
 *  poisoned pin parks at the origin, detached, so it stays deletable. */
function finiteOr(r: { x: number; y: number; detached: boolean }) {
  return Number.isFinite(r.x) && Number.isFinite(r.y) ? r : { x: 0, y: 0, detached: true };
}
