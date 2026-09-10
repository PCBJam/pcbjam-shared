import { z } from "zod";
import * as Y from "yjs";
import type { CommentMessage, CommentThread } from "./comments-wire.js";
import { commentsYMap, getThread, listThreads } from "./comments-y.js";

/**
 * Comment moderation (comments-ux 0003 §6): tombstones, never deletes.
 *
 * - *Remove comment* keeps the author and replaces the body with
 *   {@link MODERATED_BODY} (`moderation: "removed"`).
 * - *Ban* tombstones the author too ({@link REMOVED_AUTHOR} /
 *   {@link REMOVED_BODY}, `moderation: "banned-author"`), drops the banned
 *   slug's seen/reaction keys, and deletes a thread whose every message was
 *   the banned author's (nothing of value remains).
 * The originals are returned to the caller so the closed side can archive
 * them for appeal; {@link restoreMessage} / {@link restoreThread} put them
 * back (same ids, so the CRDT converges by LWW).
 *
 * `~removed` can never collide with a real slug (slugs are kebab-case) and
 * never matches a commenter's own-message rules, so nobody can edit a
 * tombstone. Old clients render the placeholders as plain text.
 */

export const REMOVED_AUTHOR = "~removed";
export const REMOVED_AUTHOR_NAME = "[writer removed]";
export const REMOVED_BODY = "[removed]";
export const MODERATED_BODY = "[removed by moderation]";

const SEEN_PREFIX = "seen:";
const REACT_PREFIX = "react:";

// --- reports (the wire shape of the report routes) ---

export const commentReportReasonSchema = z.enum(["spam", "abuse", "phishing", "other"]);
export type CommentReportReason = z.infer<typeof commentReportReasonSchema>;

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);

export const commentReportBodySchema = z.object({
  threadId: idSchema,
  messageId: idSchema.optional(),
  reason: commentReportReasonSchema,
  note: z.string().max(500).optional(),
});
export type CommentReportBody = z.infer<typeof commentReportBodySchema>;

/** `POST` target for reporting a comment on a document. */
export function commentReportUrl(scope: string, project: string, filePath: string): string {
  const enc = filePath
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return `/api/scopes/${encodeURIComponent(scope)}/projects/${encodeURIComponent(project)}/files/${enc}/comments/report`;
}

/** What the app server hands a document's room over `/room/moderate`. */
export const moderatePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove"), threadId: idSchema, messageId: idSchema, now: z.number().finite().optional() }),
  z.object({ kind: z.literal("restore-message"), threadId: idSchema, messageId: idSchema, original: z.unknown() }),
  z.object({ kind: z.literal("restore-thread"), thread: z.unknown() }),
  z.object({ kind: z.literal("tombstone-author"), slug: z.string().min(1), now: z.number().finite().optional() }),
]);
export type ModeratePayload = z.infer<typeof moderatePayloadSchema>;

/** `/room/close-connections` body: by slug, or every read-only socket. */
export const closeConnectionsPayloadSchema = z.object({
  slug: z.string().min(1).optional(),
  readOnly: z.boolean().optional(),
  /** Board rooms: also run the banned-author tombstone pass for `slug`. */
  tombstone: z.boolean().optional(),
});
export type CloseConnectionsPayload = z.infer<typeof closeConnectionsPayloadSchema>;

// --- helpers ---

function messagesOf(thread: Y.Map<unknown>): Y.Map<unknown> | undefined {
  const m = thread.get("messages");
  return m instanceof Y.Map ? m : undefined;
}

/** Distinct author slugs present in a document's comments. */
export function commentAuthors(ydoc: Y.Doc): string[] {
  const out = new Set<string>();
  for (const t of listThreads(ydoc)) {
    if (t.createdBy) out.add(t.createdBy);
    for (const m of t.messages) if (m.author) out.add(m.author);
  }
  out.delete(REMOVED_AUTHOR);
  return [...out];
}

/** Parse a document's comment threads out of an encoded Yjs update. */
export function commentThreadsFromUpdate(update: Uint8Array): CommentThread[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return listThreads(doc);
  } finally {
    doc.destroy();
  }
}

// --- remove / restore one message ---

export function removeMessageByModeration(
  ydoc: Y.Doc,
  threadId: string,
  messageId: string,
  now: number = Date.now(),
): { ok: true; original: CommentMessage } | { ok: false } {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread && messagesOf(thread);
  const raw = messages?.get(messageId);
  if (!messages || !raw || typeof raw !== "object") return { ok: false };
  const original = raw as CommentMessage;
  if (original.moderation) return { ok: false };
  ydoc.transact(() => {
    const tomb: CommentMessage = {
      ...original,
      body: MODERATED_BODY,
      mentions: [],
      editedAt: now,
      moderation: "removed",
    };
    messages.set(messageId, tomb);
  }, "moderation");
  return { ok: true, original };
}

export function restoreMessage(
  ydoc: Y.Doc,
  threadId: string,
  messageId: string,
  original: CommentMessage,
): boolean {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread && messagesOf(thread);
  if (!messages) return false;
  ydoc.transact(() => {
    const { moderation: _drop, ...clean } = original;
    messages.set(messageId, clean);
  }, "moderation");
  return true;
}

// --- ban: tombstone everything an author wrote ---

export interface TombstoneReport {
  /** Messages rewritten to the banned-author tombstone. */
  messages: number;
  /** Threads deleted outright (every message was the banned author's). */
  threadsDeleted: number;
  archivedMessages: Array<{ threadId: string; messageId: string; original: CommentMessage }>;
  archivedThreads: Array<{ threadId: string; original: CommentThread }>;
}

export function tombstoneAuthor(ydoc: Y.Doc, slug: string, now: number = Date.now()): TombstoneReport {
  const report: TombstoneReport = {
    messages: 0,
    threadsDeleted: 0,
    archivedMessages: [],
    archivedThreads: [],
  };
  if (!slug || slug === REMOVED_AUTHOR) return report;
  const comments = commentsYMap(ydoc);

  ydoc.transact(() => {
    for (const plain of listThreads(ydoc)) {
      const involved =
        plain.createdBy === slug || plain.messages.some((m) => m.author === slug);
      const yThread = comments.get(plain.id);
      if (!yThread) continue;

      // Own flat keys of the banned slug go regardless of authorship.
      for (const key of [...yThread.keys()]) {
        if (
          key === `${SEEN_PREFIX}${slug}` ||
          (key.startsWith(REACT_PREFIX) && key.split("|")[1] === slug)
        ) {
          yThread.delete(key);
        }
      }
      if (!involved) continue;

      const allBanned = plain.messages.every(
        (m) => m.author === slug || m.author === REMOVED_AUTHOR,
      );
      if (allBanned && plain.messages.some((m) => m.author === slug)) {
        report.archivedThreads.push({ threadId: plain.id, original: plain });
        comments.delete(plain.id);
        report.threadsDeleted += 1;
        continue;
      }

      const messages = messagesOf(yThread);
      if (!messages) continue;
      for (const m of plain.messages) {
        if (m.author !== slug) continue;
        report.archivedMessages.push({ threadId: plain.id, messageId: m.id, original: m });
        const tomb: CommentMessage = {
          id: m.id,
          author: REMOVED_AUTHOR,
          authorName: REMOVED_AUTHOR_NAME,
          body: REMOVED_BODY,
          mentions: [],
          createdAt: m.createdAt,
          editedAt: now,
          moderation: "banned-author",
        };
        messages.set(m.id, tomb);
        report.messages += 1;
      }
      if (plain.createdBy === slug) {
        yThread.set("createdBy", REMOVED_AUTHOR);
        yThread.set("authorName", REMOVED_AUTHOR_NAME);
        yThread.delete("authorEmail");
      }
    }
  }, "moderation");

  return report;
}

/** Re-create an archived thread (after an appeal). Same ids ⇒ LWW converge. */
export function restoreThread(ydoc: Y.Doc, thread: CommentThread): boolean {
  const comments = commentsYMap(ydoc);
  if (comments.has(thread.id)) return false;
  ydoc.transact(() => {
    const y = new Y.Map<unknown>();
    y.set("id", thread.id);
    y.set("anchor", thread.anchor);
    y.set("resolved", thread.resolved);
    y.set("createdBy", thread.createdBy);
    if (thread.authorName) y.set("authorName", thread.authorName);
    if (thread.authorEmail) y.set("authorEmail", thread.authorEmail);
    y.set("createdAt", thread.createdAt);
    y.set("rootId", thread.rootId);
    const messages = new Y.Map<unknown>();
    for (const m of thread.messages) {
      const { moderation: _drop, ...clean } = m;
      messages.set(m.id, clean);
    }
    y.set("messages", messages);
    for (const [slug, at] of Object.entries(thread.seen ?? {})) {
      y.set(`${SEEN_PREFIX}${slug}`, at);
    }
    for (const [messageId, byEmoji] of Object.entries(thread.reactions ?? {})) {
      for (const [emoji, slugs] of Object.entries(byEmoji)) {
        for (const slug of slugs) y.set(`${REACT_PREFIX}${messageId}|${slug}|${emoji}`, thread.createdAt);
      }
    }
    comments.set(thread.id, y);
  }, "moderation");
  return getThread(ydoc, thread.id) !== null;
}
