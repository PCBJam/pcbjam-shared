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
/** kdoc_meta key holding the winning seeder's nonce (see `seedDocToY`). */
export const Y_KDOC_SEED_NONCE = "seedNonce";

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

/**
 * Seed a Y.Doc from a `KicadDoc` with DOUBLE-SEED ARBITRATION (bug 06). The
 * seed-vs-adopt decision is a client-side check-then-act, so two clients opening
 * the same fresh room can both observe "empty" and both seed. `kdoc_meta` and
 * `kdoc_items` converge per key (Y.Map LWW), but `kdoc_layout` is a Y.Array:
 * both insert sequences survive the merge and every root renders twice, forever.
 *
 * This writes `nonce` into `kdoc_meta.seedNonce` in the same transaction as the
 * seed and returns a RETRACTOR that surgically deletes exactly the layout slots
 * this seed inserted (identified by insertion id — this client, this clock
 * window — so slots appended by later edits are untouched). The runtime watches
 * `seedNonce`: when the merged value is a FOREIGN nonce, this client's seed lost
 * the LWW race and it calls the retractor; the winner's sequence remains as the
 * single clean layout.
 */
export function seedDocToY(
  doc: KicadDoc,
  ydoc: Y.Doc,
  origin: unknown,
  nonce: string,
): () => void {
  const clientId = ydoc.clientID;
  const before = Y.getState(ydoc.store, clientId);
  ydoc.transact(() => {
    docToY(doc, ydoc, origin);
    ydoc.getMap(Y_KDOC_META).set(Y_KDOC_SEED_NONCE, nonce);
  }, origin);
  const after = Y.getState(ydoc.store, clientId);

  return () => {
    const layout = ydoc.getArray<Slot>(Y_KDOC_LAYOUT);
    // Walk the Y.Array's item chain to find OUR seed's inserts by insertion id.
    // (Internal yjs structures — Item.id/.deleted/.countable — are stable across
    // the pinned yjs major and covered by the double-seed regression tests.)
    interface YItemNode {
      id: { client: number; clock: number };
      length: number;
      deleted: boolean;
      countable: boolean;
      right: YItemNode | null;
    }
    ydoc.transact(() => {
      const ranges: Array<[number, number]> = [];
      let idx = 0;
      let node = (layout as unknown as { _start: YItemNode | null })._start;
      for (; node; node = node.right) {
        if (node.deleted || !node.countable) continue;
        if (
          node.id.client === clientId &&
          node.id.clock >= before &&
          node.id.clock < after
        ) {
          ranges.push([idx, node.length]);
        }
        idx += node.length;
      }
      for (const [start, len] of ranges.reverse()) layout.delete(start, len);
    }, origin);
  };
}

/**
 * Whether a Y.Doc has been seeded with document state at all. `docToY` always
 * writes `kdoc_meta.root` and `kdoc_layout`, so a seeded doc is detectable even
 * when it has NO uuid items — which is the case for drawing sheets
 * (`.kicad_wks`, pl_editor) and any file whose elements carry no `(uuid …)`.
 * Callers must use THIS (not `kicadItemsMap(doc).size`) to tell an empty room
 * from a populated one, or such docs look empty and never get adopted.
 */
export function ydocHasState(ydoc: Y.Doc): boolean {
  return (
    kicadItemsMap(ydoc).size > 0 ||
    ydoc.getArray<Slot>(Y_KDOC_LAYOUT).length > 0 ||
    ydoc.getMap(Y_KDOC_META).get("root") !== undefined
  );
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
 * Rebuild a `KicadDoc` directly from a persisted Yjs state update (the bytes
 * `Y.encodeStateAsUpdate` produces — what the sync server stores in the `.ydoc`
 * blob or returns for a live room). Lets a backend materialize a file from a
 * stored room without importing `yjs` itself (the Y.Doc is constructed and
 * discarded here). Pair with `docToFile` to get the KiCad s-expr.
 */
export function ydocUpdateToKicadDoc(update: Uint8Array): KicadDoc {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return yToDoc(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Deep-remove every `{item: uuid}` slot from a body (slots recurse through
 * `(k …)` children). Returns the pruned copy, or null when nothing referenced
 * the uuid (so callers can skip a no-op Y write).
 */
function pruneItemRefs(slots: Slot[], uuid: string): Slot[] | null {
  let changed = false;
  const walk = (list: Slot[]): Slot[] =>
    list
      .filter((s) => {
        const drop = typeof s === "object" && "item" in s && s.item === uuid;
        if (drop) changed = true;
        return !drop;
      })
      .map((s) => {
        if (typeof s === "object" && "k" in s) {
          const v = walk(s.v);
          return v === s.v ? s : { k: s.k, v };
        }
        return s;
      });
  const out = walk(slots);
  return changed ? out : null;
}

/**
 * Write a `KicadDelta` into the Y.Doc in one transaction (added/updated upsert,
 * removed delete), tagged with `origin` for the runtime's echo suppression.
 *
 * `kdoc_layout` is the document root's "body" and is kept in step here for ROOT
 * items (children are covered by their parent's body re-emit): new parent-null
 * items get an `{ item: uuid }` slot appended (file position is lost — appended
 * at the end — which is structurally equivalent), and removed uuids have their
 * slots dropped (a stale reference makes `docToFile` throw). Without this,
 * live-edited docs stop being materializable — the "file recoverable from the
 * Y.Doc alone" invariant (ysync 0005) would only hold for the seeded state.
 */
export function applyDeltaToY(ydoc: Y.Doc, delta: KicadDelta, origin?: unknown): void {
  ydoc.transact(() => {
    const items = kicadItemsMap(ydoc);
    for (const it of delta.added) upsertYItem(items, it.uuid, it);
    for (const it of delta.updated) upsertYItem(items, it.uuid, it);
    for (const uuid of delta.removed) {
      // Before deleting a CHILD item, prune its `{item: uuid}` slot from the
      // surviving parent's body — a dangling reference makes renderItem/docToFile
      // throw, poisoning the room's materialization until the parent is next
      // re-emitted wholesale. Keeps "file recoverable from the Y.Doc alone"
      // unconditionally true, whatever the emitter sent.
      const ym = items.get(uuid);
      const parentUuid = (ym?.get("parent") ?? null) as string | null;
      if (parentUuid !== null) {
        const parentYm = items.get(parentUuid);
        if (parentYm) {
          const body = (parentYm.get("body") ?? []) as Slot[];
          const pruned = pruneItemRefs(body, uuid);
          if (pruned) parentYm.set("body", pruned);
        }
      }
      items.delete(uuid);
    }

    const layout = ydoc.getArray<Slot>(Y_KDOC_LAYOUT);
    // Slots to drop: removed uuids, plus upserts that now have a parent (a kept
    // slot would render the item twice — once at root, once inside the parent).
    const gone = new Set(delta.removed);
    for (const it of [...delta.added, ...delta.updated]) {
      if (it.parent !== null) gone.add(it.uuid);
    }
    if (gone.size) {
      for (let i = layout.length - 1; i >= 0; i--) {
        const slot = layout.get(i);
        if ("item" in slot && gone.has(slot.item)) layout.delete(i, 1);
      }
    }
    const present = new Set<string>();
    for (const slot of layout.toArray()) {
      if ("item" in slot) present.add(slot.item);
    }
    const newRoots = [...delta.added, ...delta.updated]
      .filter((it) => it.parent === null && !present.has(it.uuid))
      .map((it): Slot => ({ item: it.uuid }));
    if (newRoots.length) layout.push(newRoots);
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
