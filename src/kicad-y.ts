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
 *   kdoc_meta    Y.Map    { root: string, sexprVersion: number }  (form name + encoding)
 *   kdoc_items   Y.Map    uuid → Y.Map { type: string, parent: string|null, body }
 *   kdoc_layout  Y.Array  Slot[] (plain JSON entries, root form order)
 *
 * Body granularity is versioned (`kdoc_meta.sexprVersion`, ysync 0009):
 *   v1 (absent/1): `body` is ONE plain-JSON `Slot[]` → item-level merge; any
 *     edit rewrites the whole body (LWW drops concurrent same-item edits).
 *   v2: `body` is a keyed NODE MAP (see `kicad-y2.ts`) → field-level merge;
 *     concurrent edits of different slots of one item both survive, and gc-off
 *     retained growth per edit is ~the changed fields.
 * READERS support both (the body's type discriminates: plain array = v1, Y.Map
 * = v2). WRITERS never mix: every write path resolves the doc's version first
 * and writes only that shape; a fresh doc is stamped `SEXPR_VERSION_CURRENT`.
 * The flatten step (0007) additionally gives per-pad / per-field / per-pin
 * granularity because those ARE separate items.
 */

import * as Y from "yjs";
import {
  assertKicadDoc,
  cloneSlots,
  emptyKicadItems,
  kicadItemSchema,
  libSymbolsFromLayout,
  referencedLibSymbolIds,
  slotFromSexpr,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "./kicad-doc.js";
import { emptyKicadDelta, type KicadDelta } from "./kicad-delta.js";
import {
  assertValidKicadDoc,
  canonicalizeKicadDocGraph,
} from "./kicad-graph.js";
import { Y_KDOC_COMMENTS } from "./comments-wire.js";
import {
  nodeFromSlots,
  SEXPR_VERSION_CURRENT,
  SEXPR_VERSION_SUPPORTED,
  slotsFromNode,
  pruneItemRefFromNode,
  updateNodeFromSlots,
  V3_NODE_ENCODING,
  v3RootSlotsRequireAtomicStorage,
  Y_KDOC_SEXPR_VERSION,
} from "./kicad-y2.js";

export const Y_KDOC_META = "kdoc_meta";
export const Y_KDOC_ITEMS = "kdoc_items";
export const Y_KDOC_LAYOUT = "kdoc_layout";
/** v3 root: one LWW pointer to the complete active document epoch. */
export const Y_KDOC_STATE = "kdoc_state";
export const Y_KDOC_STATE_ACTIVE = "active";
const V3_META = "meta";
const V3_ITEMS = "items";
const V3_LAYOUT_BASE = "layoutBase";
const V3_LAYOUT_OVERRIDES = "layoutOverrides";
const V3_LIBSYMBOLS = "libsymbols";
/**
 * Reserved layoutOverrides register for unkeyed root atoms. S-expression head
 * names cannot contain NUL, so this cannot collide with an authored head.
 * All atoms form one identity-free conflict domain and therefore resolve as
 * one plain-JSON value instead of being positionally merged in a Y.Array.
 */
const V3_LAYOUT_ATOMS = "\u0000atoms";
/**
 * Embedded library definitions (miss 08): lib id → `(symbol …)` definition
 * text. A dedicated Y.Map so concurrent placements of DIFFERENT symbols merge
 * per definition instead of LWW-clobbering one layout slot. The layout's
 * `lib_symbols` slot is kept EMPTY in the doc; `yToDoc` re-injects the map's
 * definitions (sorted by lib id — the same order KiCad's writer emits).
 */
export const Y_KDOC_LIBSYMBOLS = "kdoc_libsymbols";
/** kdoc_meta key holding the winning seeder's nonce (see `seedDocToY`). */
export const Y_KDOC_SEED_NONCE = "seedNonce";

export type KicadYItems = Y.Map<Y.Map<unknown>>;

export type KicadYState = Y.Map<unknown>;

/** The v3 active state envelope, or null for a legacy v1/v2 document. */
export function activeKicadState(ydoc: Y.Doc): KicadYState | null {
  // Do not call getMap here: merely reading an empty document must not create
  // a state root that is later mistaken for a corrupt/deleted active epoch.
  if (!ydoc.share.has(Y_KDOC_STATE)) return null;
  // A root learned only through applyUpdate is an untyped AbstractType until
  // the application requests it; getMap performs that safe materialization.
  const root = ydoc.getMap<unknown>(Y_KDOC_STATE);
  if (!root.has(Y_KDOC_STATE_ACTIVE)) {
    // Observers are allowed to request the future v3 root before the first
    // seed. Y.Doc registers that empty top-level type in `share`, even though
    // it contains no authored state. It is indistinguishable from absence and
    // must remain seedable. Once v3's durable compatibility marker exists (or
    // the root has any authored key), a missing active pointer is corruption
    // and still fails closed.
    const compatibilityMeta = ydoc.share.get(Y_KDOC_META);
    const declaredVersion =
      compatibilityMeta instanceof Y.Map
        ? compatibilityMeta.get(Y_KDOC_SEXPR_VERSION)
        : undefined;
    if (root.size === 0 && declaredVersion !== SEXPR_VERSION_CURRENT) return null;
    throw new Error("invalid kdoc v3 state: active epoch is missing");
  }
  const active = root.get(Y_KDOC_STATE_ACTIVE);
  if (!(active instanceof Y.Map)) {
    throw new Error("invalid kdoc v3 state: active epoch is not a Y.Map");
  }
  return active as KicadYState;
}

function stateMap<T>(state: KicadYState, key: string): Y.Map<T> {
  const value = state.get(key);
  if (!(value instanceof Y.Map)) throw new Error(`invalid kdoc v3 state: ${key} is not a Y.Map`);
  return value as Y.Map<T>;
}

function stateArray<T>(state: KicadYState, key: string): Y.Array<T> {
  const value = state.get(key);
  if (!(value instanceof Y.Array)) {
    throw new Error(`invalid kdoc v3 state: ${key} is not a Y.Array`);
  }
  return value as Y.Array<T>;
}

/** The authoritative metadata map (nested for v3, legacy root for v1/v2). */
export function kicadMetaMap(ydoc: Y.Doc): Y.Map<unknown> {
  const state = activeKicadState(ydoc);
  return state ? stateMap<unknown>(state, V3_META) : ydoc.getMap(Y_KDOC_META);
}

/** The doc's flattened item map (uuid → item Y.Map). */
export function kicadItemsMap(ydoc: Y.Doc): KicadYItems {
  const state = activeKicadState(ydoc);
  return state
    ? stateMap<Y.Map<unknown>>(state, V3_ITEMS)
    : ydoc.getMap<Y.Map<unknown>>(Y_KDOC_ITEMS);
}

/** The doc's embedded library definitions (lib id → definition text). */
export function kicadLibSymbolsMap(ydoc: Y.Doc): Y.Map<string> {
  const state = activeKicadState(ydoc);
  return state
    ? stateMap<string>(state, V3_LIBSYMBOLS)
    : ydoc.getMap<string>(Y_KDOC_LIBSYMBOLS);
}

/**
 * v3's immutable seed/order-hint base, or legacy kdoc_layout.
 *
 * v3 writers never replace its non-item content: mutable keyed content lives
 * in atomic per-head registers and item presence is authoritative in the item
 * map/parent graph. Root item refs may be added/removed as ordering hints; the
 * graph canonicalizer makes those hints total and unique at projection time.
 */
export function kicadLayoutArray(ydoc: Y.Doc): Y.Array<Slot> {
  const state = activeKicadState(ydoc);
  return state
    ? stateArray<Slot>(state, V3_LAYOUT_BASE)
    : ydoc.getArray<Slot>(Y_KDOC_LAYOUT);
}

/** Per-head v3 LWW layout values. Empty arrays are deletion tombstones. */
export function kicadLayoutOverridesMap(ydoc: Y.Doc): Y.Map<Slot[]> | null {
  const state = activeKicadState(ydoc);
  return state ? stateMap<Slot[]>(state, V3_LAYOUT_OVERRIDES) : null;
}

/** Materialize the authoritative layout, applying v3 conflict domains to its base. */
export function kicadLayout(ydoc: Y.Doc): Slot[] {
  const base = cloneSlots(kicadLayoutArray(ydoc).toArray());
  const overrides = kicadLayoutOverridesMap(ydoc);
  if (!overrides || overrides.size === 0) return base;

  const emitted = new Set<string>();
  let atomsEmitted = false;
  const out: Slot[] = [];
  for (const slot of base) {
    if ("atom" in slot && overrides.has(V3_LAYOUT_ATOMS)) {
      if (!atomsEmitted) {
        atomsEmitted = true;
        out.push(...cloneSlots(overrides.get(V3_LAYOUT_ATOMS) ?? []));
      }
      continue;
    }
    if (!("k" in slot) || !overrides.has(slot.k)) {
      out.push(slot);
      continue;
    }
    if (emitted.has(slot.k)) continue;
    emitted.add(slot.k);
    out.push(...cloneSlots(overrides.get(slot.k) ?? []));
  }

  if (overrides.has(V3_LAYOUT_ATOMS) && !atomsEmitted) {
    const extra = cloneSlots(overrides.get(V3_LAYOUT_ATOMS) ?? []);
    const firstItem = out.findIndex((slot) => "item" in slot);
    out.splice(firstItem < 0 ? out.length : firstItem, 0, ...extra);
  }

  const missing = [...overrides.keys()]
    .filter((head) => head !== V3_LAYOUT_ATOMS && !emitted.has(head))
    .sort();
  if (missing.length > 0) {
    const extra = missing.flatMap((head) => cloneSlots(overrides.get(head) ?? []));
    const firstItem = out.findIndex((slot) => "item" in slot);
    out.splice(firstItem < 0 ? out.length : firstItem, 0, ...extra);
  }
  return out;
}

function layoutHeadGroups(slots: Slot[]): Map<string, Slot[]> {
  const groups = new Map<string, Slot[]>();
  for (const slot of slots) {
    if (!("k" in slot)) continue;
    const group = groups.get(slot.k) ?? [];
    group.push(slot);
    groups.set(slot.k, group);
  }
  return groups;
}

function slotsEqual(left: Slot[], right: Slot[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Reconcile one complete native layout snapshot into v3 without ever replacing
 * the shared sequence's non-item seed. Each keyed head is one plain-JSON Y.Map
 * register, including the *whole group* for legal repeated heads such as
 * `net`. Consequently concurrent writes of one head select one authored group;
 * writes of different heads merge independently; and no sequence interleaving
 * can manufacture duplicate `version`/`paper`/etc. slots.
 *
 * Root item refs remain sequence ordering hints. Presence and parentage come
 * from kdoc_items, and canonicalizeKicadDocGraph deterministically removes
 * duplicate/stale hints and appends missing roots. This lets independent root
 * insertions merge while keeping the projected graph total and single-valued.
 * Must run inside the caller's Yjs transaction.
 */
function syncV3LayoutSnapshot(layout: Slot[], ydoc: Y.Doc): void {
  const overrides = kicadLayoutOverridesMap(ydoc);
  if (!overrides) throw new Error("invalid kdoc v3 state: layout overrides are missing");

  const target = layout.map(
    (slot): Slot =>
      "k" in slot && slot.k === "lib_symbols" ? { k: slot.k, v: [] } : slot,
  );
  const visible = kicadLayout(ydoc);
  const currentGroups = layoutHeadGroups(visible);
  const targetGroups = layoutHeadGroups(target);
  const heads = new Set([...currentGroups.keys(), ...targetGroups.keys()]);
  for (const head of heads) {
    const current = currentGroups.get(head) ?? [];
    const next = targetGroups.get(head) ?? [];
    if (!slotsEqual(current, next)) overrides.set(head, cloneSlots(next));
  }

  const currentAtoms = visible.filter((slot) => "atom" in slot);
  const targetAtoms = target.filter((slot) => "atom" in slot);
  if (!slotsEqual(currentAtoms, targetAtoms)) {
    overrides.set(V3_LAYOUT_ATOMS, cloneSlots(targetAtoms));
  }

  // Reconcile root references without touching any non-item slot. Concurrent
  // insertion of the same ref can leave two order hints in the Y.Array; that
  // is harmless and deterministic because the projection keeps exactly the
  // first ref whose authoritative item.parent is null. Any later snapshot also
  // cleans already-visible duplicates below.
  const targetRoots = target.filter(
    (slot): slot is Extract<Slot, { item: string }> => "item" in slot,
  );
  const wanted = new Set(targetRoots.map((slot) => slot.item));
  const base = kicadLayoutArray(ydoc);
  const seen = new Set<string>();
  const remove: number[] = [];
  for (let i = 0; i < base.length; i++) {
    const slot = base.get(i);
    if (!("item" in slot)) continue;
    if (!wanted.has(slot.item) || seen.has(slot.item)) remove.push(i);
    else seen.add(slot.item);
  }
  for (const index of remove.reverse()) base.delete(index, 1);
  const missing = targetRoots.filter((slot) => !seen.has(slot.item));
  if (missing.length > 0) base.push(cloneSlots(missing));
}

/**
 * The doc's s-expr encoding version (`kdoc_meta.sexprVersion`); absent = 1
 * (every doc predating ysync 0009 is v1). See `SEXPR_VERSION_SUPPORTED`.
 */
export function ydocSexprVersion(ydoc: Y.Doc): number {
  const v = kicadMetaMap(ydoc).get(Y_KDOC_SEXPR_VERSION);
  if (v === undefined) return 1;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`invalid kdoc s-expr version: ${JSON.stringify(v)}`);
  }
  return v;
}

function requireSupportedSexprVersion(ydoc: Y.Doc): number {
  const version = ydocSexprVersion(ydoc);
  if (!SEXPR_VERSION_SUPPORTED.includes(version)) {
    throw new Error(
      `unsupported kdoc s-expr version v${version}; supported versions: ${SEXPR_VERSION_SUPPORTED.join(", ")}`,
    );
  }
  if (activeKicadState(ydoc) && version !== SEXPR_VERSION_CURRENT) {
    throw new Error(
      `invalid kdoc v3 state: active epoch declares s-expr version v${version}`,
    );
  }
  return version;
}

/**
 * The version WRITES must use, resolved (and for a fresh doc, stamped) inside
 * the calling transaction: an explicit `sexprVersion` wins; a doc with state
 * but no version predates versioning = v1; an empty doc starts at CURRENT.
 * Writers never mix — a doc is written in its own version only (§5).
 */
function resolveWriteVersion(ydoc: Y.Doc): number {
  const state = activeKicadState(ydoc);
  if (state) {
    const v = stateMap<unknown>(state, V3_META).get(Y_KDOC_SEXPR_VERSION);
    if (v === undefined) throw new Error("invalid kdoc v3 state: missing sexprVersion");
    return requireSupportedSexprVersion(ydoc);
  }

  const meta = ydoc.getMap(Y_KDOC_META);
  const v = meta.get(Y_KDOC_SEXPR_VERSION);
  if (v !== undefined) return requireSupportedSexprVersion(ydoc);
  if (
    ydoc.getMap(Y_KDOC_ITEMS).size > 0 ||
    ydoc.getArray(Y_KDOC_LAYOUT).length > 0 ||
    meta.get("root") !== undefined
  ) {
    return 1;
  }
  return SEXPR_VERSION_CURRENT;
}

/** An item's body as plain slots, whatever its stored shape (v1/v2). */
function bodySlots(ym: Y.Map<unknown>): Slot[] {
  const body = ym.get("body");
  if (body instanceof Y.Map) return slotsFromNode(body);
  return cloneSlots((body as Slot[]) ?? []);
}

/** Read one item Y.Map back into a validated `KicadItem`. */
export function yToItem(ym: Y.Map<unknown>): KicadItem {
  return kicadItemSchema.parse({
    type: ym.get("type"),
    parent: ym.get("parent") ?? null,
    body: bodySlots(ym),
  });
}

/**
 * `yToItem` without the zod parse — the observer HOT PATH (opt 12): the
 * schema walk of every body tree dominated remote-batch cost at scale. Y item
 * content is written exclusively by this module's writers from already-validated
 * sources (the wire parse zod-validates at the trust boundary; seed/materialize
 * paths keep the checked read).
 */
export function yToItemUnchecked(ym: Y.Map<unknown>): KicadItem {
  return {
    type: (ym.get("type") as string) ?? "",
    parent: (ym.get("parent") as string | null) ?? null,
    body: bodySlots(ym),
  };
}

/**
 * Merge library definitions into `kdoc_libsymbols` (additive, LWW per id).
 * Used by the runtime when a wire blob carries `(lib_symbols …)` context.
 */
export function upsertLibSymbolsToY(
  ydoc: Y.Doc,
  defs: Record<string, string>,
  origin?: unknown,
): void {
  if (Object.keys(defs).length === 0) return;
  // Do not mutate a room whose encoding this build cannot interpret exactly.
  if (ydocHasState(ydoc)) requireSupportedSexprVersion(ydoc);
  ydoc.transact(() => {
    const libs = kicadLibSymbolsMap(ydoc);
    for (const [id, def] of Object.entries(defs)) {
      if (libs.get(id) !== def) libs.set(id, def);
    }
  }, origin);
}

/**
 * Upsert an item into the items map, writing only what changed, in the doc's
 * body encoding (`version`). A NEW item is populated before `items.set` so a
 * concurrent create of the same uuid LWWs wholesale (double-seed, §3.6). A
 * body of the WRONG shape for `version` (post-conversion straggler) is
 * replaced wholesale — writers never mix shapes within one doc.
 */
function upsertYItem(
  items: KicadYItems,
  uuid: string,
  item: KicadItem,
  version: number,
): void {
  const existing = items.get(uuid);
  if (!existing) {
    items.set(uuid, yMapFromItem(item, version));
    return;
  }
  const ym = existing;
  if (ym.get("type") !== item.type) ym.set("type", item.type);
  if ((ym.get("parent") ?? null) !== item.parent) ym.set("parent", item.parent);
  const body = ym.get("body");
  if (version === 3) {
    if (body instanceof Y.Map) {
      if (v3RootSlotsRequireAtomicStorage(item.body)) {
        ym.set("body", cloneSlots(item.body));
      } else {
        updateNodeFromSlots(body, item.body, undefined, V3_NODE_ENCODING);
      }
    } else if (JSON.stringify(body) !== JSON.stringify(item.body)) {
      // Atomic is sticky: once a root entered an identity-free conflict domain,
      // do not silently re-granularize it on a later snapshot.
      ym.set("body", cloneSlots(item.body));
    }
  } else if (version === 2) {
    if (body instanceof Y.Map) {
      updateNodeFromSlots(body, item.body); // the v2 differ (kicad-y2.ts)
    } else {
      ym.set("body", nodeFromSlots(item.body));
    }
  } else if (body instanceof Y.Map) {
    ym.set("body", cloneSlots(item.body));
  } else if (JSON.stringify(body) !== JSON.stringify(item.body)) {
    // v1: body is one plain-JSON value (item-level merge) — compare to skip no-ops.
    ym.set("body", cloneSlots(item.body));
  }
}

/** Build a detached item map; integration happens with its containing state. */
function yMapFromItem(item: KicadItem, version: number): Y.Map<unknown> {
  const ym = new Y.Map<unknown>();
  ym.set("type", item.type);
  ym.set("parent", item.parent);
  ym.set(
    "body",
    version === 3
      ? v3RootSlotsRequireAtomicStorage(item.body)
        ? cloneSlots(item.body)
        : nodeFromSlots(item.body, undefined, V3_NODE_ENCODING)
      : version === 2
        ? nodeFromSlots(item.body)
        : cloneSlots(item.body),
  );
  return ym;
}

/**
 * Build a complete detached v3 state. Setting this subtree at `active` is one
 * Y.Map conflict: simultaneous first seeds therefore select one WHOLE epoch
 * (meta, items, layout, and definitions), never a per-root union.
 */
function v3StateFromDoc(doc?: KicadDoc, nonce?: string): KicadYState {
  const state = new Y.Map<unknown>();
  const meta = new Y.Map<unknown>();
  const items = new Y.Map<Y.Map<unknown>>();
  const layout = new Y.Array<Slot>();
  const overrides = new Y.Map<Slot[]>();
  const libs = new Y.Map<string>();

  meta.set(Y_KDOC_SEXPR_VERSION, SEXPR_VERSION_CURRENT);
  if (doc) {
    meta.set("root", doc.root);
    for (const [uuid, item] of Object.entries(doc.items)) {
      items.set(uuid, yMapFromItem(item, SEXPR_VERSION_CURRENT));
    }
    const defs = libSymbolsFromLayout(doc.layout, doc.items);
    for (const [id, def] of Object.entries(defs)) libs.set(id, def);
    const layoutOut = doc.layout.map(
      (slot): Slot =>
        "k" in slot && slot.k === "lib_symbols" ? { k: slot.k, v: [] } : slot,
    );
    layout.insert(0, cloneSlots(layoutOut));
  }
  if (nonce !== undefined) meta.set(Y_KDOC_SEED_NONCE, nonce);

  state.set(V3_META, meta);
  state.set(V3_ITEMS, items);
  state.set(V3_LAYOUT_BASE, layout);
  state.set(V3_LAYOUT_OVERRIDES, overrides);
  state.set(V3_LIBSYMBOLS, libs);
  return state;
}

function installV3State(
  ydoc: Y.Doc,
  state: KicadYState,
  origin?: unknown,
  nonce?: string,
): void {
  ydoc.transact(() => {
    ydoc.getMap<unknown>(Y_KDOC_STATE).set(Y_KDOC_STATE_ACTIVE, state);
    // Compatibility marker only. Authoritative v3 metadata lives inside the
    // selected state; older clients see v3 and refuse rather than writing v2.
    const marker = ydoc.getMap(Y_KDOC_META);
    marker.set(Y_KDOC_SEXPR_VERSION, SEXPR_VERSION_CURRENT);
    if (nonce !== undefined) marker.set(Y_KDOC_SEED_NONCE, nonce);
  }, origin);
}

/**
 * Seed (or re-seed) a Y.Doc from a `KicadDoc` in one transaction. Removes items
 * absent from `doc`, upserts the rest, and reconciles layout + meta. In v3 the
 * layout reconciliation uses atomic per-head registers and root-order hints;
 * legacy encodings retain their wholesale sequence replacement. Tag `origin`
 * so the runtime's observers can recognize the write as their own.
 */
export function docToY(doc: KicadDoc, ydoc: Y.Doc, origin?: unknown): void {
  assertValidKicadDoc(doc);
  const version = resolveWriteVersion(ydoc);
  if (version === 3 && !activeKicadState(ydoc)) {
    installV3State(ydoc, v3StateFromDoc(doc), origin);
    return;
  }
  ydoc.transact(() => {
    const writeVersion = resolveWriteVersion(ydoc);
    kicadMetaMap(ydoc).set("root", doc.root);
    const items = kicadItemsMap(ydoc);
    for (const uuid of [...items.keys()]) {
      if (!Object.hasOwn(doc.items, uuid)) items.delete(uuid);
    }
    for (const [uuid, item] of Object.entries(doc.items)) {
      upsertYItem(items, uuid, item, writeVersion);
    }
    // Library definitions live in their own per-id map (see Y_KDOC_LIBSYMBOLS);
    // the layout keeps an EMPTY lib_symbols slot as the injection point.
    const defs = libSymbolsFromLayout(doc.layout, doc.items);
    const libs = kicadLibSymbolsMap(ydoc);
    for (const [id, def] of Object.entries(defs)) {
      if (libs.get(id) !== def) libs.set(id, def);
    }
    if (writeVersion === 3) {
      syncV3LayoutSnapshot(doc.layout, ydoc);
    } else {
      const layoutOut = doc.layout.map(
        (s): Slot => ("k" in s && s.k === "lib_symbols" ? { k: s.k, v: [] } : s),
      );
      const layout = kicadLayoutArray(ydoc);
      layout.delete(0, layout.length);
      layout.insert(0, cloneSlots(layoutOut));
    }
  }, origin);
}

/**
 * Seed a Y.Doc from a `KicadDoc` with DOUBLE-SEED ARBITRATION (bug 06).
 *
 * V3 builds one detached, complete state and assigns it through the single
 * `kdoc_state.active` register. Concurrent first writers therefore select one
 * whole authored epoch; the returned compatibility callback has no content to
 * retract.
 *
 * The legacy v1/v2 branch below predates that representation. Its layout is a
 * Y.Array, so concurrent seed insertions can both survive. It records this
 * client's insertion clock range and returns a retractor that removes only the
 * losing seed's own layout structs while retaining later edits.
 */
export function seedDocToY(
  doc: KicadDoc,
  ydoc: Y.Doc,
  origin: unknown,
  nonce: string,
): () => void {
  assertValidKicadDoc(doc);
  if (resolveWriteVersion(ydoc) === 3) {
    installV3State(ydoc, v3StateFromDoc(doc, nonce), origin, nonce);
    return () => {
      // The active pointer itself arbitrates the complete state. Keep the
      // compatibility marker aligned for old readers; there is no v3 content
      // to retract and this remains safe if every racing seeder calls it.
      const winner = kicadMetaMap(ydoc).get(Y_KDOC_SEED_NONCE);
      if (winner !== undefined) {
        ydoc.getMap(Y_KDOC_META).set(Y_KDOC_SEED_NONCE, winner);
      }
    };
  }

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

// --- validity revert (kicad-validity 0001 B2) --------------------------------
// `kdoc_meta` marker a backend writes alongside a validity revert, so clients
// can surface "this document was rolled back" (observed like seedNonce).
export const Y_KDOC_REVERT_NONCE = "revertNonce";
export const Y_KDOC_REVERT_REASON = "revertReason";
export const Y_KDOC_REVERT_AT = "revertedAt";

/**
 * Apply a `KicadDoc` snapshot over a Y.Doc as a FORWARD operation, touching
 * only what differs: items absent from `doc` are deleted, the rest go through
 * `upsertYItem`'s no-op skip (v2/v3 slot differ), and lib defs sync per id. A
 * v3 layout writes changed keyed groups as independent atomic registers and
 * reconciles only root item ordering hints in the sequence; legacy layouts are
 * replaced wholesale when changed. Unchanged state keeps its history and
 * attribution untouched — the property a validity revert needs
 * (kicad-validity 0001 §4.4).
 */
export function upsertDocToY(doc: KicadDoc, ydoc: Y.Doc, origin?: unknown): void {
  assertValidKicadDoc(doc);
  if (resolveWriteVersion(ydoc) === 3 && !activeKicadState(ydoc)) {
    installV3State(ydoc, v3StateFromDoc(doc), origin);
    return;
  }
  ydoc.transact(() => {
    const version = resolveWriteVersion(ydoc);
    const meta = kicadMetaMap(ydoc);
    if (meta.get("root") !== doc.root) meta.set("root", doc.root);

    const items = kicadItemsMap(ydoc);
    for (const uuid of [...items.keys()]) {
      if (!Object.hasOwn(doc.items, uuid)) items.delete(uuid);
    }
    for (const [uuid, item] of Object.entries(doc.items)) {
      upsertYItem(items, uuid, item, version);
    }

    const defs = libSymbolsFromLayout(doc.layout, doc.items);
    const libs = kicadLibSymbolsMap(ydoc);
    for (const [id, def] of Object.entries(defs)) {
      if (libs.get(id) !== def) libs.set(id, def);
    }

    if (version === 3) {
      syncV3LayoutSnapshot(doc.layout, ydoc);
    } else {
      const target = doc.layout.map(
        (s): Slot => ("k" in s && s.k === "lib_symbols" ? { k: s.k, v: [] } : s),
      );
      const layout = kicadLayoutArray(ydoc);
      if (JSON.stringify(layout.toArray()) !== JSON.stringify(target)) {
        layout.delete(0, layout.length);
        layout.insert(0, cloneSlots(target));
      }
    }
  }, origin);
}

/** Transaction origin tag for validity-revert writes. */
export const KICAD_VALIDITY_REVERT_ORIGIN = "kicad-validity-revert";

/**
 * Merge encoded Yjs updates into one (Y.mergeUpdates verbatim — re-exported so
 * yjs-free backends can compose `checkpoint + buffered frames` for the
 * bisect-blame pass, kicad-validity 0001 §4.5). Updates are idempotent, so
 * frames already contained in the base merge as no-ops.
 */
export function mergeYUpdates(updates: Uint8Array[]): Uint8Array {
  return Y.mergeUpdates(updates);
}

/**
 * Compute the incremental Yjs update that reverts a doc's CONTENT to a
 * known-good checkpoint — CRDT merges are monotonic, so a rollback must be a
 * forward operation (kicad-validity 0001 §4.4). Both inputs are encoded state
 * updates (`.ydoc` blob / `/room/state` shape). Returns the update to apply to
 * the live room (it carries only the differing slots plus the revert marker in
 * `kdoc_meta`), or null when the content already equals the checkpoint.
 * Pure — the backend calls this without importing yjs itself.
 */
export function computeRevertUpdate(opts: {
  current: Uint8Array;
  good: Uint8Array;
  nonce: string;
  reason: string;
  /** ISO timestamp for the marker (caller-supplied to keep this pure). */
  at: string;
}): Uint8Array | null {
  const goodDoc = ydocUpdateToKicadDoc(opts.good);
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, opts.current);
    const sv = Y.encodeStateVector(ydoc);
    upsertDocToY(goodDoc, ydoc, KICAD_VALIDITY_REVERT_ORIGIN);
    // A no-op upsert encodes as the empty 2-byte diff — content already equals
    // the checkpoint; no revert, no marker.
    if (Y.encodeStateAsUpdate(ydoc, sv).length <= 2) return null;
    ydoc.transact(() => {
      const meta = kicadMetaMap(ydoc);
      meta.set(Y_KDOC_REVERT_NONCE, opts.nonce);
      meta.set(Y_KDOC_REVERT_REASON, opts.reason);
      meta.set(Y_KDOC_REVERT_AT, opts.at);
    }, KICAD_VALIDITY_REVERT_ORIGIN);
    return Y.encodeStateAsUpdate(ydoc, sv);
  } finally {
    ydoc.destroy();
  }
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
  if (activeKicadState(ydoc)) return true;
  return (
    ydoc.getMap(Y_KDOC_ITEMS).size > 0 ||
    ydoc.getArray<Slot>(Y_KDOC_LAYOUT).length > 0 ||
    ydoc.getMap(Y_KDOC_META).get("root") !== undefined
  );
}

/** Read the full `KicadDoc` back out of a Y.Doc (validated). */
export function yToDoc(ydoc: Y.Doc): KicadDoc {
  requireSupportedSexprVersion(ydoc);
  const root = kicadMetaMap(ydoc).get("root") as string;
  const items = emptyKicadItems();
  // Unchecked per-item read: the whole-doc structural check at the end walks
  // every item anyway — the per-item zod parse here was a redundant second
  // full-document walk (~800ms on a 3k-item board).
  kicadItemsMap(ydoc).forEach((ym, uuid) => {
    items[uuid] = yToItemUnchecked(ym);
  });
  const layout = kicadLayout(ydoc);

  // Definition knowledge is monotonic internal state. Materialize only the
  // subset referenced by current authoritative items, sorted like KiCad's
  // native cache writer. Orphans remain available for a concurrent/later
  // consumer without creating native-file drift meanwhile.
  const libs = kicadLibSymbolsMap(ydoc);
  const referenced = referencedLibSymbolIds(items);
  const materialized = [...referenced].filter((id) => libs.has(id)).sort();
  // `lib_symbols` is a schematic cache. PCB fixtures and older generic item
  // rooms may legitimately contain a `lib_id` atom without that cache; only a
  // schematic consumer/definition mismatch is a dangling native document.
  const missing =
    root === "kicad_sch"
      ? [...referenced].filter((id) => !libs.has(id)).sort()
      : [];
  if (missing.length > 0) {
    throw new Error(
      `cannot materialize KiCad document: referenced library definitions are missing (${missing
        .map((id) => JSON.stringify(id))
        .join(", ")})`,
    );
  }
  if (materialized.length > 0) {
    const defSlots = materialized.map((id) => slotFromSexpr(libs.get(id)!, items));
    const at = layout.findIndex((s) => "k" in s && s.k === "lib_symbols");
    const slot: Slot = { k: "lib_symbols", v: defSlots };
    if (at >= 0) {
      layout[at] = slot;
    } else {
      const firstItem = layout.findIndex((s) => "item" in s);
      layout.splice(firstItem < 0 ? layout.length : firstItem, 0, slot);
    }
  }

  return canonicalizeKicadDocGraph(assertKicadDoc({ root, items, layout }));
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

/** Deep-clone a Y value tree (Y.Map / Y.Array / plain JSON leaves). */
function cloneYValue(v: unknown): unknown {
  if (v instanceof Y.Map) {
    const m = new Y.Map<unknown>();
    v.forEach((val, k) => m.set(k, cloneYValue(val)));
    return m;
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array<unknown>();
    a.insert(0, v.toArray().map(cloneYValue));
    return a;
  }
  if (Array.isArray(v)) return v.map(cloneYValue);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) {
      Object.defineProperty(out, key, {
        value: cloneYValue(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return v;
}

/**
 * Root types a kdoc room can hold BESIDES the kdoc itself. A version
 * conversion / compaction rebuilds the doc from materialized state, so
 * anything not listed here would be silently DROPPED — every new root type
 * added to room docs must be registered here.
 */
const KDOC_EXTRA_ROOT_MAPS = [Y_KDOC_COMMENTS];
const KDOC_KNOWN_ROOTS = new Set([
  Y_KDOC_STATE,
  Y_KDOC_META,
  Y_KDOC_ITEMS,
  Y_KDOC_LAYOUT,
  Y_KDOC_LIBSYMBOLS,
  ...KDOC_EXTRA_ROOT_MAPS,
]);

const KDOC_V3_ROOT_FIELDS = new Set([Y_KDOC_STATE_ACTIVE]);
const KDOC_V3_ACTIVE_FIELDS = new Set([
  V3_META,
  V3_ITEMS,
  V3_LAYOUT_BASE,
  V3_LAYOUT_OVERRIDES,
  V3_LIBSYMBOLS,
]);
const KDOC_ITEM_FIELDS = new Set(["type", "parent", "body"]);

function mapHasOnlyKnownFields(
  map: Y.Map<unknown>,
  known: ReadonlySet<string>,
): boolean {
  let understood = true;
  map.forEach((_value, key) => {
    if (!known.has(key)) understood = false;
  });
  return understood;
}

/**
 * Reseeding is allowed only when this build can account for every structural
 * field it would replace. Dynamic content maps (metadata, layout-head
 * overrides, definitions) are either copied or materialized losslessly;
 * envelope/item fields are a closed vocabulary for this protocol version.
 * A newer client must bump the protocol or leave an unknown field here, in
 * which case the original update remains authoritative.
 */
function compactionSchemaIsKnown(ydoc: Y.Doc): boolean {
  const active = activeKicadState(ydoc);
  if (active) {
    const stateRoot = ydoc.getMap<unknown>(Y_KDOC_STATE);
    if (!mapHasOnlyKnownFields(stateRoot, KDOC_V3_ROOT_FIELDS)) return false;
    if (!mapHasOnlyKnownFields(active, KDOC_V3_ACTIVE_FIELDS)) return false;
  }

  const items = kicadItemsMap(ydoc);
  let understood = true;
  items.forEach((item) => {
    if (!(item instanceof Y.Map) || !mapHasOnlyKnownFields(item, KDOC_ITEM_FIELDS)) {
      understood = false;
    }
  });
  return understood;
}

export interface YdocCompaction {
  /** The replacement state update (a fresh doc — new epoch, new clientIDs). */
  update: Uint8Array;
  fromVersion: number;
  reason: "version-upgrade" | "compaction";
}

/**
 * Build a fresh-identity replacement update for an explicit offline/manual
 * epoch rewrite. This MUST NOT run from `BoardRoom.onLoad` or another live
 * path until a replica-generation fence rejects or drains every client that
 * can still publish updates from the old epoch: Yjs updates from those replicas
 * remain mergeable but cannot affect the freshly allocated identities.
 * Given a persisted state update:
 *
 *  - a doc written in an OLDER s-expr version is re-seeded as a fresh
 *    `SEXPR_VERSION_CURRENT` doc (`reason: "version-upgrade"`);
 *  - a current-version doc whose blob has bloated past `ratio ×` its compacted
 *    size is re-seeded the same way (`reason: "compaction"`);
 *  - anything else returns null: hydrate the blob as-is. That covers docs
 *    NEWER than this build (never downgrade), presence/empty docs, and
 *    editor-snapshot-seeded docs with no `kdoc_meta.root` (not materializable
 *    — they stay on their version, which is consistent for every client).
 *
 * Comment threads (and any `KDOC_EXTRA_ROOT_MAPS` entry) are deep-cloned into
 * the fresh doc; layout arbitration state (`seedNonce`) is deliberately not —
 * it only matters within one concurrent-seed race window.
 */
export function compactYdocUpdate(
  update: Uint8Array,
  opts: { ratio?: number } = {},
): YdocCompaction | null {
  const ratio = opts.ratio ?? 3;
  const src = new Y.Doc();
  try {
    Y.applyUpdate(src, update);
    let version: number;
    try {
      version = ydocSexprVersion(src);
    } catch {
      return null;
    }
    if (!SEXPR_VERSION_SUPPORTED.includes(version)) return null;
    try {
      if (kicadMetaMap(src).get("root") === undefined) return null;
    } catch {
      // A stamped v3 envelope without a valid active epoch is corrupt. Keep
      // the original update authoritative; compaction must never turn a
      // malformed document into a fresh, apparently valid one.
      return null;
    }
    // Rebuilding only the roots this schema understands would silently erase
    // plugin/future data. Unknown roots make compaction ineligible; the exact
    // original update remains authoritative and can be handled by a newer app.
    for (const key of src.share.keys()) {
      if (!KDOC_KNOWN_ROOTS.has(key)) return null;
    }
    try {
      if (!compactionSchemaIsKnown(src)) return null;
    } catch {
      // Structural uncertainty is never permission to reseed. The normal
      // hydration path retains the exact original update for a newer build or
      // an explicit recovery flow.
      return null;
    }

    let kdoc: KicadDoc;
    try {
      kdoc = yToDoc(src);
    } catch {
      // Compaction is an optimization/migration boundary, never a repair
      // authority. A malformed known root stays byte-for-byte authoritative so
      // the room can quarantine/recover it instead of crashing or erasing it.
      return null;
    }
    const out = new Y.Doc();
    try {
      docToY(kdoc, out); // fresh doc → stamped SEXPR_VERSION_CURRENT
      // `yToDoc` intentionally materializes only definitions referenced by
      // the current item graph. The raw library map is broader, monotonic
      // collaboration knowledge: an unreferenced definition may be needed by
      // a concurrent or later consumer. Preserve that authoritative map
      // verbatim across the fresh compaction epoch without injecting its
      // orphans into the native `KicadDoc` snapshot.
      const fromLibs = kicadLibSymbolsMap(src);
      const toLibs = kicadLibSymbolsMap(out);
      toLibs.clear();
      fromLibs.forEach((definition, id) => toLibs.set(id, definition));
      for (const key of KDOC_EXTRA_ROOT_MAPS) {
        const from = src.getMap<unknown>(key);
        if (from.size === 0) continue;
        const to = out.getMap<unknown>(key);
        from.forEach((val, k) => to.set(k, cloneYValue(val)));
      }
      // Preserve durable and future metadata without carrying the ephemeral
      // concurrent-seed nonce into the new epoch.
      const fromMeta = kicadMetaMap(src);
      const toMeta = kicadMetaMap(out);
      fromMeta.forEach((value, key) => {
        if (
          key === "root" ||
          key === Y_KDOC_SEXPR_VERSION ||
          key === Y_KDOC_SEED_NONCE
        ) {
          return;
        }
        toMeta.set(key, cloneYValue(value));
      });
      const compacted = Y.encodeStateAsUpdate(out);
      if (version < SEXPR_VERSION_CURRENT) {
        return { update: compacted, fromVersion: version, reason: "version-upgrade" };
      }
      if (update.length > ratio * compacted.length) {
        return { update: compacted, fromVersion: version, reason: "compaction" };
      }
      return null;
    } catch {
      return null;
    } finally {
      out.destroy();
    }
  } finally {
    src.destroy();
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
  if (resolveWriteVersion(ydoc) === 3 && !activeKicadState(ydoc)) {
    installV3State(ydoc, v3StateFromDoc(), origin);
  }
  ydoc.transact(() => {
    const version = resolveWriteVersion(ydoc);
    const items = kicadItemsMap(ydoc);
    for (const it of delta.added) upsertYItem(items, it.uuid, it, version);
    for (const it of delta.updated) upsertYItem(items, it.uuid, it, version);
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
          const body = parentYm.get("body");
          if (body instanceof Y.Map) {
            pruneItemRefFromNode(body, uuid, pruneItemRefs);
          } else {
            const pruned = pruneItemRefs((body ?? []) as Slot[], uuid);
            if (pruned) parentYm.set("body", pruned);
          }
        }
      }
      items.delete(uuid);
    }

    const layout = kicadLayoutArray(ydoc);
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
 * Coarse non-item layout sync from a freshly SAVED file (miss 08). Item slots
 * belong to the item sync and are never touched; everything else — title block,
 * paper, setup, settings… — reconciles per HEAD KEYWORD: when a head's slot
 * group in the saved file differs from the doc's, the doc's group is replaced
 * wholesale (LWW at head granularity; concurrent edits to DIFFERENT heads
 * merge, same-head edits last-write-win). Coarse but converging — without it a
 * settings edit diverges silently forever, and in ydoc mode the author's own
 * edit is lost on the next open.
 *
 * Special conflict domains:
 * - `net` (pcbnew's root net table): the complete repeated group is one plain
 *   JSON value in v3's layout-overrides map. A save therefore authors one
 *   atomic table; concurrent saves select one whole table, never a positional
 *   hybrid. Legacy v1/v2 rooms keep this head frozen because their Y.Array
 *   representation cannot provide that guarantee.
 * - `lib_symbols`: routed to the monotonic kdoc_libsymbols knowledge map.
 *   Native snapshots may add/update knowledge but never delete it: absence
 *   cannot distinguish an orphan from an unseen concurrent peer consumer.
 *   `yToDoc` filters retained orphans from native materialization until a live
 *   authoritative item references that definition again.
 *
 * Returns true when anything changed.
 */
export function syncLayoutToY(fileDoc: KicadDoc, ydoc: Y.Doc, origin?: unknown): boolean {
  assertKicadDoc(fileDoc);
  if (ydocHasState(ydoc)) requireSupportedSexprVersion(ydoc);
  let changed = false;

  ydoc.transact(() => {
    const overrides = kicadLayoutOverridesMap(ydoc);
    // lib_symbols → monotonic per-id definition knowledge. A native snapshot
    // can teach us a definition but can never prove it safe to forget one.
    const defs = libSymbolsFromLayout(fileDoc.layout, fileDoc.items);
    const libs = kicadLibSymbolsMap(ydoc);
    for (const [id, def] of Object.entries(defs)) {
      if (libs.get(id) !== def) {
        libs.set(id, def);
        changed = true;
      }
    }
    const frozen = new Set(["lib_symbols"]);
    if (!overrides) frozen.add("net");

    const groupsOf = (slots: Slot[]): Map<string, Slot[]> => {
      const m = new Map<string, Slot[]>();
      for (const s of slots) {
        if (!("k" in s) || frozen.has(s.k)) continue;
        const list = m.get(s.k) ?? [];
        list.push(s);
        m.set(s.k, list);
      }
      return m;
    };

    const fileGroups = groupsOf(fileDoc.layout);
    const visibleLayout = kicadLayout(ydoc);
    const heads = new Set([...fileGroups.keys(), ...groupsOf(visibleLayout).keys()]);

    if (overrides) {
      const currentGroups = groupsOf(visibleLayout);
      for (const head of heads) {
        const curGroup = currentGroups.get(head) ?? [];
        const fileGroup = fileGroups.get(head) ?? [];
        if (JSON.stringify(curGroup) === JSON.stringify(fileGroup)) continue;
        // A plain JSON value is one Y.Map register: same-head replacements are
        // single-valued LWW, while different heads remain independent.
        overrides.set(head, cloneSlots(fileGroup));
        changed = true;
      }
      return;
    }

    const layout = kicadLayoutArray(ydoc);

    for (const head of heads) {
      const cur = layout.toArray(); // refresh after prior group mutations
      const curGroup = cur.filter((s) => "k" in s && s.k === head);
      const fileGroup = fileGroups.get(head) ?? [];
      if (JSON.stringify(curGroup) === JSON.stringify(fileGroup)) continue;

      // Replace the whole group: delete existing occurrences (reverse keeps
      // indices valid), then insert the file's at the first old position (or
      // before the first {item} slot for a brand-new head).
      let insertAt = cur.findIndex((s) => "k" in s && s.k === head);
      if (insertAt < 0) {
        const firstItem = cur.findIndex((s) => "item" in s);
        insertAt = firstItem < 0 ? cur.length : firstItem;
      }
      for (let i = cur.length - 1; i >= 0; i--) {
        const s = cur[i]!;
        if ("k" in s && s.k === head) layout.delete(i, 1);
      }
      if (fileGroup.length) {
        layout.insert(Math.min(insertAt, layout.length), cloneSlots(fileGroup));
      }
      changed = true;
    }
  }, origin);

  return changed;
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
      // An event below the items map: on one item's Y.Map (path [uuid]) or, in
      // a v2 doc, deep inside a body node map (path [uuid, "body", …]). The
      // owning uuid is path[0] in both shapes.
      const uuid = ev.path[0];
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
