/**
 * KiCad file ⇄ Y.Doc representation (ysync 0007) — MIT, pure text.
 *
 * A `KicadDoc` is the canonical, CRDT-friendly decomposition of a KiCad s-expr
 * document. Two transforms compose:
 *
 *  1. FLATTEN — every uuid-bearing node, at any depth (a footprint AND each pad /
 *     field, a symbol AND each pin), is hoisted into a flat `items` map keyed by
 *     uuid, with `parent` set to the nearest enclosing item (null at the root).
 *     This is the containment the live wasm bridge drops.
 *
 *  2. STRUCTURE — a node's content becomes an ordered list of `Slot`s instead of an
 *     opaque string. ONE ground rule, applied generically with no per-keyword
 *     knowledge:
 *       - a bare atom → `{ atom }` (kept VERBATIM: "1.6", "0.0000", "\"F.Cu\"",
 *         "signal" — so byte-losslessness and exact float formatting survive);
 *       - a `(key …)` child → `{ k, v: Slot[] }` (recurse);
 *       - a hoisted uuid item → `{ item: uuid }`.
 *     `v`/`body`/`layout` are ORDERED lists where keys are NOT assumed unique, so
 *     every awkward shape falls out for free:
 *       - `(layers (0 …) (4 …) (2 …))` — numeric ids in non-sorted order: the list
 *         order is the file order (no `$order` needed);
 *       - `(stackup (layer …) (layer …))`, repeated `(property …)`, `(pts (xy …) …)`
 *         — repeated keys are just repeated slots;
 *       - `(pad "1" smd roundrect …)` — leading positionals are `{ atom }` slots;
 *       - the SAME keyword with different shapes in different contexts (a pad's
 *         `(layers "F.Cu" "F.Mask")` vs the board's `(layers (0 …) …)`) needs no
 *         special-casing — shape comes from the data.
 *
 * Reconstruction (`docToFile`) renders slots in order, splicing child items by
 * reference, so `docToFile(fileToDoc(text))` reproduces `text` structurally.
 *
 * The `Slot`/value model is verbatim-string-typed on purpose: prettier JS types
 * (numbers, booleans) are a LOSSY view, available on demand via the accessor
 * helpers (`args` / `field` / `fields` / `scalar`) — not the stored form.
 *
 * Y mapping is uniform: `items` → Y.Map; each `body`/`layout`/`v` → Y.Array of slot
 * Y.Maps. Because slot lists are always arrays (never keyed objects), repeated /
 * numeric / ordered cases need no special handling — which is what makes merge
 * predictable and the zod schema below a meaningful post-merge structural check.
 */

import { z } from "zod";
import { directUuid, parseSexpr, type SNode } from "./sexpr.js";

/** One element of a node's content. Discriminated by its key (`atom`/`k`/`item`). */
export type Slot =
  | { atom: string } // a positional atom, verbatim
  | { k: string; v: Slot[] } // a (k …) child field, recursively
  | { item: string }; // a hoisted uuid item, referenced by uuid

export const slotSchema: z.ZodType<Slot> = z.lazy(() =>
  z.union([
    z.object({ atom: z.string() }),
    z.object({ k: z.string(), v: z.array(slotSchema) }),
    z.object({ item: z.string() }),
  ]),
);

export const kicadItemSchema = z.object({
  /** Head keyword of the item's s-expr (e.g. "footprint", "pad", "pin", "wire"). */
  type: z.string(),
  /** uuid of the enclosing item, or null when the item sits at the document root. */
  parent: z.string().nullable(),
  /** Ordered content slots (the item's own (uuid …) is a `{ k: "uuid" }` slot). */
  body: z.array(slotSchema),
});
export type KicadItem = z.infer<typeof kicadItemSchema>;

export const kicadDocSchema = z.object({
  /** Top-level form name, e.g. "kicad_pcb" / "kicad_sch" / "kicad_wks". */
  root: z.string(),
  /** uuid → item. Every uuid in the file, flattened. */
  items: z.record(z.string(), kicadItemSchema),
  /** Ordered content slots of the document root form. */
  layout: z.array(slotSchema),
});
export type KicadDoc = z.infer<typeof kicadDocSchema>;

// ── Fast structural validation ───────────────────────────────────────────────
// Hand-rolled equivalent of `kicadDocSchema.parse` for the conversion hot
// paths: the zod walk of the recursive slot union costs ~800ms on a 3k-item
// board (~50× the actual render), which is what blew the Workers CPU limit on
// GET /files/*. Same shape checks, no copy; zod stays at the wire boundaries.

function assertSlots(slots: unknown, path: string): void {
  if (!Array.isArray(slots)) {
    throw new Error(`invalid KicadDoc: ${path} is not a slot array`);
  }
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] as Record<string, unknown> | null;
    if (typeof s !== "object" || s === null) {
      throw new Error(`invalid KicadDoc: ${path}[${i}] is not a slot object`);
    }
    if ("atom" in s) {
      if (typeof s.atom !== "string") {
        throw new Error(`invalid KicadDoc: ${path}[${i}].atom is not a string`);
      }
    } else if ("item" in s) {
      if (typeof s.item !== "string") {
        throw new Error(`invalid KicadDoc: ${path}[${i}].item is not a string`);
      }
    } else if ("k" in s) {
      if (typeof s.k !== "string") {
        throw new Error(`invalid KicadDoc: ${path}[${i}].k is not a string`);
      }
      assertSlots(s.v, `${path}[${i}].v`);
    } else {
      throw new Error(`invalid KicadDoc: ${path}[${i}] is not an atom/field/item slot`);
    }
  }
}

/** Validate one item's structure (same checks as `kicadItemSchema.parse`, no copy). */
export function assertKicadItem(item: KicadItem, path = "item"): void {
  if (typeof item !== "object" || item === null) {
    throw new Error(`invalid KicadDoc: ${path} is not an object`);
  }
  if (typeof item.type !== "string") {
    throw new Error(`invalid KicadDoc: ${path}.type is not a string`);
  }
  if (item.parent !== null && typeof item.parent !== "string") {
    throw new Error(`invalid KicadDoc: ${path}.parent is not string|null`);
  }
  assertSlots(item.body, `${path}.body`);
}

/**
 * Validate a whole doc's structure (same checks as `kicadDocSchema.parse`, no
 * copy — returns `doc` itself). Throws with a path on the first violation.
 */
export function assertKicadDoc(doc: KicadDoc): KicadDoc {
  if (typeof doc !== "object" || doc === null) {
    throw new Error("invalid KicadDoc: not an object");
  }
  if (typeof doc.root !== "string") {
    throw new Error("invalid KicadDoc: root is not a string");
  }
  if (typeof doc.items !== "object" || doc.items === null || Array.isArray(doc.items)) {
    throw new Error("invalid KicadDoc: items is not a record");
  }
  for (const uuid of Object.keys(doc.items)) {
    assertKicadItem(doc.items[uuid]!, `items[${uuid}]`);
  }
  assertSlots(doc.layout, "layout");
  return doc;
}

// ── Parse: file text → KicadDoc ──────────────────────────────────────────────

/** uuid of a list `(<keyword> … (uuid "X") …)`, else null. */
function itemUuid(node: SNode): string | null {
  if (!Array.isArray(node) || typeof node[0] !== "string") return null;
  return directUuid(node);
}

/** Turn a node's children into slots, hoisting uuid items into `items`. */
function parseSlots(
  children: SNode[],
  parent: string | null,
  items: Record<string, KicadItem>,
): Slot[] {
  const slots: Slot[] = [];
  for (const child of children) {
    if (typeof child === "string") {
      slots.push({ atom: child });
      continue;
    }
    const id = itemUuid(child);
    // Hoist a uuid node — unless its uuid is already taken (a malformed duplicate /
    // self-reference), in which case keep it inline as a field, preserving losslessness.
    if (id !== null && !(id in items)) {
      extractItem(child, id, parent, items);
      slots.push({ item: id });
      continue;
    }
    const head = child[0];
    if (typeof head !== "string") {
      throw new Error("parseSlots: encountered a list child without a head atom");
    }
    // `#` is the v2 keyed-slot separator (ysync 0009 §3.2); s-expr heads are
    // unquoted grammar tokens and can never contain it — reject loudly here
    // (the seed boundary) rather than risk key confusion in the Y encoding.
    if (head.includes("#")) {
      throw new Error(`parseSlots: head contains reserved '#': ${JSON.stringify(head)}`);
    }
    // A non-item child stays in place as a field; its descendants keep the same
    // nearest-item parent (a field is not an item).
    slots.push({ k: head, v: parseSlots(child.slice(1), parent, items) });
  }
  return slots;
}

/** Register `node` (a uuid list) and its descendants into `items`. */
function extractItem(
  node: SNode[],
  uuid: string,
  parent: string | null,
  items: Record<string, KicadItem>,
): void {
  const type = typeof node[0] === "string" ? node[0] : "";
  const item: KicadItem = { type, parent, body: [] };
  items[uuid] = item; // reserve before recursing so deeper duplicates are detected
  item.body = parseSlots(node.slice(1), uuid, items);
}

/**
 * Decompose KiCad s-expr text into a flattened, structured `KicadDoc`. Throws if
 * `text` is not a single top-level `(<root> …)` form.
 */
export function fileToDoc(text: string): KicadDoc {
  const forms = parseSexpr(text);
  if (forms.length !== 1 || !Array.isArray(forms[0])) {
    throw new Error("fileToDoc: expected exactly one top-level (…) form");
  }
  const root = forms[0] as SNode[];
  const name = root[0];
  if (typeof name !== "string") {
    throw new Error("fileToDoc: root form has no leading name atom");
  }

  const items: Record<string, KicadItem> = {};
  const layout = parseSlots(root.slice(1), null, items);

  return assertKicadDoc({ root: name, items, layout });
}

/**
 * Parse ONE item's s-expr — e.g. what the live bridge emits for a changed
 * footprint — into its flattened items: the item itself plus every nested uuid
 * descendant (pads, fields, pins), each with correct `parent` links. `parent` is
 * the uuid of the enclosing item in the target doc (null for a root-level item).
 *
 * Inverse of `renderItem`: `renderItem({ items }, uuid)` reproduces the s-expr
 * structurally.
 */
export function sexprToItems(
  text: string,
  parent: string | null = null,
): { uuid: string; items: Record<string, KicadItem> } {
  const forms = parseSexpr(text);
  if (forms.length !== 1 || !Array.isArray(forms[0])) {
    throw new Error("sexprToItems: expected exactly one top-level (…) form");
  }
  const node = forms[0] as SNode[];
  const uuid = itemUuid(node);
  if (uuid === null) {
    throw new Error("sexprToItems: form carries no direct (uuid …) — not an item");
  }
  const items: Record<string, KicadItem> = {};
  extractItem(node, uuid, parent, items);
  return { uuid, items };
}

// ── Render: KicadDoc → file text ─────────────────────────────────────────────

function renderSlots(
  slots: Slot[],
  items: Record<string, KicadItem>,
  seen: Set<string>,
): string {
  return slots.map((s) => renderSlot(s, items, seen)).join(" ");
}

function renderSlot(
  slot: Slot,
  items: Record<string, KicadItem>,
  seen: Set<string>,
): string {
  if ("atom" in slot) return slot.atom;
  if ("item" in slot) return renderItemInner(items, slot.item, seen);
  return slot.v.length ? `(${slot.k} ${renderSlots(slot.v, items, seen)})` : `(${slot.k})`;
}

function renderItemInner(
  items: Record<string, KicadItem>,
  uuid: string,
  seen: Set<string>,
): string {
  if (seen.has(uuid)) throw new Error(`renderItem: cycle through item ${uuid}`);
  const item = items[uuid];
  if (!item) throw new Error(`renderItem: missing item ${uuid}`);
  seen.add(uuid);
  const inner = renderSlots(item.body, items, seen);
  seen.delete(uuid);
  return inner.length ? `(${item.type} ${inner})` : `(${item.type})`;
}

/** Render a single item (and its nested items) back to s-expr text. */
export function renderItem(doc: Pick<KicadDoc, "items">, uuid: string): string {
  return renderItemInner(doc.items, uuid, new Set());
}

/**
 * Top-level `(k …)` forms KiCad writes at most ONCE per file. Two concurrent
 * whole-layout writers (a layout-only save-sync racing a file seed — ysync
 * 0011) merge into a layout carrying the header block twice; KiCad's lexer
 * rejects the second `(version …)` outright ("Expecting … Got version"). Every
 * renderer keeps the FIRST occurrence of these; `repairLayoutY` deletes the
 * rest from the shared doc so it converges to one.
 */
export const SINGLETON_HEADS: ReadonlySet<string> = new Set([
  "version",
  "generator",
  "generator_version",
  "uuid",
  "paper",
  "page",
  "title_block",
  "lib_symbols",
  "sheet_instances",
  "symbol_instances",
  "embedded_fonts",
  "embedded_files",
  "general",
  "layers",
  "setup",
]);

/** Singleton heads KiCad writes AFTER the items (everything else precedes them). */
const TRAILER_HEADS: ReadonlySet<string> = new Set(["sheet_instances", "symbol_instances"]);

/**
 * Indices of top-level slots that are a REPEAT of a singleton head — the
 * ones to drop. Empty for a well-formed layout.
 *
 * Which copy survives is chosen by KiCad's own file order, not by Y.Array
 * position (a merge orders the two writers' blocks by clientID, so either
 * block can come first): a header head keeps its last occurrence BEFORE the
 * first item slot (the copy that belongs to the block carrying the items —
 * KiCad's lexer rejects a `(version …)` after items), a trailer head keeps
 * its last occurrence overall. Deterministic across peers, so concurrent
 * repairs delete the same entries.
 */
export function duplicateSingletonHeadIndices(slots: readonly Slot[]): number[] {
  // A DOUBLE SEED in flight (bug 06: two clients seeded one fresh room) also
  // carries every header twice — but each copy belongs to a whole block that
  // seedNonce LWW arbitration retracts as a unit. Repairing here would delete
  // one header copy by position and the retractor the other, leaving NO
  // header when the loser is the earlier block. A double seed is the only
  // merge that repeats item slots, so leave it to the arbitration.
  const seenItems = new Set<string>();
  for (const s of slots) {
    if (!("item" in s)) continue;
    if (seenItems.has(s.item)) return [];
    seenItems.add(s.item);
  }
  const firstItem = slots.findIndex((s) => "item" in s);
  const keep = new Map<string, number>();
  const all = new Map<string, number[]>();
  slots.forEach((s, i) => {
    if (!("k" in s) || !SINGLETON_HEADS.has(s.k)) return;
    const list = all.get(s.k) ?? [];
    list.push(i);
    all.set(s.k, list);
    const beforeItems = firstItem < 0 || i < firstItem;
    if (TRAILER_HEADS.has(s.k) || beforeItems || !keep.has(s.k)) keep.set(s.k, i);
  });
  const dups: number[] = [];
  for (const [k, idxs] of all) {
    if (idxs.length < 2) continue;
    const kept = keep.get(k)!;
    for (const i of idxs) if (i !== kept) dups.push(i);
  }
  return dups.sort((x, y) => x - y);
}

/** Reassemble KiCad s-expr text from a `KicadDoc`, in `layout` order. */
export function docToFile(doc: KicadDoc): string {
  assertKicadDoc(doc);
  const dups = new Set(duplicateSingletonHeadIndices(doc.layout));
  const layout = dups.size ? doc.layout.filter((_, i) => !dups.has(i)) : doc.layout;
  const inner = renderSlots(layout, doc.items, new Set());
  return inner.length ? `(${doc.root} ${inner})` : `(${doc.root})`;
}

// ── lib_symbols helpers (miss 08: embedded library definitions) ──────────────

/** Strip surrounding quotes from a verbatim atom ("\"Device:R\"" → "Device:R"). */
export function unquoteAtom(atom: string): string {
  return atom.length >= 2 && atom.startsWith('"') && atom.endsWith('"')
    ? atom.slice(1, -1)
    : atom;
}

/** Render one slot back to s-expr text ({item} refs resolve through `items`). */
export function renderSlotText(
  slot: Slot,
  items: Record<string, KicadItem> = {},
): string {
  return renderSlot(slot, items, new Set());
}

/**
 * Parse ONE `(k …)` form into a field slot. Any uuid-bearing descendants hoist
 * into `items` exactly like `fileToDoc` would (library definitions carry none in
 * practice, but losslessness must not depend on that).
 */
export function slotFromSexpr(text: string, items: Record<string, KicadItem>): Slot {
  const forms = parseSexpr(text);
  if (forms.length !== 1 || !Array.isArray(forms[0])) {
    throw new Error("slotFromSexpr: expected exactly one (…) form");
  }
  const node = forms[0] as SNode[];
  const head = node[0];
  if (typeof head !== "string") {
    throw new Error("slotFromSexpr: form has no leading name atom");
  }
  return { k: head, v: parseSlots(node.slice(1), null, items) };
}

/**
 * The embedded library definitions of a layout's `(lib_symbols …)` slot, keyed
 * by lib id ("Device:R"), each rendered to its `(symbol …)` definition text.
 */
export function libSymbolsFromLayout(
  layout: Slot[],
  items: Record<string, KicadItem>,
): Record<string, string> {
  const defs: Record<string, string> = {};
  for (const slot of layout) {
    if (!("k" in slot) || slot.k !== "lib_symbols") continue;
    for (const def of slot.v) {
      if (!("k" in def) || def.k !== "symbol") continue;
      const id = args(def.v)[0];
      if (id) defs[unquoteAtom(id)] = renderSlotText(def, items);
    }
  }
  return defs;
}

// ── Accessors: ergonomic (lossy) reads over slot lists ───────────────────────

/** The positional atoms of a slot list, verbatim, in order. */
export function args(slots: Slot[]): string[] {
  return slots.flatMap((s) => ("atom" in s ? [s.atom] : []));
}

/** The value of the FIRST field named `k`, or undefined. */
export function field(slots: Slot[], k: string): Slot[] | undefined {
  for (const s of slots) if ("k" in s && s.k === k) return s.v;
  return undefined;
}

/** The values of EVERY field named `k` (repeated "property" / "layer" / "xy" …). */
export function fields(slots: Slot[], k: string): Slot[][] {
  return slots.flatMap((s) => ("k" in s && s.k === k ? [s.v] : []));
}

/** First positional atom of field `k` — the common scalar read, e.g. (thickness 1.6). */
export function scalar(slots: Slot[], k: string): string | undefined {
  const v = field(slots, k);
  return v ? args(v)[0] : undefined;
}
