/**
 * The v2 ("items") wasm bridge wire — per-item s-expr (ysync 0008 Stage B/C).
 *
 * Where the legacy wire (`collab-wire.ts`) carries hand-mapped decomposed scalars,
 * the items wire carries each changed item's FULL native s-expr plus the uuid of
 * its enclosing item — the same lossless unit the `KicadDoc` Slot model stores.
 * C++ side (Stage C): `kicadCollabSnapshotItems()` / `kicadCollabApplyItems(json)`
 * / `window.kicadCollab.onItems(json)`.
 *
 * This module is the pure conversion layer between that wire and the Slot-model
 * `KicadDelta`:
 *
 *   editor → Y:  itemsWireToDelta(wire, current)  — re-flattens each wire sexpr
 *                into its item subtree, computes adds/updates against `current`,
 *                removes subtree members that vanished from a changed item, and
 *                cascades `removed` roots over their descendants.
 *   Y → editor:  deltaToItemsWire(delta, view)    — renders each added/updated
 *                item back to its full s-expr (descendants resolved from `view`),
 *                pruning items whose ancestor is itself in the delta (the
 *                ancestor's sexpr already embeds them).
 */

import { z } from "zod";
import { renderItem, sexprToItems, type KicadItem } from "./kicad-doc.js";
import {
  emptyKicadDelta,
  sameKicadItem,
  type KeyedKicadItem,
  type KicadDelta,
} from "./kicad-delta.js";
import { directUuid, parseSexpr, printSexpr, type SNode } from "./sexpr.js";

export const wireItemSchema = z.object({
  /** The item's full native s-expr fragment (subtree included). */
  sexpr: z.string(),
  /** uuid of the enclosing item; null/omitted for a document-root item. */
  parent: z.string().nullable().default(null),
});
export type WireItem = z.infer<typeof wireItemSchema>;

export const itemsWireDeltaSchema = z.object({
  added: z.array(wireItemSchema).default([]),
  changed: z.array(wireItemSchema).default([]),
  /** uuids; removal cascades over descendants on conversion. */
  removed: z.array(z.string()).default([]),
});
export type ItemsWireDelta = z.infer<typeof itemsWireDeltaSchema>;

/** Parse a bridge items-wire JSON string; throws on malformed input. */
export function parseItemsWireDelta(json: string): ItemsWireDelta {
  return itemsWireDeltaSchema.parse(JSON.parse(json));
}

export function emptyItemsWireDelta(): ItemsWireDelta {
  return { added: [], changed: [], removed: [] };
}

export function isEmptyItemsWireDelta(d: ItemsWireDelta): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

/** All uuids whose parent chain reaches `root` (excluding `root` itself). */
export function descendants(
  items: Record<string, KicadItem>,
  root: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const [uuid, item] of Object.entries(items)) {
    if (item.parent !== null) {
      const list = children.get(item.parent) ?? [];
      list.push(uuid);
      children.set(item.parent, list);
    }
  }
  const out: string[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const uuid = stack.pop()!;
    out.push(uuid);
    stack.push(...(children.get(uuid) ?? []));
  }
  return out;
}

/**
 * Unwrap a wire `sexpr` payload to its single uuid-bearing item form. Tools emit
 * their NATIVE blob shapes, all of which this tolerates:
 *   - a bare item:                `(footprint … (uuid X) …)`, `(wire … (uuid X))`
 *   - an envelope whose children include the item:
 *     `(kicad_wks (version …) (tbtext (uuid X) …))`,
 *     `(kicad_pcb (version …) (layers …) (segment … (uuid X)))`
 *   - multi-form clipboard text:  `(lib_symbols …) (symbol … (uuid X) …)`
 * Exactly one uuid-bearing candidate is required; envelope furniture (version,
 * generator, layers, lib_symbols) is sender context, not document content.
 */
export function unwrapWireItem(text: string): string {
  const forms = parseSexpr(text);
  const candidates: SNode[] = [];

  for (const form of forms) {
    if (!Array.isArray(form)) continue;
    if (directUuid(form) !== null) {
      candidates.push(form);
      continue;
    }
    for (const child of form) {
      if (Array.isArray(child) && directUuid(child) !== null) candidates.push(child);
    }
  }

  if (candidates.length !== 1) {
    throw new Error(
      `unwrapWireItem: expected exactly 1 uuid-bearing item form, found ${candidates.length}`,
    );
  }
  return printSexpr(candidates[0]!);
}

/**
 * Convert a bridge items-wire delta into a `KicadDelta` against the `current`
 * item set (typically the Y.Doc's items). Pure; exact subtree reconciliation:
 * a changed footprint whose pad disappeared yields `removed: [that pad]`.
 */
export function itemsWireToDelta(
  wire: ItemsWireDelta,
  current: Record<string, KicadItem>,
): KicadDelta {
  const delta = emptyKicadDelta();

  const upsert = (w: WireItem): void => {
    const { uuid, items } = sexprToItems(unwrapWireItem(w.sexpr), w.parent);
    // Previous subtree members (known to `current`) that the new flatten no
    // longer contains have been deleted inside this item.
    const stale = new Set(
      [uuid, ...descendants(current, uuid)].filter((id) => id in current),
    );
    for (const [id, item] of Object.entries(items)) {
      const old = current[id];
      if (!old) delta.added.push({ uuid: id, ...item });
      else if (!sameKicadItem(old, item)) delta.updated.push({ uuid: id, ...item });
      stale.delete(id);
    }
    delta.removed.push(...stale);
  };

  for (const w of wire.added) upsert(w);
  for (const w of wire.changed) upsert(w);
  for (const id of wire.removed) {
    delta.removed.push(id, ...descendants(current, id));
  }
  return delta;
}

/**
 * Render a `KicadDelta` into the items wire for the editor. `view` must contain
 * the delta's items AND their descendants (e.g. the post-apply Y items read back)
 * so each sexpr embeds its full subtree. Items whose ancestor is itself in the
 * delta are pruned — the ancestor's sexpr already carries them.
 */
export function deltaToItemsWire(
  delta: KicadDelta,
  view: Record<string, KicadItem>,
): ItemsWireDelta {
  const inDelta = new Set(
    [...delta.added, ...delta.updated].map((it) => it.uuid),
  );

  const coveredByAncestor = (it: KeyedKicadItem): boolean => {
    let parent = it.parent;
    while (parent !== null) {
      if (inDelta.has(parent)) return true;
      parent = view[parent]?.parent ?? null;
    }
    return false;
  };

  const toWire = (it: KeyedKicadItem): WireItem => ({
    sexpr: renderItem({ items: view }, it.uuid),
    parent: it.parent,
  });

  return {
    added: delta.added.filter((it) => !coveredByAncestor(it)).map(toWire),
    changed: delta.updated.filter((it) => !coveredByAncestor(it)).map(toWire),
    removed: delta.removed,
  };
}
