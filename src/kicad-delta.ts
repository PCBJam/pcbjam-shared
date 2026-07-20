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
    if (!(uuid in next.items)) delta.removed.push(uuid);
  }
  return delta;
}

// ── Order-only classification (drift reporting) ──────────────────────────────
//
// `sameKicadItem` is order-sensitive on purpose: slot order IS file content, and
// the LIVE sync path must apply a reorder like any other change. Drift REPORTING
// is a different question — y-sexpr v2 reorders legitimately, so an order-only
// difference is noise, not a defect:
//
//   - `normalizedKeys` (kicad-y2.ts) appends map keys missing from `#attr_order`
//     in sorted key order; `#attr_order` is "a hint, never membership truth"
//     (ysync 0009 §3.4) and legitimately loses entries on resurrections,
//     concurrent inserts and drop-and-recreate.
//   - `docToY` re-emits `lib_symbols` sorted by lib id (kicad-y.ts).
//   - `applyDeltaToY` appends new root items to `kdoc_layout`, so a root item's
//     original file position is not preserved.
//
// Scope of the relaxation, deliberately narrow: only the TOP-LEVEL sequence of an
// item body / doc layout is treated as a multiset. Nested slot content is compared
// verbatim (order-sensitive), so geometry never slips through — `(pts (xy …) (xy …))`
// is a single top-level slot whose internal `xy` order is part of its canonical
// string. Leading positional atoms (`(pad "1" smd roundrect …)`) also stay ordered.

/** How two slot lists relate for drift-reporting purposes. */
export type SlotsRelation = "equal" | "reordered" | "different";

function isAtom(slot: Slot): slot is { atom: string } {
  return "atom" in slot;
}

/**
 * Classify two slot lists as identical, a pure reordering of the same children,
 * or a real difference. See the block comment above for what "reordering" covers.
 */
export function compareSlots(a: Slot[], b: Slot[]): SlotsRelation {
  if (JSON.stringify(a) === JSON.stringify(b)) return "equal";

  // Positional atoms carry meaning by position — never treat those as a multiset.
  const atomsA = a.filter(isAtom).map((s) => s.atom);
  const atomsB = b.filter(isAtom).map((s) => s.atom);
  if (JSON.stringify(atomsA) !== JSON.stringify(atomsB)) return "different";

  const restA = a.filter((s) => !isAtom(s)).map((s) => JSON.stringify(s)).sort();
  const restB = b.filter((s) => !isAtom(s)).map((s) => JSON.stringify(s)).sort();
  return JSON.stringify(restA) === JSON.stringify(restB) ? "reordered" : "different";
}

/** `compareSlots` lifted to whole items (type/parent changes are always real). */
export function compareKicadItems(a: KicadItem, b: KicadItem): SlotsRelation {
  if (a.type !== b.type || a.parent !== b.parent) return "different";
  return compareSlots(a.body, b.body);
}

/** A `KicadDelta` with order-only changes split out of `updated`. */
export const driftDeltaSchema = kicadDeltaSchema.extend({
  /**
   * Items present on both sides whose children are the same multiset in a
   * different order. Reported for visibility but NOT counted as drift.
   * Optional-with-default so reports/blobs written before this existed parse.
   */
  reordered: z.array(keyedKicadItemSchema).default([]),
});
export type DriftDelta = z.infer<typeof driftDeltaSchema>;

/**
 * `docDelta` for drift reporting: items that differ only in child ORDER land in
 * `reordered` instead of `updated`, so they neither trigger a report nor count.
 */
export function driftDocDelta(
  prev: Pick<KicadDoc, "items">,
  next: Pick<KicadDoc, "items">,
): DriftDelta {
  const delta: DriftDelta = { ...emptyKicadDelta(), reordered: [] };
  for (const [uuid, item] of Object.entries(next.items)) {
    const old = prev.items[uuid];
    if (!old) {
      delta.added.push({ uuid, ...item });
      continue;
    }
    const rel = compareKicadItems(old, item);
    if (rel === "reordered") delta.reordered.push({ uuid, ...item });
    else if (rel === "different") delta.updated.push({ uuid, ...item });
  }
  for (const uuid of Object.keys(prev.items)) {
    if (!(uuid in next.items)) delta.removed.push(uuid);
  }
  return delta;
}
