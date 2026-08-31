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
 *   Y → editor:  deltaToItemsWire(delta, view)    — lifts each added/updated
 *                item to its ROOT ancestor and renders the root's full s-expr
 *                (descendants resolved from `view`), deduped — the C++ appliers
 *                replace roots; a bare child blob cannot be re-attached.
 */

import { z } from "zod";
import {
  renderItem,
  scalar,
  sexprToItems,
  unquoteAtom,
  type KicadItem,
} from "./kicad-doc.js";
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
  /**
   * Project-relative path of the sheet this apply belongs to (ysync bug 07,
   * UP side). The C++ apply runs deferred on whatever screen is active WHEN
   * IT RUNS; the tool drops an envelope whose sheet is not the shown one
   * instead of adding another sheet's items to the current screen.
   */
  sheet: z.string().optional(),
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

/** parent uuid → direct child uuids, built once per conversion (opt 12). */
function childrenIndex(items: Record<string, KicadItem>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const [uuid, item] of Object.entries(items)) {
    if (item.parent !== null) {
      const list = children.get(item.parent) ?? [];
      list.push(uuid);
      children.set(item.parent, list);
    }
  }
  return children;
}

function descendantsFrom(children: Map<string, string[]>, root: string): string[] {
  const out: string[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const uuid = stack.pop()!;
    out.push(uuid);
    stack.push(...(children.get(uuid) ?? []));
  }
  return out;
}

/** All uuids whose parent chain reaches `root` (excluding `root` itself). */
export function descendants(
  items: Record<string, KicadItem>,
  root: string,
): string[] {
  return descendantsFrom(childrenIndex(items), root);
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

/** Reports a wire entry a conversion could not resolve to an item and skipped. */
export type WireSkipHandler = (w: WireItem, err: unknown) => void;

/** 32-bit FNV-1a over `str`, folded from `seed`. */
function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic uuid-shaped digest of `ns` (v4/variant nibbles pinned so
 * KiCad's KIID parser accepts it). Stable across processes — the same
 * (root, child) collision always re-keys to the same uuid, which is what
 * makes repeated sends of the same colliding blob idempotent.
 */
function deriveUuid(ns: string): string {
  const h =
    fnv1a(ns, 0x811c9dc5).toString(16).padStart(8, "0") +
    fnv1a(ns, 0x9747b28c).toString(16).padStart(8, "0") +
    fnv1a(ns, 0x2545f491).toString(16).padStart(8, "0") +
    fnv1a(ns, 0x85ebca6b).toString(16).padStart(8, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Rewrite `{item: X}` refs inside slots per `mapping`, in place. */
function rewriteSlotRefs(slots: KicadItem["body"], mapping: Map<string, string>): void {
  for (const s of slots) {
    if ("item" in s) {
      const to = mapping.get(s.item);
      if (to !== undefined) (s as { item: string }).item = to;
    } else if ("k" in s) {
      rewriteSlotRefs(s.v, mapping);
    }
  }
}

/**
 * Guard against cross-parent uuid collisions (sync-delete bug 2026-08-31):
 * eeschema's copy-paste mints a fresh uuid for the pasted symbol ROOT but
 * keeps the source symbol's pin/field uuids verbatim. KiCad only needs child
 * uuids to be unique per parent; the flat uuid-keyed item map needs them
 * globally unique. Upserting such a blob as-is would overwrite the ORIGINAL
 * owner's child entries with `parent = <pasted root>` ("stealing" them) — and
 * a later delete of the pasted root would cascade over the stolen children,
 * leaving the original's body with dangling refs (docToFile: "missing item",
 * which froze the pcbnew tab's sibling mirror forever).
 *
 * Any flattened NON-ROOT item whose uuid already exists in `current` under a
 * DIFFERENT parent (outside this subtree) is re-keyed to a deterministic
 * derived uuid; the subtree's parent links and `{item}` refs follow. The
 * derivation is a pure function of (root, child), so every conversion of the
 * same blob re-keys identically — re-sends compare equal and stay no-ops.
 */
function rekeyCollidingChildren(
  flat: { uuid: string; items: Record<string, KicadItem> },
  current: Record<string, KicadItem>,
): { uuid: string; items: Record<string, KicadItem> } {
  const mapping = new Map<string, string>();
  for (const [id, item] of Object.entries(flat.items)) {
    if (id === flat.uuid) continue;
    const old = current[id];
    if (!old) continue;
    if (old.parent === item.parent) continue; // same owner — a normal update
    // The old parent living inside this same subtree means the item moved
    // within its own root's structure, not across owners.
    if (old.parent !== null && old.parent in flat.items) continue;
    let candidate = deriveUuid(`${flat.uuid}:${id}`);
    for (
      let salt = 1;
      candidate in flat.items ||
      (candidate in current && current[candidate]!.parent !== item.parent);
      salt++
    ) {
      candidate = deriveUuid(`${flat.uuid}:${id}:${salt}`);
    }
    mapping.set(id, candidate);
  }
  if (mapping.size === 0) return flat;

  const items: Record<string, KicadItem> = {};
  for (const [id, item] of Object.entries(flat.items)) {
    const newParent = item.parent !== null ? (mapping.get(item.parent) ?? item.parent) : null;
    if (newParent !== item.parent) item.parent = newParent;
    rewriteSlotRefs(item.body, mapping);
    items[mapping.get(id) ?? id] = item;
  }
  return { uuid: flat.uuid, items };
}

/**
 * Convert a bridge items-wire delta into a `KicadDelta` against the `current`
 * item set (typically the Y.Doc's items). Pure; exact subtree reconciliation:
 * a changed footprint whose pad disappeared yields `removed: [that pad]`.
 *
 * An entry that cannot be resolved to an item is SKIPPED (reported via
 * `onSkip`), never allowed to abort the batch: pcbnew's board writer emits
 * nothing for a standalone child (`case PCB_FIELD_T: break;` — a field is its
 * footprint's content, and `default:` is a release no-op wxFAIL_MSG), so an
 * unlifted child reaching the sender's serializer yields an item-less board
 * envelope. Throwing on it discarded every OTHER entry in the message — after
 * the sender had already rebaselined, so the lost items could never be re-sent.
 * The empty envelope itself carries nothing, so skipping it is lossless.
 */
export function itemsWireToDelta(
  wire: ItemsWireDelta,
  current: Record<string, KicadItem>,
  onSkip?: WireSkipHandler,
): KicadDelta {
  const delta = emptyKicadDelta();
  const children = childrenIndex(current); // once per conversion, not per item (opt 12)

  const upsert = (w: WireItem): void => {
    let flat: ReturnType<typeof sexprToItems>;
    try {
      flat = sexprToItems(unwrapWireItem(w.sexpr), w.parent);
    } catch (err) {
      onSkip?.(w, err);
      return;
    }
    const { uuid, items } = rekeyCollidingChildren(flat, current);
    // Previous subtree members (known to `current`) that the new flatten no
    // longer contains have been deleted inside this item.
    const stale = new Set(
      [uuid, ...descendantsFrom(children, uuid)].filter((id) => id in current),
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
    delta.removed.push(id, ...descendantsFrom(children, id));
  }
  return delta;
}

/**
 * Every uuid a wire's added/changed sexprs carry (the items plus their nested
 * subtrees). The diff-on-rebind adopt uses this to find doc-only items.
 *
 * Un-resolvable entries are skipped like `itemsWireToDelta`'s (same wire, same
 * failure mode); an item-less entry contributes no uuids, which on the adopt
 * path errs toward doc authority — the safe direction.
 */
export function wireItemUuids(wire: ItemsWireDelta, onSkip?: WireSkipHandler): Set<string> {
  const out = new Set<string>();
  for (const w of [...wire.added, ...wire.changed]) {
    let items: Record<string, KicadItem>;
    try {
      items = sexprToItems(unwrapWireItem(w.sexpr), w.parent).items;
    } catch (err) {
      onSkip?.(w, err);
      continue;
    }
    for (const id of Object.keys(items)) out.add(id);
  }
  return out;
}

/**
 * Library definitions carried by wire sexprs' `(lib_symbols …)` context, keyed
 * by lib id. eeschema's clipboard blob for a symbol is multi-form —
 * `(lib_symbols (symbol "Device:R" …)) (symbol (lib_id "Device:R") (uuid X) …)`
 * — and `unwrapWireItem` deliberately drops the envelope; this recovers the
 * definitions so the runtime can store them (miss 08: without it a placed
 * symbol reaches peers without its definition and renders broken).
 */
export function wireLibSymbols(wire: ItemsWireDelta): Record<string, string> {
  const defs: Record<string, string> = {};

  const collect = (form: SNode[]): void => {
    for (const def of form.slice(1)) {
      if (!Array.isArray(def) || def[0] !== "symbol") continue;
      const id = def[1];
      if (typeof id === "string") defs[unquoteAtom(id)] = printSexpr(def);
    }
  };

  for (const w of [...wire.added, ...wire.changed]) {
    for (const form of parseSexpr(w.sexpr)) {
      if (!Array.isArray(form)) continue;
      if (form[0] === "lib_symbols") {
        collect(form);
        continue;
      }
      // An enveloped blob may carry lib_symbols one level down.
      for (const child of form) {
        if (Array.isArray(child) && child[0] === "lib_symbols") collect(child);
      }
    }
  }
  return defs;
}

/**
 * Render a `KicadDelta` into the items wire for the editor. `view` must contain
 * the delta's items AND their descendants (e.g. the post-apply Y items read back)
 * so each sexpr embeds its full subtree.
 *
 * Every added/updated item is LIFTED to its root ancestor and the root's full
 * subtree is rendered (deduped): the C++ appliers replace roots by uuid, and a
 * bare child blob cannot be re-attached — pcbnew even wraps one in a board
 * envelope where e.g. a lone `(pad …)` is unparseable, so a child-only change
 * (pad size, field text) would silently never apply. A child added/updated
 * under a surviving root therefore becomes that root's CONTENT change (mirrors
 * the C++ sender's own liftBlob); children whose root is removed in the same
 * delta are dropped — the removal covers them.
 *
 * `libDefs` (miss 08): resolves a lib id to its `(symbol …)` definition text
 * (typically a `kdoc_libsymbols` read). A root item carrying a `(lib_id …)`
 * gets its definition prefixed as `(lib_symbols …)` multi-form clipboard text —
 * exactly the shape eeschema's apply parses, whose findLib prefers the blob's
 * own definitions, so a peer that has never seen the symbol still renders it.
 */
export function deltaToItemsWire(
  delta: KicadDelta,
  view: Record<string, KicadItem>,
  libDefs?: (libId: string) => string | undefined,
): ItemsWireDelta {
  const removed = new Set(delta.removed);

  // Walk to the item's root. Cycle-guarded, and a chain that dead-ends on a
  // uuid missing from `view` (dangling parent — bug 03 family) falls back to
  // the item itself rather than rendering a missing root.
  const rootOf = (uuid: string): string => {
    let cur = uuid;
    const seen = new Set<string>([cur]);
    while (view[cur]?.parent != null) {
      const next = view[cur]!.parent!;
      if (seen.has(next)) return uuid;
      seen.add(next);
      cur = next;
    }
    return view[cur] ? cur : uuid;
  };

  const toWire = (uuid: string): WireItem => {
    let sexpr = renderItem({ items: view }, uuid);
    const parent = view[uuid]?.parent ?? null;
    if (libDefs && parent === null) {
      const libId = scalar(view[uuid]?.body ?? [], "lib_id");
      const def = libId ? libDefs(unquoteAtom(libId)) : undefined;
      if (def) sexpr = `(lib_symbols ${def}) ${sexpr}`;
    }
    return { sexpr, parent };
  };

  const added = new Set<string>();
  const changed = new Set<string>();
  for (const it of delta.added) {
    const root = rootOf(it.uuid);
    if (removed.has(root)) continue;
    (root === it.uuid ? added : changed).add(root);
  }
  for (const it of delta.updated) {
    const root = rootOf(it.uuid);
    if (removed.has(root)) continue;
    changed.add(root);
  }
  // An added root's sexpr already carries every descendant — drop echoes.
  for (const root of added) changed.delete(root);

  return {
    added: [...added].map(toWire),
    changed: [...changed].map(toWire),
    removed: delta.removed,
  };
}
