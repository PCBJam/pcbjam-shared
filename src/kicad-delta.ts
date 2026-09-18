/**
 * Slot-model change events (ysync 0008) — the delta vocabulary of the canonical
 * `KicadDoc` representation (0007). A `KicadDelta` is what travels between the
 * editor-side adapter and the Y.Doc building blocks (`kicad-y.ts`): full items
 * (uuid + type + parent + Slot body), never decomposed per-type scalars — so the
 * live path writes the same lossless shape the file-seed path produces.
 */

import { z } from "zod";
import {
  args,
  kicadItemSchema,
  scalar,
  slotSchema,
  unquoteAtom,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "./kicad-doc.js";

/** A `KicadItem` carrying its own uuid (the doc stores uuid as the map key). */
export const keyedKicadItemSchema = kicadItemSchema.extend({ uuid: z.string() });
export type KeyedKicadItem = z.infer<typeof keyedKicadItemSchema>;

/**
 * An updated item that also carries the BASELINE body the writer diffed from
 * (ysync 0012 #2). With `base`, the Y write is slot-granular relative to that
 * baseline (`patchNodeFromSlots`): slots the writer did not touch keep a
 * peer's concurrent edit instead of being overwritten by the writer's full
 * re-serialization. Without it, the whole body is diffed against the doc.
 */
export const patchedKicadItemSchema = keyedKicadItemSchema.extend({
  base: z.array(slotSchema).optional(),
});
export type PatchedKicadItem = z.infer<typeof patchedKicadItemSchema>;

export const kicadDeltaSchema = z.object({
  added: z.array(keyedKicadItemSchema),
  updated: z.array(patchedKicadItemSchema),
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

/** Lib ids a doc's placed symbols reference — keyed like KiCad's screen map
 *  (`SCH_SYMBOL::GetSchSymbolLibraryName`: `lib_name` when set, else `lib_id`). */
function referencedLibIds(items: Record<string, KicadItem>): Set<string> {
  const used = new Set<string>();
  for (const item of Object.values(items)) {
    if (item.type !== "symbol") continue;
    const ref = scalar(item.body, "lib_name") ?? scalar(item.body, "lib_id");
    if (ref !== undefined) used.add(unquoteAtom(ref));
  }
  return used;
}

function libDefId(def: Slot): string | undefined {
  if (!("k" in def) || def.k !== "symbol") return undefined;
  const id = args(def.v)[0];
  return id === undefined ? undefined : unquoteAtom(id);
}

/**
 * `compareSlots` for the two document LAYOUTS of a drift check, excusing one
 * known non-drift: ORPHANED `lib_symbols` definitions on the Y.Doc side.
 *
 * `kdoc_libsymbols` is additive by design (a peer's not-yet-applied placement
 * must never lose its definition), while KiCad's screen drops a definition
 * together with its last user (`SCH_SCREEN::Remove`). So after the first
 * delete/swap the Y.Doc legitimately carries a definition the editor save
 * lacks — harmless on materialize (an unused embedded symbol), and reported
 * forever otherwise (field report 2026-09-18, a swapped Si5351B).
 *
 * Deliberately narrow — a definition is dropped from the comparison only when
 * it is absent from the editor save AND no placed symbol in the Y.Doc
 * references it. A referenced definition the save lacks, a definition the
 * Y.Doc lacks, or one whose content differs all stay real drift.
 */
export function compareDriftLayouts(ydocDoc: KicadDoc, wasmDoc: KicadDoc): SlotsRelation {
  const wasmIds = new Set<string>();
  for (const slot of wasmDoc.layout) {
    if (!("k" in slot) || slot.k !== "lib_symbols") continue;
    for (const def of slot.v) {
      const id = libDefId(def);
      if (id !== undefined) wasmIds.add(id);
    }
  }
  const used = referencedLibIds(ydocDoc.items);
  const layout = ydocDoc.layout.map((slot): Slot => {
    if (!("k" in slot) || slot.k !== "lib_symbols") return slot;
    return {
      k: slot.k,
      v: slot.v.filter((def) => {
        const id = libDefId(def);
        return id === undefined || wasmIds.has(id) || used.has(id);
      }),
    };
  });
  return compareSlots(layout, wasmDoc.layout);
}
