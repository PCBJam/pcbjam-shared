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

export const commentMessageSchema = z.object({
  id: z.string().min(1),
  /** Author's user slug (pre-auth identity, same as presence). */
  author: z.string().min(1),
  /** Plain text (v1 — no rich text / mentions). */
  body: z.string(),
  /** ms epoch, client clock — ordering + display only. */
  createdAt: z.number(),
  editedAt: z.number().optional(),
});

export const commentThreadSchema = z.object({
  id: z.string().min(1),
  anchor: commentAnchorSchema,
  resolved: z.boolean(),
  createdBy: z.string().min(1),
  createdAt: z.number(),
  /** The opening message's id — deleting it deletes the whole thread. */
  rootId: z.string().min(1),
  /** Ordered by (createdAt, id); index 0 is the root message. */
  messages: z.array(commentMessageSchema),
});

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CommentMessage = z.infer<typeof commentMessageSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
