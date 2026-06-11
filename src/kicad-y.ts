/**
 * KicadDoc ⇄ Y.Doc building blocks (ysync 0008) — a PURE LIBRARY over yjs.
 *
 * Deliberately NOT transport-aware: nothing here subscribes (`observeDeep`),
 * constructs providers, or owns lifecycle/origin policy. The runtime (the GPL
 * standalone's thin reconciler) does:
 *
 *   const items = kicadItemsMap(ydoc);
 *   items.observeDeep((events, txn) => {
 *     if (txn.origin === MY_ORIGIN) return;            // runtime's echo policy
 *     const delta = deltaFromYEvents(items, events);   // default onChange impl
 *     if (!isEmptyKicadDelta(delta)) applyToEditor(delta);
 *   });
 *
 * Y shape (namespaced `kdoc_*` so it can coexist with the legacy scalar "items"
 * map during migration):
 *
 *   kdoc_meta    Y.Map    { root: string }                      (document form name)
 *   kdoc_items   Y.Map    uuid → Y.Map { type: string, parent: string|null,
 *                                        body: Slot[] (plain JSON value) }
 *   kdoc_layout  Y.Array  Slot[] (plain JSON entries, root form order)
 *
 * Granularity (v1): an item's `body` is ONE plain-JSON value → item-level merge.
 * The flatten step (0007) already gives per-pad / per-field / per-pin granularity
 * because those ARE separate items; deep Y types per slot (field-level merge
 * inside one item) are the later refinement.
 */

import * as Y from "yjs";
import {
  kicadDocSchema,
  kicadItemSchema,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "./kicad-doc.js";
import { emptyKicadDelta, type KicadDelta } from "./kicad-delta.js";

export const Y_KDOC_META = "kdoc_meta";
export const Y_KDOC_ITEMS = "kdoc_items";
export const Y_KDOC_LAYOUT = "kdoc_layout";

export type KicadYItems = Y.Map<Y.Map<unknown>>;

/** The doc's flattened item map (uuid → item Y.Map). */
export function kicadItemsMap(ydoc: Y.Doc): KicadYItems {
  return ydoc.getMap<Y.Map<unknown>>(Y_KDOC_ITEMS);
}

/** Read one item Y.Map back into a validated `KicadItem`. */
export function yToItem(ym: Y.Map<unknown>): KicadItem {
  return kicadItemSchema.parse({
    type: ym.get("type"),
    parent: ym.get("parent") ?? null,
    body: ym.get("body") ?? [],
  });
}

/** Upsert an item into the items map, writing only the keys that changed. */
function upsertYItem(items: KicadYItems, uuid: string, item: KicadItem): void {
  let ym = items.get(uuid);
  if (!ym) {
    ym = new Y.Map<unknown>();
    items.set(uuid, ym);
  }
  if (ym.get("type") !== item.type) ym.set("type", item.type);
  if ((ym.get("parent") ?? null) !== item.parent) ym.set("parent", item.parent);
  // body is one plain-JSON value (item-level merge, see header) — compare to skip no-ops.
  if (JSON.stringify(ym.get("body")) !== JSON.stringify(item.body)) {
    ym.set("body", item.body);
  }
}

/**
 * Seed (or re-seed) a Y.Doc from a `KicadDoc` in one transaction. Removes items
 * absent from `doc`, upserts the rest, replaces layout + meta. Tag `origin` so the
 * runtime's observers can recognize the write as their own.
 */
export function docToY(doc: KicadDoc, ydoc: Y.Doc, origin?: unknown): void {
  kicadDocSchema.parse(doc);
  ydoc.transact(() => {
    ydoc.getMap(Y_KDOC_META).set("root", doc.root);
    const items = kicadItemsMap(ydoc);
    for (const uuid of [...items.keys()]) {
      if (!(uuid in doc.items)) items.delete(uuid);
    }
    for (const [uuid, item] of Object.entries(doc.items)) {
      upsertYItem(items, uuid, item);
    }
    const layout = ydoc.getArray<Slot>(Y_KDOC_LAYOUT);
    layout.delete(0, layout.length);
    layout.insert(0, doc.layout);
  }, origin);
}

/** Read the full `KicadDoc` back out of a Y.Doc (validated). */
export function yToDoc(ydoc: Y.Doc): KicadDoc {
  const root = ydoc.getMap(Y_KDOC_META).get("root");
  const items: Record<string, KicadItem> = {};
  kicadItemsMap(ydoc).forEach((ym, uuid) => {
    items[uuid] = yToItem(ym);
  });
  const layout = ydoc.getArray<Slot>(Y_KDOC_LAYOUT).toArray();
  return kicadDocSchema.parse({ root, items, layout });
}

/**
 * Write a `KicadDelta` into the Y.Doc in one transaction (added/updated upsert,
 * removed delete), tagged with `origin` for the runtime's echo suppression.
 */
export function applyDeltaToY(ydoc: Y.Doc, delta: KicadDelta, origin?: unknown): void {
  ydoc.transact(() => {
    const items = kicadItemsMap(ydoc);
    for (const it of delta.added) upsertYItem(items, it.uuid, it);
    for (const it of delta.updated) upsertYItem(items, it.uuid, it);
    for (const uuid of delta.removed) items.delete(uuid);
  }, origin);
}

/**
 * The DEFAULT onChange implementation: turn the events a runtime's
 * `items.observeDeep` callback received into a `KicadDelta` of full items.
 * Pure — this module never subscribes; origin filtering is the caller's policy.
 */
export function deltaFromYEvents(
  items: KicadYItems,
  events: Array<Y.YEvent<Y.Map<unknown>>>,
): KicadDelta {
  const added = new Set<string>();
  const updated = new Set<string>();
  const removed = new Set<string>();

  for (const ev of events) {
    if (ev.target === items) {
      // Top-level: items added / removed / whole-entry replaced.
      (ev as Y.YMapEvent<Y.Map<unknown>>).changes.keys.forEach((change, uuid) => {
        if (change.action === "delete") {
          removed.add(uuid);
          added.delete(uuid);
          updated.delete(uuid);
        } else if (change.action === "add") {
          added.add(uuid);
        } else {
          updated.add(uuid);
        }
      });
    } else {
      // A key changed on one item's Y.Map; relative to `items` its path is [uuid].
      const uuid = ev.path[ev.path.length - 1];
      if (typeof uuid === "string" && !added.has(uuid)) updated.add(uuid);
    }
  }

  const delta = emptyKicadDelta();
  for (const uuid of added) {
    const ym = items.get(uuid);
    if (ym) delta.added.push({ uuid, ...yToItem(ym) });
  }
  for (const uuid of updated) {
    if (removed.has(uuid)) continue;
    const ym = items.get(uuid);
    if (ym) delta.updated.push({ uuid, ...yToItem(ym) });
  }
  delta.removed.push(...removed);
  return delta;
}
