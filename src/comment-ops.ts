import { z } from "zod";
import * as Y from "yjs";
import { commentAnchorSchema, type CommentThread } from "./comments-wire.js";
import {
  addMessage,
  commentsYMap,
  createThread,
  editMessage,
  getThread,
  listThreads,
  markThreadSeen,
  removeMessage,
  setThreadAnchor,
  setThreadResolved,
  toggleReaction,
} from "./comments-y.js";

/**
 * Comment ops (comments-ux 0003 §4): the wire shape a COMMENTER session uses
 * to write comments. Commenters hold read-only sync sockets (their Yjs
 * frames are dropped server-side), so their writes travel as one op each
 * over `POST …/files/<path>/comments`; the backend authorizes and stamps the
 * author, then the room applies the op to its live doc with
 * {@link applyCommentOp}, and the result reaches the commenter as a normal
 * downstream update. Editors keep writing comments straight into the ydoc.
 *
 * Shape only lives here (plus the pure doc-rule evaluator, so the room and
 * its tests share one implementation); authorization, rate limits and
 * transport stay in the closed application layer.
 */

export const COMMENT_BODY_MAX = 4000;
export const COMMENT_MENTIONS_MAX = 10;
/** Open-thread cap per commenter per document (amplification bound). */
export const COMMENTER_THREAD_CAP = 200;
/** Transaction origin the room applies ops under (server-authored). */
export const COMMENT_OP_ORIGIN = "comment-op";

/** Thread/message ids: nanoid / uuid / the legacy `c-…` shape. */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const bodySchema = z.string().min(1).max(COMMENT_BODY_MAX);
const mentionsSchema = z
  .array(z.string().min(1).max(64))
  .max(COMMENT_MENTIONS_MAX)
  .optional();
/** Same loose rule as 0001-D: bounded, no key separator, no control chars. */
const emojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((e) => !e.includes("|") && !/[\u0000-\u001f]/.test(e), "bad emoji");

export const commentOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createThread"),
    anchor: commentAnchorSchema,
    body: bodySchema,
    mentions: mentionsSchema,
    /** Client-chosen id so the echo can be correlated; must be unused. */
    id: idSchema.optional(),
  }),
  z.object({
    type: z.literal("addMessage"),
    threadId: idSchema,
    body: bodySchema,
    mentions: mentionsSchema,
    id: idSchema.optional(),
  }),
  z.object({
    type: z.literal("editMessage"),
    threadId: idSchema,
    messageId: idSchema,
    body: bodySchema,
    mentions: mentionsSchema,
  }),
  z.object({ type: z.literal("removeMessage"), threadId: idSchema, messageId: idSchema }),
  z.object({ type: z.literal("setResolved"), threadId: idSchema, resolved: z.boolean() }),
  z.object({ type: z.literal("setAnchor"), threadId: idSchema, anchor: commentAnchorSchema }),
  z.object({ type: z.literal("markSeen"), threadId: idSchema, upTo: z.number().finite().optional() }),
  z.object({
    type: z.literal("toggleReaction"),
    threadId: idSchema,
    messageId: idSchema,
    emoji: emojiSchema,
  }),
]);
export type CommentOp = z.infer<typeof commentOpSchema>;

/** Request body of the comment-op route. */
export const commentOpRequestSchema = z.object({ op: commentOpSchema });
export type CommentOpRequest = z.infer<typeof commentOpRequestSchema>;

/**
 * Who is applying the op, as the backend resolved it. `commenter` gets the
 * own-only doc rules; `editor` skips them (they could rewrite the whole doc
 * anyway); `moderator` is the admin path of the moderation phase.
 */
export const commentActorSchema = z.object({
  slug: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
  role: z.enum(["commenter", "editor", "moderator"]),
});
export type CommentActor = z.infer<typeof commentActorSchema>;

/** What the app server hands the document's room (`/room/comment-op`). */
export const commentOpPayloadSchema = z.object({
  op: commentOpSchema,
  actor: commentActorSchema,
  /** Server clock at the request — stamps createdAt/editedAt. */
  now: z.number().finite(),
});
export type CommentOpPayload = z.infer<typeof commentOpPayloadSchema>;

export const commentOpRejectCodeSchema = z.enum([
  "thread-missing",
  "message-missing",
  "not-own",
  "root-has-replies",
  "thread-cap",
  "id-taken",
]);
export type CommentOpRejectCode = z.infer<typeof commentOpRejectCodeSchema>;

export const commentOpResultSchema = z.object({
  applied: z.literal(true),
  threadId: z.string(),
  messageId: z.string().optional(),
});
export type CommentOpResult = z.infer<typeof commentOpResultSchema>;

export type CommentOpOutcome =
  | { ok: true; threadId: string; messageId?: string }
  | { ok: false; code: CommentOpRejectCode };

/**
 * `POST` target for a project's comment ops (git-integration 0001): the
 * project comments document takes every op; a `createThread` op must carry
 * `anchor.filePath`, which the backend checks against the project's files.
 */
export function projectCommentOpsUrl(scope: string, project: string): string {
  return `/api/scopes/${encodeURIComponent(scope)}/projects/${encodeURIComponent(project)}/comments`;
}

/**
 * Legacy per-document `POST` target (per-segment encoded path). Since
 * git-integration 0001 the backend treats it as {@link projectCommentOpsUrl}
 * with `anchor.filePath` taken from the URL; kept for older editor builds.
 */
export function commentOpsUrl(scope: string, project: string, filePath: string): string {
  const enc = filePath
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return `/api/scopes/${encodeURIComponent(scope)}/projects/${encodeURIComponent(project)}/files/${enc}/comments`;
}

function ownThread(thread: CommentThread, actor: CommentActor): boolean {
  return actor.role !== "commenter" || thread.createdBy === actor.slug;
}

function setMessageMentions(
  ydoc: Y.Doc,
  threadId: string,
  messageId: string,
  mentions: string[],
): void {
  const thread = commentsYMap(ydoc).get(threadId);
  const messages = thread?.get("messages");
  if (!(messages instanceof Y.Map)) return;
  const msg = messages.get(messageId);
  if (!msg || typeof msg !== "object") return;
  messages.set(messageId, { ...(msg as Record<string, unknown>), mentions });
}

/**
 * Apply one op to the doc under the actor's doc rules. Pure Y mutation (one
 * transaction, origin {@link COMMENT_OP_ORIGIN}); the caller has already
 * authorized the actor, validated content policy and stamped identity.
 *
 * Commenter rules: edit/remove only own messages (the root only when every
 * other message is theirs too — removing a root deletes the thread with its
 * replies); resolve/re-anchor only own threads; seen/reactions always (own
 * flat keys); at most {@link COMMENTER_THREAD_CAP} own threads per doc.
 */
export function applyCommentOp(
  ydoc: Y.Doc,
  op: CommentOp,
  actor: CommentActor,
  now: number = Date.now(),
): CommentOpOutcome {
  let outcome: CommentOpOutcome = { ok: false, code: "thread-missing" };
  const stamp = { author: actor.slug, authorName: actor.name, authorEmail: actor.email };

  ydoc.transact(() => {
    switch (op.type) {
      case "createThread": {
        if (op.id && commentsYMap(ydoc).has(op.id)) {
          outcome = { ok: false, code: "id-taken" };
          return;
        }
        if (
          actor.role === "commenter" &&
          listThreads(ydoc).filter((t) => t.createdBy === actor.slug).length >= COMMENTER_THREAD_CAP
        ) {
          outcome = { ok: false, code: "thread-cap" };
          return;
        }
        const threadId = createThread(ydoc, {
          anchor: op.anchor,
          ...stamp,
          body: op.body,
          mentions: op.mentions,
          id: op.id,
          now,
        });
        const thread = getThread(ydoc, threadId);
        outcome = { ok: true, threadId, messageId: thread?.rootId };
        return;
      }
      case "addMessage": {
        const thread = getThread(ydoc, op.threadId);
        if (!thread) return;
        if (op.id && thread.messages.some((m) => m.id === op.id)) {
          outcome = { ok: false, code: "id-taken" };
          return;
        }
        const messageId = addMessage(ydoc, op.threadId, {
          ...stamp,
          body: op.body,
          mentions: op.mentions,
          id: op.id,
          now,
        });
        if (messageId === null) return;
        outcome = { ok: true, threadId: op.threadId, messageId };
        return;
      }
      case "editMessage": {
        const thread = getThread(ydoc, op.threadId);
        if (!thread) return;
        const msg = thread.messages.find((m) => m.id === op.messageId);
        if (!msg) {
          outcome = { ok: false, code: "message-missing" };
          return;
        }
        // Tombstones (moderation) are inert below the moderator role.
        if (msg.moderation && actor.role !== "moderator") {
          outcome = { ok: false, code: "not-own" };
          return;
        }
        if (actor.role === "commenter" && msg.author !== actor.slug) {
          outcome = { ok: false, code: "not-own" };
          return;
        }
        if (!editMessage(ydoc, op.threadId, op.messageId, op.body, now)) {
          outcome = { ok: false, code: "message-missing" };
          return;
        }
        if (op.mentions) setMessageMentions(ydoc, op.threadId, op.messageId, op.mentions);
        outcome = { ok: true, threadId: op.threadId, messageId: op.messageId };
        return;
      }
      case "removeMessage": {
        const thread = getThread(ydoc, op.threadId);
        if (!thread) return;
        const msg = thread.messages.find((m) => m.id === op.messageId);
        if (!msg) {
          outcome = { ok: false, code: "message-missing" };
          return;
        }
        if (actor.role === "commenter") {
          if (msg.author !== actor.slug) {
            outcome = { ok: false, code: "not-own" };
            return;
          }
          const isRoot = op.messageId === thread.rootId;
          if (isRoot && thread.messages.some((m) => m.author !== actor.slug)) {
            outcome = { ok: false, code: "root-has-replies" };
            return;
          }
        }
        if (!removeMessage(ydoc, op.threadId, op.messageId)) {
          outcome = { ok: false, code: "message-missing" };
          return;
        }
        outcome = { ok: true, threadId: op.threadId, messageId: op.messageId };
        return;
      }
      case "setResolved":
      case "setAnchor": {
        const thread = getThread(ydoc, op.threadId);
        if (!thread) return;
        if (!ownThread(thread, actor)) {
          outcome = { ok: false, code: "not-own" };
          return;
        }
        const ok =
          op.type === "setResolved"
            ? setThreadResolved(ydoc, op.threadId, op.resolved, undefined, now)
            : setThreadAnchor(ydoc, op.threadId, op.anchor);
        if (ok) outcome = { ok: true, threadId: op.threadId };
        return;
      }
      case "markSeen": {
        if (!markThreadSeen(ydoc, op.threadId, actor.slug, op.upTo)) return;
        outcome = { ok: true, threadId: op.threadId };
        return;
      }
      case "toggleReaction": {
        const thread = getThread(ydoc, op.threadId);
        if (!thread) return;
        if (!thread.messages.some((m) => m.id === op.messageId)) {
          outcome = { ok: false, code: "message-missing" };
          return;
        }
        if (!toggleReaction(ydoc, op.threadId, op.messageId, actor.slug, op.emoji)) {
          outcome = { ok: false, code: "message-missing" };
          return;
        }
        outcome = { ok: true, threadId: op.threadId, messageId: op.messageId };
        return;
      }
    }
  }, COMMENT_OP_ORIGIN);

  return outcome;
}
