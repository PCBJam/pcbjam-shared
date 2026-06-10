/**
 * KiCad file ⇄ Y.Doc representation (ysync 0007) — MIT, pure text.
 *
 * A `KicadDoc` is the canonical, CRDT-friendly decomposition of a KiCad s-expr
 * document: every top-level item (anything carrying a direct `(uuid "X")`) is an
 * opaque s-expr blob keyed by its uuid, and an ordered `layout` records the exact
 * sequence of the root's children (item references interleaved with non-item
 * "raw" blobs: version, generator, setup, layers, nets, lib_symbols, the document
 * `(uuid …)`, sheet/symbol instances, …).
 *
 * This makes file⇄doc a pure text operation — `docToFile(fileToDoc(text))`
 * reconstructs `text` structurally, with no KiCad code and no field-by-field
 * schema mapping. The `items` map is the unit of concurrent edit; mapping onto
 * live CRDT types is mechanical (`items` → Y.Map, `layout` → Y.Array).
 *
 * v1 keeps a top-level item (e.g. a footprint with its pads/fields) as ONE blob;
 * flattening nested uuid items + scalar overlays for hot fields are future work
 * (see the 0007 design doc).
 */

import { z } from "zod";
import { directUuid, parseSexpr, printSexpr, type SNode } from "./sexpr.js";

export const kicadItemSchema = z.object({
  /** Head keyword of the item's s-expr (e.g. "footprint", "wire", "gr_text"). */
  type: z.string(),
  /** The item's full native s-expr fragment, verbatim. */
  sexpr: z.string(),
});
export type KicadItem = z.infer<typeof kicadItemSchema>;

export const kicadLayoutEntrySchema = z.union([
  z.object({ raw: z.string() }),
  z.object({ item: z.string() }),
]);
export type KicadLayoutEntry = z.infer<typeof kicadLayoutEntrySchema>;

export const kicadDocSchema = z.object({
  /** Top-level form name, e.g. "kicad_pcb" / "kicad_sch" / "kicad_wks". */
  root: z.string(),
  /** uuid → item blob. The CRDT-mergeable item set. */
  items: z.record(z.string(), kicadItemSchema),
  /** Ordered top-level children: a `raw` blob or a reference to an `item` by uuid. */
  layout: z.array(kicadLayoutEntrySchema),
});
export type KicadDoc = z.infer<typeof kicadDocSchema>;

/**
 * Decompose KiCad s-expr text into a `KicadDoc`. Throws if `text` is not a single
 * top-level `(<root> …)` form.
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
  const layout: KicadLayoutEntry[] = [];

  for (const child of root.slice(1)) {
    const id = directUuid(child);
    // Keep a (rare) duplicate top-level uuid as a raw blob rather than collapsing
    // two distinct nodes onto one key — preserves losslessness either way.
    if (id !== null && Array.isArray(child) && !(id in items)) {
      const type = typeof child[0] === "string" ? child[0] : "";
      items[id] = { type, sexpr: printSexpr(child) };
      layout.push({ item: id });
    } else {
      layout.push({ raw: printSexpr(child) });
    }
  }

  return kicadDocSchema.parse({ root: name, items, layout });
}

/** Reassemble KiCad s-expr text from a `KicadDoc`, in `layout` order. */
export function docToFile(doc: KicadDoc): string {
  kicadDocSchema.parse(doc);
  const parts = doc.layout.map((entry) => {
    if ("item" in entry) {
      const item = doc.items[entry.item];
      if (!item) throw new Error(`docToFile: layout references missing item ${entry.item}`);
      return item.sexpr;
    }
    return entry.raw;
  });
  return parts.length ? `(${doc.root} ${parts.join(" ")})` : `(${doc.root})`;
}
