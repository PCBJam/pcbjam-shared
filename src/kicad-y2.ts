/**
 * y-s-expr v2 — keyed slot maps (ysync 0009). The NODE CODEC under `kicad-y.ts`:
 * how one s-expr node's ordered children are stored as a Y.Map so that
 * different-field edits of one item MERGE (v1 LWW-dropped them) and gc-off
 * retained growth per edit is ~the changed fields, not the whole body.
 *
 * Encoding (design doc §3.2) — an item's `body` is a NODE MAP whose keys are
 * IDENTITIES, never positions:
 *
 *   `#atom#<id>`     verbatim atom string           (positional atom)
 *   `<kind>#<id>`    node map (Y.Map) OR atomic     (`(kind …)` child; leaves
 *                    leaf (plain Slot[] JSON)        keep the v1 Slot[] shape)
 *   `#item#<uuid>`   1 (key carries the identity)   (hoisted child item ref)
 *   `#attr_order`    Y.Array of the above keys      (order HINT, see below)
 *
 * `#` is reserved: s-expr heads are grammar tokens and cannot contain it; the
 * writer throws on a head containing `#` (loud beats key confusion). Ids are
 * never interpreted — position resolves through `#attr_order`, gaps are normal.
 *
 * Identity rules (§3.3, with two guards the locked doc's §3.6 table forces):
 *   1. `{item}` refs → the child's uuid.
 *   2. keyword child → its UNQUOTED first atom, but ONLY when that atom is
 *      non-numeric AND the kind repeats (≥2 same-kind siblings) AND it is
 *      unique among them (`property#Reference`, stackup `layer#F.Cu`).
 *      Guards rationale: a value-like first atom (`(xy 1 2)`, `(type solid)`)
 *      would make the key change on every edit — concurrent edits of the same
 *      slot would then keep BOTH keys (the duplication anomaly §3.6 designs
 *      out) instead of LWW. A single child of its kind matches positionally,
 *      which is stable under value edits, so identity buys nothing there.
 *   3. otherwise → smallest positive integer above every numeric id present
 *      for that kind (live keys ∪ `#attr_order` entries). Never renumbered.
 *
 * `#attr_order` is a hint, never membership truth. Read normalization: first
 * occurrence of a key wins, entries absent from the map are skipped, map keys
 * missing from the list append at the end in sorted order. Entries are identity
 * tokens (never edited in place), so the only Y.Array anomalies possible are
 * duplicates and stale entries — both neutralized by the read rules.
 *
 * Classification (§3.5): children all atoms AND count ≤ 8 → atomic leaf
 * (tuples: `at`, `xy`, `size`, … — never merge half a coordinate); everything
 * else → node map. Force-atomic override table for heads where element mixing
 * is dangerous (`filled_polygon`) or pointless (`net`). An EXISTING slot's
 * representation is sticky — the classifier only shapes newly created slots —
 * so table/version skew between clients is churn-free. Misclassification is
 * never a correctness bug: losslessness and convergence hold for any cut.
 */

import * as Y from "yjs";
import type { Slot } from "./kicad-doc.js";
import { unquoteAtom } from "./kicad-doc.js";

// ── Version constants (§5) ────────────────────────────────────────────────────

/** `kdoc_meta` key holding the doc's s-expr encoding version. */
export const Y_KDOC_SEXPR_VERSION = "sexprVersion";
export const SEXPR_VERSION_CURRENT = 2;
export const SEXPR_VERSION_SUPPORTED: readonly number[] = [1, 2];

// ── Key vocabulary ────────────────────────────────────────────────────────────

export const ATTR_ORDER_KEY = "#attr_order";
const ATOM_KIND = "#atom";
const ITEM_KIND = "#item";
const ATOM_PREFIX = "#atom#";
const ITEM_PREFIX = "#item#";

/** A v2 body node (item body or nested `(k …)` child stored as a map). */
export type YNode = Y.Map<unknown>;

/** `#item#<uuid>` key for a hoisted child ref (exported for prune/tests). */
export function itemRefKey(uuid: string): string {
  return ITEM_PREFIX + uuid;
}

/** The kind a key belongs to (`at#1` → `at`, `#atom#3` → `#atom`). */
function keyKind(key: string): string {
  if (key.startsWith(ATOM_PREFIX)) return ATOM_KIND;
  if (key.startsWith(ITEM_PREFIX)) return ITEM_KIND;
  const at = key.indexOf("#");
  return at < 0 ? key : key.slice(0, at);
}

/** The id part of a key (`at#1` → `1`); never interpreted beyond numeric-ness. */
function keyId(key: string): string {
  if (key.startsWith(ATOM_PREFIX)) return key.slice(ATOM_PREFIX.length);
  if (key.startsWith(ITEM_PREFIX)) return key.slice(ITEM_PREFIX.length);
  const at = key.indexOf("#");
  return at < 0 ? "" : key.slice(at + 1);
}

const INTEGER_ID = /^\d+$/;

/** Numeric-literal shape — atoms that look like values, not identifiers. */
const NUMERIC_ATOM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

// ── Classification (§3.5) ─────────────────────────────────────────────────────

/**
 * Force-atomic heads: element mixing is dangerous (`filled_polygon` is
 * regenerated wholesale — merging fragments of two fills is actively wrong) or
 * pointless (`net`: the root table is FROZEN from sync — `syncLayoutToY`).
 * Lives here next to that precedent; add tuning rows as measurements demand.
 */
export const FORCE_ATOMIC_HEADS: ReadonlySet<string> = new Set(["filled_polygon", "net"]);

const TUPLE_LEAF_MAX_ATOMS = 8;

function isAtomicLeaf(kind: string, v: Slot[], overrides: ReadonlySet<string>): boolean {
  if (overrides.has(kind)) return true;
  return v.length <= TUPLE_LEAF_MAX_ATOMS && v.every((s) => "atom" in s);
}

// ── Identity assignment (§3.3) ────────────────────────────────────────────────

interface KeyedSlot {
  key: string;
  slot: Slot;
  /** true when this (key, slot) pair matched an existing map entry. */
  matched: boolean;
}

function assertKindSafe(kind: string): void {
  if (kind.includes("#")) {
    throw new Error(`kicad-y2: s-expr head contains reserved '#': ${JSON.stringify(kind)}`);
  }
}

/**
 * The identity-atom id for each slot index of `slots`, or undefined where rule
 * 2 does not apply (see header: non-numeric + repeated kind + unique).
 */
function identityIds(slots: Slot[]): Array<string | undefined> {
  const byKind = new Map<string, number[]>();
  slots.forEach((s, i) => {
    if (!("k" in s)) return;
    const list = byKind.get(s.k) ?? [];
    list.push(i);
    byKind.set(s.k, list);
  });

  const ids = new Array<string | undefined>(slots.length);
  for (const indices of byKind.values()) {
    if (indices.length < 2) continue; // single child → positional (stable under value edits)
    const firstAtoms = indices.map((i) => {
      const s = slots[i]! as { k: string; v: Slot[] };
      const first = s.v[0];
      if (!first || !("atom" in first)) return undefined;
      const id = unquoteAtom(first.atom);
      return id === "" || NUMERIC_ATOM.test(id) ? undefined : id;
    });
    const counts = new Map<string, number>();
    for (const a of firstAtoms) {
      if (a !== undefined) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    indices.forEach((slotIdx, j) => {
      const a = firstAtoms[j];
      if (a !== undefined && counts.get(a) === 1) ids[slotIdx] = a;
    });
  }
  return ids;
}

/**
 * Per-kind allocator for rule-3 integer ids: starts above every numeric id
 * present for that kind in the live keys ∪ `#attr_order` entries (so a deleted
 * key's id is never reused while its order entry survives), monotonic within
 * one write.
 */
function numericAllocator(node: YNode | null): (kind: string) => string {
  const max = new Map<string, number>();
  const consider = (key: string) => {
    const id = keyId(key);
    if (!INTEGER_ID.test(id)) return;
    const kind = keyKind(key);
    const n = parseInt(id, 10);
    if (n > (max.get(kind) ?? 0)) max.set(kind, n);
  };
  if (node) {
    node.forEach((_v, key) => {
      if (key !== ATTR_ORDER_KEY) consider(key);
    });
    const order = node.get(ATTR_ORDER_KEY);
    if (order instanceof Y.Array) {
      for (const entry of order.toArray()) {
        if (typeof entry === "string") consider(entry);
      }
    }
  }
  return (kind: string): string => {
    const next = (max.get(kind) ?? 0) + 1;
    max.set(kind, next);
    return String(next);
  };
}

/**
 * Assign every slot of a new body its key, matching against `node`'s existing
 * keys by identity: `{item}` refs by uuid, identity-atom kinds by their atom,
 * everything else by k-th same-kind occurrence among the existing INTEGER-id
 * keys in normalized order (identity ids are never integer-shaped — rule 2's
 * numeric guard — so the pools cannot collide). Unmatched new slots get fresh
 * rule-3 ids. Pass `node = null` for a fresh build (nothing to match).
 */
function keySlots(slots: Slot[], node: YNode | null): KeyedSlot[] {
  const identity = identityIds(slots);
  const alloc = numericAllocator(node);

  // Existing positional pools: kind → integer-id keys in normalized order.
  const pools = new Map<string, string[]>();
  if (node) {
    for (const key of normalizedKeys(node)) {
      if (!INTEGER_ID.test(keyId(key))) continue;
      const kind = keyKind(key);
      const pool = pools.get(kind) ?? [];
      pool.push(key);
      pools.set(kind, pool);
    }
  }
  const poolCursor = new Map<string, number>();
  const takePositional = (kind: string): string | undefined => {
    const pool = pools.get(kind);
    const at = poolCursor.get(kind) ?? 0;
    if (!pool || at >= pool.length) return undefined;
    poolCursor.set(kind, at + 1);
    return pool[at];
  };

  return slots.map((slot, i): KeyedSlot => {
    if ("item" in slot) {
      const key = itemRefKey(slot.item);
      return { key, slot, matched: node?.has(key) ?? false };
    }
    if ("atom" in slot) {
      const existing = takePositional(ATOM_KIND);
      if (existing) return { key: existing, slot, matched: true };
      return { key: ATOM_PREFIX + alloc(ATOM_KIND), slot, matched: false };
    }
    assertKindSafe(slot.k);
    const id = identity[i];
    if (id !== undefined) {
      const key = `${slot.k}#${id}`;
      return { key, slot, matched: node?.has(key) ?? false };
    }
    const existing = takePositional(slot.k);
    if (existing) return { key: existing, slot, matched: true };
    return { key: `${slot.k}#${alloc(slot.k)}`, slot, matched: false };
  });
}

// ── Encode: Slot[] → node map ─────────────────────────────────────────────────

function encodeChild(slot: Slot, overrides: ReadonlySet<string>): unknown {
  if ("atom" in slot) return slot.atom;
  if ("item" in slot) return 1;
  return isAtomicLeaf(slot.k, slot.v, overrides) ? slot.v : nodeFromSlots(slot.v, overrides);
}

/** Build a fresh (preliminary) node map from a body's slots. */
export function nodeFromSlots(
  slots: Slot[],
  overrides: ReadonlySet<string> = FORCE_ATOMIC_HEADS,
): YNode {
  const node = new Y.Map<unknown>();
  const keyed = keySlots(slots, null);
  for (const { key, slot } of keyed) {
    node.set(key, encodeChild(slot, overrides));
  }
  const order = new Y.Array<string>();
  order.push(keyed.map((k) => k.key));
  node.set(ATTR_ORDER_KEY, order);
  return node;
}

// ── Decode: node map → Slot[] (§3.4 read normalization) ───────────────────────

/**
 * The node's child keys in render order: `#attr_order` deduped (first
 * occurrence wins), entries absent from the map skipped, map keys missing from
 * the list appended in sorted order.
 */
function normalizedKeys(node: YNode): string[] {
  const order = node.get(ATTR_ORDER_KEY);
  const seen = new Set<string>();
  const keys: string[] = [];
  if (order instanceof Y.Array) {
    for (const entry of order.toArray()) {
      if (typeof entry !== "string" || entry === ATTR_ORDER_KEY || seen.has(entry)) continue;
      seen.add(entry);
      if (node.has(entry)) keys.push(entry);
    }
  }
  const missing: string[] = [];
  node.forEach((_v, key) => {
    if (key !== ATTR_ORDER_KEY && !seen.has(key)) missing.push(key);
  });
  missing.sort();
  keys.push(...missing);
  return keys;
}

function decodeChild(key: string, value: unknown): Slot {
  if (key.startsWith(ATOM_PREFIX)) return { atom: String(value) };
  if (key.startsWith(ITEM_PREFIX)) return { item: key.slice(ITEM_PREFIX.length) };
  const kind = keyKind(key);
  if (value instanceof Y.Map) return { k: kind, v: slotsFromNode(value) };
  return { k: kind, v: (value as Slot[]) ?? [] };
}

/** Materialize a node map back into the v1-identical plain `Slot[]`. */
export function slotsFromNode(node: YNode): Slot[] {
  return normalizedKeys(node).map((key) => decodeChild(key, node.get(key)));
}

// ── The v2 differ: write a new body into an existing node ─────────────────────

/**
 * Diff `slots` (the item's new body) into `node` in place: matched children
 * update (atoms/leaves replace on change, child node maps recurse), unmatched
 * existing keys delete, unmatched new slots create (classifier applies to
 * NEW slots only — an existing slot's representation is sticky). `#attr_order`
 * is maintained incrementally; if the incremental result would not render in
 * the new body's exact order (e.g. a pure reorder), it is rewritten wholesale.
 * Must run inside a `ydoc.transact`. Alignment degradation is always "replace
 * the slot wholesale" — never corruption.
 */
export function updateNodeFromSlots(
  node: YNode,
  slots: Slot[],
  overrides: ReadonlySet<string> = FORCE_ATOMIC_HEADS,
): void {
  const keyed = keySlots(slots, node);
  const targetKeys = keyed.map((k) => k.key);
  const targetSet = new Set(targetKeys);

  // Deletions first: unmatched existing keys (frees their order entries).
  const toDelete: string[] = [];
  node.forEach((_v, key) => {
    if (key !== ATTR_ORDER_KEY && !targetSet.has(key)) toDelete.push(key);
  });
  for (const key of toDelete) node.delete(key);

  // Updates / creations.
  for (const { key, slot, matched } of keyed) {
    if (!matched) {
      node.set(key, encodeChild(slot, overrides));
      continue;
    }
    const existing = node.get(key);
    if ("atom" in slot) {
      if (existing !== slot.atom) node.set(key, slot.atom);
    } else if ("k" in slot) {
      if (existing instanceof Y.Map) {
        updateNodeFromSlots(existing, slot.v, overrides); // sticky: stays a node map
      } else if (JSON.stringify(existing) !== JSON.stringify(slot.v)) {
        node.set(key, slot.v); // sticky: stays an atomic leaf
      }
    }
    // {item} refs carry identity in the key; the value never changes.
  }

  updateAttrOrder(node, targetKeys, toDelete, keyed);
}

function updateAttrOrder(
  node: YNode,
  targetKeys: string[],
  deletedKeys: string[],
  keyed: KeyedSlot[],
): void {
  let order = node.get(ATTR_ORDER_KEY);
  if (!(order instanceof Y.Array)) {
    const fresh = new Y.Array<string>();
    fresh.push(targetKeys);
    node.set(ATTR_ORDER_KEY, fresh);
    return;
  }

  // Remove entries for deleted keys (reverse keeps indices valid).
  const deleted = new Set(deletedKeys);
  if (deleted.size) {
    for (let i = order.length - 1; i >= 0; i--) {
      const entry = order.get(i);
      if (typeof entry === "string" && deleted.has(entry)) order.delete(i, 1);
    }
  }

  // Insert each newly created key right after its target predecessor, so a
  // concurrent peer's structural insert lands at ITS intended position too
  // (the point of the Y.Array hint — §3.4). `mirror` tracks our local view.
  const mirror = order.toArray().filter((e): e is string => typeof e === "string");
  const created = new Set(keyed.filter((k) => !k.matched).map((k) => k.key));
  targetKeys.forEach((key, i) => {
    if (!created.has(key)) return;
    let pos: number;
    if (i === 0) {
      pos = 0;
    } else {
      const anchor = mirror.indexOf(targetKeys[i - 1]!);
      pos = anchor < 0 ? mirror.length : anchor + 1;
    }
    order.insert(pos, [key]);
    mirror.splice(pos, 0, key);
  });

  // Verify the read rules over the final state render the target order; a
  // mismatch (pure reorder, stale-entry interference) → wholesale rewrite.
  if (!sameOrder(normalizedKeys(node), targetKeys)) {
    order.delete(0, order.length);
    order.insert(0, targetKeys);
  }
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Item-ref pruning (applyDeltaToY's dangling-parent guard, v2 flavor) ───────

/**
 * Deep-remove the `#item#<uuid>` ref from a node (and its descendants — nested
 * field node maps AND atomic leaves, which can legally hold `{item}` slots when
 * an override head forced a uuid-bearing child atomic). Returns true when
 * anything changed. Must run inside a `ydoc.transact`.
 */
export function pruneItemRefFromNode(
  node: YNode,
  uuid: string,
  pruneLeaf: (slots: Slot[], uuid: string) => Slot[] | null,
): boolean {
  let changed = false;
  const refKey = itemRefKey(uuid);
  const keys: string[] = [];
  node.forEach((_v, key) => keys.push(key));
  for (const key of keys) {
    if (key === ATTR_ORDER_KEY) continue;
    if (key === refKey) {
      node.delete(key);
      const order = node.get(ATTR_ORDER_KEY);
      if (order instanceof Y.Array) {
        for (let i = order.length - 1; i >= 0; i--) {
          if (order.get(i) === key) order.delete(i, 1);
        }
      }
      changed = true;
      continue;
    }
    const value = node.get(key);
    if (value instanceof Y.Map) {
      if (pruneItemRefFromNode(value, uuid, pruneLeaf)) changed = true;
    } else if (Array.isArray(value)) {
      const pruned = pruneLeaf(value as Slot[], uuid);
      if (pruned) {
        node.set(key, pruned);
        changed = true;
      }
    }
  }
  return changed;
}
