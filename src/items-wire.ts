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
  itemNodeToItems,
  renderItem,
  scalar,
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
  const visited = new Set<string>([root]);
  while (stack.length) {
    const uuid = stack.pop()!;
    if (visited.has(uuid)) continue;
    visited.add(uuid);
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
class NoWireItemError extends Error {}

/**
 * pcbnew's serializer can intentionally produce exactly this furniture-only
 * envelope for a standalone PCB_FIELD_T. It is the sole zero-item payload we
 * may skip: a bare/unknown item-like form without a UUID is corruption.
 */
function isKnownEmptyPcbnewEnvelope(forms: readonly SNode[]): boolean {
  if (forms.length !== 1 || !Array.isArray(forms[0])) return false;
  const form = forms[0];
  if (form[0] !== "kicad_pcb") return false;
  const allowed = new Set(["version", "generator", "layers"]);
  const heads: string[] = [];
  for (const child of form.slice(1)) {
    if (!Array.isArray(child) || typeof child[0] !== "string" || !allowed.has(child[0])) {
      return false;
    }
    heads.push(child[0]);
  }
  return (
    heads.length === 3 &&
    new Set(heads).size === 3 &&
    heads.every((head) => allowed.has(head))
  );
}

function wireItemNode(text: string): SNode[] {
  const forms = parseSexpr(text);
  const candidates: SNode[][] = [];

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

  if (candidates.length === 0) {
    if (isKnownEmptyPcbnewEnvelope(forms)) {
      throw new NoWireItemError(
        "unwrapWireItem: known empty pcbnew field envelope contains no item",
      );
    }
    throw new Error(
      "unwrapWireItem: uuid-bearing item missing from unknown/item-like payload",
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      `unwrapWireItem: expected exactly 1 uuid-bearing item form, found ${candidates.length}`,
    );
  }
  return candidates[0]!;
}

export function unwrapWireItem(text: string): string {
  return printSexpr(wireItemNode(text));
}

/** Reports a syntactically valid, item-less native envelope that was skipped. */
export type WireSkipHandler = (w: WireItem, err: unknown) => void;

type WireUpsertCategory = "added" | "changed";

interface ParsedWireUpsert {
  wire: WireItem;
  category: WireUpsertCategory;
  uuid: string;
  items: Record<string, KicadItem>;
}

/**
 * Parse and flatten every upsert before delta construction.  Only a known
 * item-less native envelope is recoverable: malformed syntax and ambiguous
 * multi-item payloads reject the whole batch.
 */
function parseWireUpserts(
  wire: ItemsWireDelta,
): {
  upserts: ParsedWireUpsert[];
  categoryByUuid: Map<string, WireUpsertCategory>;
  skipped: Array<{ wire: WireItem; error: NoWireItemError }>;
} {
  const upserts: ParsedWireUpsert[] = [];
  const skipped: Array<{ wire: WireItem; error: NoWireItemError }> = [];
  const categoryByUuid = new Map<string, WireUpsertCategory>();

  const parseCategory = (entries: WireItem[], category: WireUpsertCategory): void => {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      let flat: ReturnType<typeof itemNodeToItems>;
      try {
        flat = itemNodeToItems(wireItemNode(entry.sexpr), entry.parent);
      } catch (error) {
        if (error instanceof NoWireItemError) {
          skipped.push({ wire: entry, error });
          continue;
        }
        throw new Error(
          `itemsWireToDelta: invalid ${category}[${index}] s-expression/item: ${String(error)}`,
        );
      }

      for (const uuid of Object.keys(flat.items)) {
        const previous = categoryByUuid.get(uuid);
        if (previous !== undefined) {
          const relation = previous === category ? `duplicate ${category}` : `${previous} and ${category}`;
          throw new Error(
            `itemsWireToDelta: uuid ${JSON.stringify(uuid)} appears in incompatible/duplicate operation categories (${relation})`,
          );
        }
        categoryByUuid.set(uuid, category);
      }
      upserts.push({ wire: entry, category, ...flat });
    }
  };

  parseCategory(wire.added, "added");
  parseCategory(wire.changed, "changed");

  return { upserts, categoryByUuid, skipped };
}

/**
 * Convert a bridge items-wire delta into a `KicadDelta` against the `current`
 * item set (typically the Y.Doc's items). Pure; exact subtree reconciliation:
 * a changed footprint whose pad disappeared yields `removed: [that pad]`.
 *
 * A syntactically valid entry with no item is SKIPPED (reported via `onSkip`):
 * pcbnew's board writer emits
 * nothing for a standalone child (`case PCB_FIELD_T: break;` — a field is its
 * footprint's content, and `default:` is a release no-op wxFAIL_MSG), so an
 * unlifted child reaching the sender's serializer yields an item-less board
 * envelope. Throwing on it discarded every OTHER entry in the message — after
 * the sender had already rebaselined, so the lost items could never be re-sent.
 * The empty envelope itself carries nothing, so skipping it is lossless.
 * Malformed syntax, an ambiguous multi-item payload, duplicate upserts, and a
 * uuid in incompatible operation categories reject the complete batch before
 * any delta is returned.
 */
export function itemsWireToDelta(
  wire: ItemsWireDelta,
  current: Record<string, KicadItem>,
  onSkip?: WireSkipHandler,
): KicadDelta {
  const delta = emptyKicadDelta();
  const children = childrenIndex(current); // once per conversion, not per item (opt 12)
  const { upserts, categoryByUuid, skipped } = parseWireUpserts(wire);

  const explicitRemoved = new Set<string>();
  const removedClosure = new Set<string>();
  for (const uuid of wire.removed) {
    if (explicitRemoved.has(uuid)) {
      throw new Error(
        `itemsWireToDelta: duplicate uuid ${JSON.stringify(uuid)} in removed category`,
      );
    }
    explicitRemoved.add(uuid);
    removedClosure.add(uuid);
    for (const child of descendantsFrom(children, uuid)) removedClosure.add(child);
  }
  for (const uuid of removedClosure) {
    const category = categoryByUuid.get(uuid);
    if (category !== undefined) {
      throw new Error(
        `itemsWireToDelta: uuid ${JSON.stringify(uuid)} appears in incompatible operation categories (${category} and removed)`,
      );
    }
  }

  const removals = new Set<string>();
  for (const { uuid, items } of upserts) {
    // Previous subtree members (known to `current`) that the new flatten no
    // longer contains have been deleted inside this item.
    const stale = new Set(
      [uuid, ...descendantsFrom(children, uuid)].filter((id) => Object.hasOwn(current, id)),
    );
    for (const [id, item] of Object.entries(items)) {
      const old = current[id];
      if (!old) delta.added.push({ uuid: id, ...item });
      else if (!sameKicadItem(old, item)) delta.updated.push({ uuid: id, ...item });
      stale.delete(id);
    }
    for (const id of stale) removals.add(id);
  }
  for (const id of removedClosure) removals.add(id);

  for (const uuid of removals) {
    const category = categoryByUuid.get(uuid);
    if (category !== undefined) {
      throw new Error(
        `itemsWireToDelta: uuid ${JSON.stringify(uuid)} resolves to incompatible ${category} and removed categories`,
      );
    }
  }
  delta.removed = [...removals].sort();
  // Emit recoverable skips only once every rejecting preflight and semantic
  // category check has passed.  A rejected batch has no successful-prefix
  // callback side effects either.
  for (const entry of skipped) onSkip?.(entry.wire, entry.error);
  return delta;
}

/**
 * Every uuid a wire's added/changed sexprs carry (the items plus their nested
 * subtrees). The diff-on-rebind adopt uses this to find doc-only items.
 *
 * Item-less entries are skipped like `itemsWireToDelta`'s; malformed or
 * ambiguous entries and duplicate/incompatible upsert categories reject.
 */
export function wireItemUuids(wire: ItemsWireDelta, onSkip?: WireSkipHandler): Set<string> {
  const out = new Set<string>();
  const { upserts, skipped } = parseWireUpserts(wire);
  for (const { items } of upserts) {
    for (const id of Object.keys(items)) out.add(id);
  }
  for (const entry of skipped) onSkip?.(entry.wire, entry.error);
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
