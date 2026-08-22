/**
 * Slot-model change events (ysync 0008) — the delta vocabulary of the canonical
 * `KicadDoc` representation (0007). A `KicadDelta` is what travels between the
 * editor-side adapter and the Y.Doc building blocks (`kicad-y.ts`): full items
 * (uuid + type + parent + Slot body), never decomposed per-type scalars — so the
 * live path writes the same lossless shape the file-seed path produces.
 */

import { z } from "zod";
import {
  kicadItemSchema,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "./kicad-doc.js";

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
    if (!Object.hasOwn(next.items, uuid)) delta.removed.push(uuid);
  }
  return delta;
}

// ── Order-only classification (drift reporting) ──────────────────────────────
//
// Exact slot order is the default because order is part of the lossless KicadDoc
// model. The old oracle sorted every top-level keyed child. That hid authored
// changes to anonymous repeated heads (`(xy A) (xy B)` → `(xy B) (xy A)`).
//
// There is one separately audited exception: KiCad may normalize the order of
// UUID-bearing root/nested items when it writes a model. Those children already
// have durable identity, membership and content checks, so callers comparing two
// writer snapshots may opt into the `item-references` class explicitly. No
// positional atom or anonymous/keyed field is covered by that exception.

/** How two slot lists relate for drift-reporting purposes. */
export type SlotsRelation = "equal" | "reordered" | "different";

export type SlotOrderClass = "item-references";

export interface CompareSlotsOptions {
  /** Writer-normalized order classes that this comparison may ignore. */
  ignoreOrderClasses?: readonly SlotOrderClass[];
}

/**
 * The only order relaxation backed by a real KiCad writer observation: a board
 * reopen moved an independent UUID-bearing track block while all 533 UUID item
 * nodes and every non-item slot remained structurally equal.
 */
export const KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER: Readonly<CompareSlotsOptions> =
  Object.freeze({ ignoreOrderClasses: Object.freeze(["item-references"] as const) });

/**
 * Classify two slot lists as identical, a pure reordering of the same children,
 * or a real difference. See the block comment above for what "reordering" covers.
 */
export function compareSlots(
  a: Slot[],
  b: Slot[],
  options: Readonly<CompareSlotsOptions> = {},
): SlotsRelation {
  if (JSON.stringify(a) === JSON.stringify(b)) return "equal";

  const ignored = new Set(options.ignoreOrderClasses ?? []);
  if (!ignored.has("item-references")) return "different";

  // Only identity-bearing item references may move. Everything else stays in
  // its exact authored order, including repeated anonymous heads and atoms.
  const orderedA = a.filter((slot) => !("item" in slot));
  const orderedB = b.filter((slot) => !("item" in slot));
  if (JSON.stringify(orderedA) !== JSON.stringify(orderedB)) return "different";

  const refsA = a.filter((slot) => "item" in slot).map((slot) => slot.item).sort();
  const refsB = b.filter((slot) => "item" in slot).map((slot) => slot.item).sort();
  return JSON.stringify(refsA) === JSON.stringify(refsB) ? "reordered" : "different";
}

/** `compareSlots` lifted to whole items (type/parent changes are always real). */
export function compareKicadItems(
  a: KicadItem,
  b: KicadItem,
  options: Readonly<CompareSlotsOptions> = {},
): SlotsRelation {
  if (a.type !== b.type || a.parent !== b.parent) return "different";
  return compareSlots(a.body, b.body, options);
}

/** A `KicadDelta` with order-only changes split out of `updated`. */
export const driftDeltaSchema = kicadDeltaSchema.extend({
  /**
   * Items present on both sides that differ only under a caller-selected,
   * audited order class. Reported for visibility but NOT counted as drift.
   * Optional-with-default so reports/blobs written before this existed parse.
   */
  reordered: z.array(keyedKicadItemSchema).default([]),
});
export type DriftDelta = z.infer<typeof driftDeltaSchema>;

/**
 * `docDelta` for drift reporting. Exact item order is the default. A caller may
 * pass an audited exception; only those differences land in `reordered`.
 */
export function driftDocDelta(
  prev: Pick<KicadDoc, "items">,
  next: Pick<KicadDoc, "items">,
  options: Readonly<CompareSlotsOptions> = {},
): DriftDelta {
  const delta: DriftDelta = { ...emptyKicadDelta(), reordered: [] };
  for (const [uuid, item] of Object.entries(next.items)) {
    const old = prev.items[uuid];
    if (!old) {
      delta.added.push({ uuid, ...item });
      continue;
    }
    const rel = compareKicadItems(old, item, options);
    if (rel === "reordered") delta.reordered.push({ uuid, ...item });
    else if (rel === "different") delta.updated.push({ uuid, ...item });
  }
  for (const uuid of Object.keys(prev.items)) {
    if (!Object.hasOwn(next.items, uuid)) delta.removed.push(uuid);
  }
  return delta;
}
