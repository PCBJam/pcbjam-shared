/**
 * Slot-model change events (ysync 0008) — the delta vocabulary of the canonical
 * `KicadDoc` representation (0007). A `KicadDelta` is what travels between the
 * editor-side adapter and the Y.Doc building blocks (`kicad-y.ts`): full items
 * (uuid + type + parent + Slot body), never decomposed per-type scalars — so the
 * live path writes the same lossless shape the file-seed path produces.
 */

import { z } from "zod";
import { kicadItemSchema, type KicadDoc, type KicadItem } from "./kicad-doc.js";

/** A `KicadItem` carrying its own uuid (the doc stores uuid as the map key). */
export const keyedKicadItemSchema = kicadItemSchema.extend({ uuid: z.string() });
export type KeyedKicadItem = z.infer<typeof keyedKicadItemSchema>;

export const kicadDeltaSchema = z.object({
  added: z.array(keyedKicadItemSchema),
  updated: z.array(keyedKicadItemSchema),
  /** uuids. */
  removed: z.array(z.string()),
});
export type KicadDelta = z.infer<typeof kicadDeltaSchema>;

export function emptyKicadDelta(): KicadDelta {
  return { added: [], updated: [], removed: [] };
}

export function isEmptyKicadDelta(d: KicadDelta): boolean {
  return d.added.length === 0 && d.updated.length === 0 && d.removed.length === 0;
}

/** Structural item equality (body order is significant, as in the file). */
export function sameKicadItem(a: KicadItem, b: KicadItem): boolean {
  return (
    a.type === b.type &&
    a.parent === b.parent &&
    JSON.stringify(a.body) === JSON.stringify(b.body)
  );
}

/**
 * Pure diff of two docs' ITEM sets → the `KicadDelta` that turns `prev` into
 * `next`. Layout/preamble changes are not covered (they are not items); the
 * file-seed path re-runs `docToY` for those.
 */
export function docDelta(
  prev: Pick<KicadDoc, "items">,
  next: Pick<KicadDoc, "items">,
): KicadDelta {
  const delta = emptyKicadDelta();
  for (const [uuid, item] of Object.entries(next.items)) {
    const old = prev.items[uuid];
    if (!old) delta.added.push({ uuid, ...item });
    else if (!sameKicadItem(old, item)) delta.updated.push({ uuid, ...item });
  }
  for (const uuid of Object.keys(prev.items)) {
    if (!(uuid in next.items)) delta.removed.push(uuid);
  }
  return delta;
}
