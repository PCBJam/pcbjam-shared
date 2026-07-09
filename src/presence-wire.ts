import { z } from "zod";

/**
 * Presence wire shape (collab-presence 0001): the Yjs AWARENESS state each
 * client publishes into its document room. Ephemeral by design — awareness
 * entries live only while the client is connected (peers expire them ~30s
 * after silence) and are never persisted; nothing here ever reaches the
 * `.kicad_*` files or the stored Y.Doc.
 *
 * Transport-unaware on purpose (ysync 0008 rule): this module defines the
 * shape + pure helpers only. Publishing/subscribing lives in the GPL editor
 * (`standalone/src/wasm/collab/presence.ts`).
 */

export const presenceUserSchema = z.object({
  /** Stable user identity — the pre-auth user slug (see USER_HEADER). */
  id: z.string().min(1),
  /** Display name; the slug verbatim until real profiles exist. */
  name: z.string().min(1),
  /** Presence color (hex), deterministic via `colorForUser`. */
  color: z.string().min(1),
});

export const presenceStateSchema = z.object({
  user: presenceUserSchema,
  /** The editor tool this client runs (pcbnew / eeschema / pl_editor). */
  tool: z.string().min(1),
  /**
   * eeschema only: project-relative path of the sheet the user is actively
   * editing. Rooms are per-sheet, but the warm pool keeps clients connected
   * to rooms they are not looking at — this marks the one they are.
   */
  sheetPath: z.string().optional(),
  /** Pointer position in world coordinates (KiCad internal units, nm);
   *  null = pointer not on the canvas. Published by 0002. */
  cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  /** KIID strings of the client's current selection. Published by 0002. */
  selection: z.array(z.string()),
  /**
   * pcbnew only (0006): for each selected footprint, its schematic link —
   * the `FOOTPRINT::GetPath()` KIID_PATH string (`/<sheetUuid>/…/<symbolUuid>`).
   * Lets an eeschema peer highlight the corresponding symbols. Optional so
   * states from older builds (and eeschema, which never sets it) validate.
   */
  selectionPaths: z.array(z.string()).optional(),
  /**
   * Follow-user (0008): the visible world RECT — center + half-extents in
   * KiCad IU. Deliberately NOT the zoom: px-per-IU is window-size dependent,
   * so a follower fits this rect with its OWN canvas size ("contain") and
   * different monitors still see the same world region. Optional so states
   * from older builds (and canvas-less tools) validate; null while the
   * viewport is unknown.
   */
  viewport: z
    .object({
      cx: z.number(),
      cy: z.number(),
      halfW: z.number().positive(),
      halfH: z.number().positive(),
    })
    .nullable()
    .optional(),
  /** ms epoch of the last field change (display-only, e.g. stale fadeout). */
  updatedAt: z.number(),
});

export type PresenceUser = z.infer<typeof presenceUserSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
/** The follow-user (0008) world rect: NonNullable of the wire's viewport. */
export type PresenceViewport = NonNullable<PresenceState["viewport"]>;

/**
 * Fixed presence palette — distinguishable hues that hold up as small avatar
 * chips and as GAL overlay strokes on both the light canvas and dark chrome.
 * Comment pins (0005) reuse it via `colorForUser(thread.createdBy)`.
 */
export const PRESENCE_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#84cc16", // lime
  "#f59e0b", // amber
] as const;

/**
 * Deterministic user → color (FNV-1a over the slug). Every client computes the
 * same color for the same user with zero coordination; collisions between
 * different users are acceptable (palette of 12).
 */
/**
 * The schematic symbol uuid a footprint's `GetPath()` string points at — the
 * KIID_PATH's last segment (`/<sheetUuid>/…/<symbolUuid>` → `<symbolUuid>`).
 * Cross-app selection (0006) derives eeschema highlight targets from pcbnew
 * peers' `selectionPaths` with this. Returns null for empty/degenerate paths.
 */
export function symbolUuidFromFootprintPath(path: string): string | null {
  const last = path.split("/").filter(Boolean).pop();
  return last ?? null;
}

export function colorForUser(slug: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // The modulo is always in range; the assertion covers noUncheckedIndexedAccess.
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}
