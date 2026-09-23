import { z } from "zod";
import * as Y from "yjs";
import {
  commentAnchorSchema,
  commentProvenanceSchema,
  commentResolutionSchema,
  type CommentMessage,
  type CommentThread,
} from "./comments-wire.js";
import {
  commentTombstones,
  commentTombstonesYMap,
  commentsYMap,
  isTombstonedMessage,
  isTombstonedThread,
  listThreads,
  messageTombstoneKey,
  threadTombstoneKey,
} from "./comments-y.js";

/**
 * `.pcbjam/comments.json` (git-integration 0003, design-comments §7.1, §7.2;
 * C-D6, C-D7): the EXPORT of a project's threads — always in the portable
 * zip, opt-in on commit — and the additive MERGE of such a file back into
 * the project document. The document is authoritative; a file only adds and
 * advances. Emails are stripped on export (C-D7); per-user state (seen,
 * reactions) is never exported or merged.
 */

export const COMMENTS_FILE_PATH = ".pcbjam/comments.json";
export const COMMENTS_FILE_VERSION = 1;

export const commentsFileMessageSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  authorName: z.string().optional(),
  at: z.number(),
  editedAt: z.number().nullable().optional(),
  body: z.string(),
  mentions: z.array(z.string()).optional(),
  moderation: z.enum(["removed", "banned-author"]).optional(),
});
export type CommentsFileMessage = z.infer<typeof commentsFileMessageSchema>;

export const commentsFileThreadSchema = z.object({
  id: z.string().min(1),
  anchor: commentAnchorSchema,
  provenance: commentProvenanceSchema.optional(),
  resolved: z.boolean(),
  resolution: commentResolutionSchema.optional(),
  reopenedAt: z.number().optional(),
  createdBy: z.string().min(1),
  createdByName: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  rootId: z.string().min(1),
  messages: z.array(commentsFileMessageSchema),
});
export type CommentsFileThread = z.infer<typeof commentsFileThreadSchema>;

export const commentsFileSchema = z.object({
  version: z.literal(COMMENTS_FILE_VERSION),
  /** ISO timestamp. */
  exportedAt: z.string(),
  projectId: z.string().optional(),
  threads: z.array(commentsFileThreadSchema),
  tombstones: z.object({ threads: z.array(z.string()), messages: z.array(z.string()) }),
});
export type CommentsFile = z.infer<typeof commentsFileSchema>;

function updatedAtOf(t: CommentThread): number {
  let at = t.createdAt;
  for (const m of t.messages) at = Math.max(at, m.createdAt, m.editedAt ?? 0);
  if (t.resolution) at = Math.max(at, t.resolution.at);
  if (t.reopenedAt) at = Math.max(at, t.reopenedAt);
  return at;
}

function fileMessage(m: CommentMessage): CommentsFileMessage {
  return {
    id: m.id,
    author: m.author,
    ...(m.authorName ? { authorName: m.authorName } : {}),
    at: m.createdAt,
    editedAt: m.editedAt ?? null,
    body: m.body,
    ...(m.mentions?.length ? { mentions: m.mentions } : {}),
    ...(m.moderation ? { moderation: m.moderation } : {}),
  };
}

/** Threads of the project document as the export file — emails stripped, no per-user state. */
export function exportComments(
  ydoc: Y.Doc,
  opts: { projectId?: string; now?: number } = {},
): CommentsFile {
  const threads = listThreads(ydoc).map((t): CommentsFileThread => ({
    id: t.id,
    anchor: t.anchor,
    ...(t.provenance ? { provenance: t.provenance } : {}),
    resolved: t.resolved,
    ...(t.resolution ? { resolution: t.resolution } : {}),
    ...(t.reopenedAt !== undefined ? { reopenedAt: t.reopenedAt } : {}),
    createdBy: t.createdBy,
    ...(t.authorName ? { createdByName: t.authorName } : {}),
    createdAt: t.createdAt,
    updatedAt: updatedAtOf(t),
    rootId: t.rootId,
    messages: t.messages.map(fileMessage),
  }));
  return {
    version: COMMENTS_FILE_VERSION,
    exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    threads,
    tombstones: commentTombstones(ydoc),
  };
}

/** Stable serialization (2-space JSON, trailing newline). */
export function serializeCommentsFile(file: CommentsFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

export function parseCommentsFile(text: string): CommentsFile | null {
  try {
    const parsed = commentsFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface CommentsMergeSummary {
  /** Threads imported whole (unknown ids). */
  threadsImported: number;
  /** Messages added to known threads. */
  messagesAdded: number;
  /** Messages whose later edit won. */
  messagesUpdated: number;
  /** Threads resolved because the file had them resolved. */
  resolved: number;
  /** Threads the file had resolved but a NEWER reopen in the document kept open. */
  reopenKept: number;
  /** Threads / messages deleted because the file tombstoned them. */
  deleted: number;
  /** Threads / messages the file carried but the document had tombstoned. */
  skippedTombstoned: number;
}

function toMessage(m: CommentsFileMessage): CommentMessage {
  return {
    id: m.id,
    author: m.author,
    ...(m.authorName ? { authorName: m.authorName } : {}),
    body: m.body,
    ...(m.mentions?.length ? { mentions: m.mentions } : {}),
    createdAt: m.at,
    ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    ...(m.moderation ? { moderation: m.moderation } : {}),
  };
}

const lastTouch = (m: { editedAt?: number | null; at?: number; createdAt?: number }): number =>
  m.editedAt ?? m.at ?? m.createdAt ?? 0;

/**
 * Merge a comments file into the project document (design-comments §7.2).
 * One transaction. Rules, in order: the file's tombstones delete; an unknown
 * thread is imported whole (`origin: import`) unless the document tombstoned
 * it; a known thread unions messages by id (later `editedAt`/`at` wins);
 * `resolved` — resolved wins, except a document reopen NEWER than the file's
 * `resolution.at` survives (C-N1); the document's anchor is kept; absence
 * in the file is never deletion; per-user state untouched.
 */
export function mergeCommentsFile(ydoc: Y.Doc, file: CommentsFile, now: number = Date.now()): CommentsMergeSummary {
  const summary: CommentsMergeSummary = {
    threadsImported: 0,
    messagesAdded: 0,
    messagesUpdated: 0,
    resolved: 0,
    reopenKept: 0,
    deleted: 0,
    skippedTombstoned: 0,
  };
  const comments = commentsYMap(ydoc);
  const tomb = commentTombstonesYMap(ydoc);

  ydoc.transact(() => {
    // 1. The file's tombstones delete in the document (and are remembered).
    for (const threadId of file.tombstones.threads) {
      if (comments.has(threadId)) {
        comments.delete(threadId);
        summary.deleted += 1;
      }
      if (!tomb.has(threadTombstoneKey(threadId))) tomb.set(threadTombstoneKey(threadId), now);
    }
    const messageTombstones = new Set(file.tombstones.messages);
    if (messageTombstones.size) {
      for (const [threadId, thread] of comments.entries()) {
        if (threadId.startsWith("~") || !(thread instanceof Y.Map)) continue;
        const messages = thread.get("messages");
        if (!(messages instanceof Y.Map)) continue;
        for (const messageId of [...messages.keys()]) {
          if (!messageTombstones.has(messageId)) continue;
          if (thread.get("rootId") === messageId) {
            comments.delete(threadId);
            tomb.set(threadTombstoneKey(threadId), now);
          } else {
            messages.delete(messageId);
            tomb.set(messageTombstoneKey(threadId, messageId), now);
          }
          summary.deleted += 1;
        }
      }
    }

    // 2. Threads.
    const existing = new Map(listThreads(ydoc).map((t) => [t.id, t]));
    for (const ft of file.threads) {
      if (file.tombstones.threads.includes(ft.id)) continue;
      if (isTombstonedThread(ydoc, ft.id)) {
        summary.skippedTombstoned += 1;
        continue;
      }
      const cur = existing.get(ft.id);
      const ythread = comments.get(ft.id);
      if (!cur || !ythread) {
        // Unknown → import whole, minus tombstoned messages and the file's own.
        const thread = new Y.Map<unknown>();
        thread.set("id", ft.id);
        thread.set("anchor", ft.anchor);
        thread.set("resolved", ft.resolved);
        if (ft.resolution) thread.set("resolution", ft.resolution);
        if (ft.reopenedAt !== undefined) thread.set("reopenedAt", ft.reopenedAt);
        if (ft.provenance) thread.set("provenance", ft.provenance);
        thread.set("createdBy", ft.createdBy);
        if (ft.createdByName) thread.set("authorName", ft.createdByName);
        thread.set("createdAt", ft.createdAt);
        thread.set("rootId", ft.rootId);
        thread.set("origin", "import");
        const messages = new Y.Map<unknown>();
        let hasRoot = false;
        for (const fm of ft.messages) {
          if (messageTombstones.has(fm.id) || isTombstonedMessage(ydoc, ft.id, fm.id)) continue;
          // A prelim (not yet integrated) Y.Map answers `has()` false, so
          // track the root ourselves.
          messages.set(fm.id, toMessage(fm));
          if (fm.id === ft.rootId) hasRoot = true;
        }
        if (!hasRoot) continue; // a root-less thread has no pin
        thread.set("messages", messages);
        comments.set(ft.id, thread);
        summary.threadsImported += 1;
        continue;
      }

      // Known → union messages by id.
      const messages = ythread.get("messages");
      if (messages instanceof Y.Map) {
        for (const fm of ft.messages) {
          if (messageTombstones.has(fm.id) || isTombstonedMessage(ydoc, ft.id, fm.id)) {
            summary.skippedTombstoned += 1;
            continue;
          }
          const mine = cur.messages.find((m) => m.id === fm.id);
          if (!mine) {
            messages.set(fm.id, toMessage(fm));
            summary.messagesAdded += 1;
          } else if (lastTouch(fm) > lastTouch(mine)) {
            messages.set(fm.id, { ...mine, body: fm.body, editedAt: fm.editedAt ?? undefined, ...(fm.mentions?.length ? { mentions: fm.mentions } : {}) });
            summary.messagesUpdated += 1;
          }
        }
      }

      // Resolved wins — unless the document reopened AFTER the file resolved.
      if (ft.resolved && !cur.resolved) {
        const fileAt = ft.resolution?.at ?? ft.updatedAt;
        if (cur.reopenedAt !== undefined && cur.reopenedAt > fileAt) {
          summary.reopenKept += 1;
        } else {
          ythread.set("resolved", true);
          ythread.set("resolution", ft.resolution ?? { at: fileAt });
          summary.resolved += 1;
        }
      }
      // Anchor: the document's is kept. Absence in the file: never deletion.
    }
  });

  return summary;
}
