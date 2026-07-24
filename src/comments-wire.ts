import { z } from "zod";

/**
 * Comment data shapes (collab-presence 0004): figma-like threads pinned to the
 * canvas, stored in the per-file Y.Doc under `Y_KDOC_COMMENTS` — a SIBLING of
 * the kicad content keys, never part of them. `docToFile`/`yToDoc` read only
 * the keys they own, so comments can never leak into materialized `.kicad_*`
 * bytes; persistence rides the existing room snapshot (R2 `.ydoc`) for free.
 *
 * A thread IS a pin (figma model): replies live inside the thread, threads are
 * the only grouping unit. Granularity mirrors the Slot model: whole-message
 * LWW (messages keyed by id in a Y.Map — concurrent edits of one message
 * last-write-win, different messages merge), thread metadata fields are
 * independent Y.Map keys so a `resolved` toggle never conflicts with a reply.
 */

/** Y.Doc top-level key holding the comments map (threadId → thread Y.Map). */
export const Y_KDOC_COMMENTS = "kdoc_comments";

export const commentAnchorSchema = z.object({
  /**
   * KIID of the anchor item, when the comment was pinned to one. The pin then
   * TRACKS the item (its position is re-read from the item's `kdoc_items`
   * slot body on every change); `pos` is the fallback when the item is gone.
   */
  itemUuid: z.string().optional(),
  /** Absolute world position (editor IU) captured at creation — the resting
   *  place for item-less pins and the fallback for detached ones. */
  pos: z.object({ x: z.number(), y: z.number() }),
  /** Pin position relative to the anchor item's origin (IU). */
  offset: z.object({ x: z.number(), y: z.number() }).optional(),
});

/**
 * Author identity, denormalized at write time.
 *
 * `author` stays the IDENTITY key — colors (`colorFor`) and the "is this mine?"
 * ownership checks compare against it, so it must remain the slug and must not
 * be swapped for a display name.
 *
 * `authorName` / `authorEmail` are display-only and OPTIONAL: messages written
 * before this existed carry neither, so every reader must fall back to `author`.
 * They are captured at write time rather than resolved at read time because a
 * comment must still render correctly when its author is offline, has left the
 * team, or was renamed — the document is the record.
 *
 * Consequence to be aware of: this persists emails into the `.ydoc` for anyone
 * who can read the document, and they survive the author leaving the team.
 */
const authorFields = {
  /** Display name at write time. Absent on legacy messages — fall back to `author`. */
  authorName: z.string().optional(),
  /** Email at write time, for the author tooltip. Absent on legacy messages. */
  authorEmail: z.string().optional(),
};

export const commentMessageSchema = z.object({
  id: z.string().min(1),
  /** Author's user slug (pre-auth identity, same as presence). */
  author: z.string().min(1),
  ...authorFields,
  /** Plain text. `@slug` mention tokens stay inline in the text. */
  body: z.string(),
  /**
   * Mentioned user slugs (comments-ux 0001 E), denormalized from the
   * composer's accepted completions at write time — display highlighting and
   * future notification indexing without re-parsing bodies. Optional: legacy
   * messages carry none, and an old client editing a message drops it
   * (display-only, acceptable).
   */
  mentions: z.array(z.string()).optional(),
  /** ms epoch, client clock — ordering + display only. */
  createdAt: z.number(),
  editedAt: z.number().optional(),
});

export const commentThreadSchema = z.object({
  id: z.string().min(1),
  anchor: commentAnchorSchema,
  resolved: z.boolean(),
  /** Thread opener's slug — identity key, same rules as `commentMessage.author`. */
  createdBy: z.string().min(1),
  ...authorFields,
  createdAt: z.number(),
  /** The opening message's id — deleting it deletes the whole thread. */
  rootId: z.string().min(1),
  /** Ordered by (createdAt, id); index 0 is the root message. */
  messages: z.array(commentMessageSchema),
  /**
   * Per-user seen watermarks (comments-ux 0001 C): slug → ms epoch of the
   * newest message that user has seen. Stored as flat `seen:<slug>` keys on
   * the thread Y.Map — each user only ever writes their OWN key, so
   * concurrent updates merge trivially (messages are whole-value LWW and
   * sub-maps have creation races; flat keys have neither problem).
   */
  seen: z.record(z.string(), z.number()).optional(),
  /**
   * Emoji reactions (comments-ux 0001 D), aggregated at read time from flat
   * `react:<messageId>|<slug>|<emoji>` thread keys (own-key-only toggles,
   * same rationale as `seen`): messageId → emoji → reacting slugs.
   * The emoji is a free-form unicode string — the picker is the gatekeeper;
   * wire validation only excludes the `|` separator.
   */
  reactions: z
    .record(z.string(), z.record(z.string(), z.array(z.string())))
    .optional(),
});

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CommentMessage = z.infer<typeof commentMessageSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
