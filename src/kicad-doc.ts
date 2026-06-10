/**
 * KiCad file ⇄ Y.Doc representation (ysync 0007) — MIT, pure text.
 *
 * A `KicadDoc` is the canonical, CRDT-friendly decomposition of a KiCad s-expr
 * document. EVERY uuid-bearing node — at any depth — is hoisted into a flat
 * `items` map keyed by its uuid, so a footprint and each of its pads/fields, or a
 * symbol and each of its pins, are independently addressable (and independently
 * mergeable / attributable). Containment is preserved two ways:
 *
 *   - each item carries `parent` (the uuid of the item that contains it, or null
 *     at the document root) — O(1) upward lookup, matches how the live wasm bridge
 *     resolves items by global uuid;
 *   - each item's `body` is the ORDERED list of its children, where a child is
 *     either a `raw` s-expr fragment (a non-item field: layer, at, effects, …) or
 *     an `item` reference to a nested uuid item. `layout` is the same for the
 *     document root's children.
 *
 * Reconstruction (`docToFile`) walks `layout` then each item's `body`, splicing
 * child items back by reference — so `docToFile(fileToDoc(text))` reproduces
 * `text` structurally with no KiCad code and no field-by-field schema mapping.
 *
 * Mapping onto live CRDT types is mechanical: `items` → Y.Map, each `body`/`layout`
 * → Y.Array, each `raw` fragment → Y.Text/string. The `parent` link is exactly the
 * containment the current bridge drops (the cause of the footprint-reconstruction
 * gaps in the standalone-hardening 0004 round trips); flattening with `parent`
 * restores it losslessly.
 */

import { z } from "zod";
import { directUuid, parseSexpr, printSexpr, type SNode } from "./sexpr.js";

export const bodyEntrySchema = z.union([
  z.object({ raw: z.string() }), // a non-item child fragment, verbatim
  z.object({ item: z.string() }), // reference to a nested item by uuid
]);
export type BodyEntry = z.infer<typeof bodyEntrySchema>;

export const kicadItemSchema = z.object({
  /** Head keyword of the item's s-expr (e.g. "footprint", "pad", "pin", "wire"). */
  type: z.string(),
  /** uuid of the containing item, or null when the item sits at the document root. */
  parent: z.string().nullable(),
  /** Ordered children: raw field fragments interleaved with nested item refs. */
  body: z.array(bodyEntrySchema),
});
export type KicadItem = z.infer<typeof kicadItemSchema>;

export const kicadDocSchema = z.object({
  /** Top-level form name, e.g. "kicad_pcb" / "kicad_sch" / "kicad_wks". */
  root: z.string(),
  /** uuid → item. Every uuid in the file, flattened. */
  items: z.record(z.string(), kicadItemSchema),
  /** Ordered children of the document root form. */
  layout: z.array(bodyEntrySchema),
});
export type KicadDoc = z.infer<typeof kicadDocSchema>;

/** Whether a node is an extractable item: a list `(<keyword> … (uuid "X") …)`. */
function itemUuid(node: SNode): string | null {
  if (!Array.isArray(node) || typeof node[0] !== "string") return null;
  return directUuid(node);
}

/** Decompose `node`'s children into body entries, extracting nested items. */
function decomposeChildren(
  children: SNode[],
  selfUuid: string | null,
  items: Record<string, KicadItem>,
): BodyEntry[] {
  const body: BodyEntry[] = [];
  for (const child of children) {
    const id = itemUuid(child);
    // Extract as an item unless its uuid is already taken (a malformed duplicate /
    // self-reference) — then keep it inline as raw, preserving losslessness.
    if (id !== null && !(id in items)) {
      extractItem(child as SNode[], id, selfUuid, items);
      body.push({ item: id });
    } else {
      body.push({ raw: printSexpr(child) });
    }
  }
  return body;
}

/** Register `node` (a uuid list) and its descendants into `items`. */
function extractItem(
  node: SNode[],
  uuid: string,
  parent: string | null,
  items: Record<string, KicadItem>,
): void {
  const type = typeof node[0] === "string" ? node[0] : "";
  // Reserve the uuid before recursing so a deeper duplicate is detected.
  const item: KicadItem = { type, parent, body: [] };
  items[uuid] = item;
  item.body = decomposeChildren(node.slice(1), uuid, items);
}

/**
 * Decompose KiCad s-expr text into a flattened `KicadDoc`. Throws if `text` is not
 * a single top-level `(<root> …)` form.
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
  const layout = decomposeChildren(root.slice(1), null, items);

  return kicadDocSchema.parse({ root: name, items, layout });
}

/** Render a single item (and its nested items) back to s-expr text. */
export function renderItem(
  doc: Pick<KicadDoc, "items">,
  uuid: string,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(uuid)) throw new Error(`renderItem: cycle through item ${uuid}`);
  const item = doc.items[uuid];
  if (!item) throw new Error(`renderItem: missing item ${uuid}`);
  seen.add(uuid);
  const parts = item.body.map((e) =>
    "item" in e ? renderItem(doc, e.item, seen) : e.raw,
  );
  seen.delete(uuid);
  return parts.length ? `(${item.type} ${parts.join(" ")})` : `(${item.type})`;
}

/** Reassemble KiCad s-expr text from a `KicadDoc`, in `layout` order. */
export function docToFile(doc: KicadDoc): string {
  kicadDocSchema.parse(doc);
  const parts = doc.layout.map((entry) =>
    "item" in entry ? renderItem(doc, entry.item) : entry.raw,
  );
  return parts.length ? `(${doc.root} ${parts.join(" ")})` : `(${doc.root})`;
}
