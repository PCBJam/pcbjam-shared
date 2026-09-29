/**
 * KiCad-style pretty layout for s-expr documents — MIT, pure text.
 *
 * `docToFile` / `renderSlotText` emit the COMPACT form (everything on one line),
 * which is what the editor and the sync paths want. Anything that leaves PCBJam
 * as a file a human or `git diff` will read should instead look like a file
 * KiCad saved, so a one-footprint move is a few-line diff, not a one-line
 * rewrite of the whole board. This module renders that layout directly from
 * the slot tree (it is not a post-processor over compact text).
 *
 * The layout was derived by observing KiCad-saved files (KiCad 8–10 boards,
 * schematics, symbol / footprint libraries, library tables) and is checked
 * byte-for-byte against them in `test/kicad-format.test.ts`:
 *
 *  - one TAB per nesting level; the file ends with a single "\n";
 *  - a list that holds no inner list stays on one line: `(at 1 2 90)`;
 *  - every inner list opens on a new line, one level deeper than its parent;
 *    atoms that follow the head (or follow an inner list) stay on the current
 *    line after a single space: `(property "Value" "10k"`, `(offset 0) hide)`;
 *  - a list whose last element is an inner list closes on its own line, at its
 *    opening line's indentation; one that ends in an atom closes inline;
 *  - consecutive `(xy …)` siblings pack onto one line while the line is shorter
 *    than {@link XY_PACK_COLUMN} characters (tabs count as one), then wrap;
 *  - in a list that starts its own line, a run of atoms wraps once the line
 *    reaches {@link ATOM_WRAP_COLUMN} characters: the next atom goes on a
 *    continuation line one level deeper, and the list then closes on its own
 *    line (long `(members …)`, `(pins …)`, `(layers …)`, image `(data …)`).
 *
 * Modes (KiCad picks one per file kind / setting):
 *  - `normal` — the standard save;
 *  - `compact_text_properties` — KiCad's compact-save setting, observed only in
 *    board files: `(font …)`, `(stroke …)`, `(fill …)` and the 3D model
 *    `(offset …)` / `(scale …)` / `(rotate …)` render on one line. TODO: no
 *    KiCad-written schematic or library in this style was available to learn
 *    from, so the same set is applied everywhere;
 *  - `library_table` — `fp-lib-table` / `sym-lib-table` / `design-block-lib-table`:
 *    every `(lib …)` row renders on one line.
 */

import type { KicadItem, Slot } from "./kicad-doc.js";
import { parseSexpr, type SNode } from "./sexpr.js";

export type KicadFormatMode = "normal" | "compact_text_properties" | "library_table";

/** Consecutive `(xy …)` siblings share a line while it is shorter than this. */
export const XY_PACK_COLUMN = 99;
/** An atom run wraps once its line has reached this many characters. */
export const ATOM_WRAP_COLUMN = 72;

/** Lists `compact_text_properties` keeps on one line. */
const COMPACT_TEXT_HEADS: ReadonlySet<string> = new Set([
  "font",
  "stroke",
  "fill",
  "offset",
  "scale",
  "rotate",
]);

/** Roots KiCad always writes in `library_table` mode. */
const LIBRARY_TABLE_ROOTS: ReadonlySet<string> = new Set([
  "fp_lib_table",
  "sym_lib_table",
  "design_block_lib_table",
]);

/** A list to render: its head keyword and its content slots. */
interface ListView {
  head: string;
  slots: Slot[];
}

export interface KicadPrettyOptions {
  mode?: KicadFormatMode;
  /** Same contract as `RenderDocOptions.onMissingItem`: skip + report, else throw. */
  onMissingItem?: (uuid: string) => void;
}

/**
 * The mode a KiCad file was written in, so a re-render keeps its style: a lib
 * table by its root, compact text properties by a one-line `(font (…` or
 * `(stroke (…` (never produced by a normal save).
 */
export function detectKicadFormatMode(text: string): KicadFormatMode {
  const root = /^\s*\(\s*([^\s()"]+)/.exec(text)?.[1];
  if (root && LIBRARY_TABLE_ROOTS.has(root)) return "library_table";
  if (/^\t*\((?:font|stroke) \(/m.test(text)) return "compact_text_properties";
  return "normal";
}

/**
 * Render `(root …slots)` in KiCad's layout. `items` resolves `{ item }` slots
 * (hoisted uuid items) back into the lists they were lifted from.
 */
export function renderKicadPretty(
  root: string,
  slots: Slot[],
  items: Record<string, KicadItem>,
  opts: KicadPrettyOptions = {},
): string {
  const mode = opts.mode ?? (LIBRARY_TABLE_ROOTS.has(root) ? "library_table" : "normal");
  const inlineHeads: ReadonlySet<string> =
    mode === "compact_text_properties"
      ? COMPACT_TEXT_HEADS
      : mode === "library_table"
        ? new Set(["lib"])
        : new Set();

  const out: string[] = [];
  let col = 0; // characters on the current line so far (a tab counts as one)
  const seen = new Set<string>();

  const put = (s: string): void => {
    out.push(s);
    const nl = s.lastIndexOf("\n");
    col = nl < 0 ? col + s.length : s.length - nl - 1;
  };
  const newline = (depth: number): void => put("\n" + "\t".repeat(depth));

  /** Resolve a list-valued slot, or null for a skipped dangling item ref. */
  const view = (slot: Exclude<Slot, { atom: string }>): ListView | null => {
    if ("k" in slot) return { head: slot.k, slots: slot.v };
    const item = items[slot.item];
    if (!item) {
      if (opts.onMissingItem) {
        opts.onMissingItem(slot.item);
        return null;
      }
      throw new Error(`renderItem: missing item ${slot.item}`);
    }
    return { head: item.type, slots: item.body };
  };

  /** Enter / leave an item, guarding against reference cycles. */
  const withItem = (slot: Slot, fn: () => void): void => {
    if (!("item" in slot)) return fn();
    if (seen.has(slot.item)) throw new Error(`renderItem: cycle through item ${slot.item}`);
    seen.add(slot.item);
    fn();
    seen.delete(slot.item);
  };

  /** One-line form (compact modes): `(head a b (c d))`. */
  const writeFlat = (list: ListView): void => {
    put("(" + list.head);
    for (const s of list.slots) {
      if ("atom" in s) {
        put(" " + s.atom);
        continue;
      }
      const child = view(s);
      if (!child) continue;
      put(" ");
      withItem(s, () => writeFlat(child));
    }
    put(")");
  };

  /**
   * Multi-line form. `atLineStart` is false only for a packed `(xy …)`, whose
   * atoms never wrap.
   */
  const writeList = (list: ListView, depth: number, atLineStart: boolean): void => {
    put("(" + list.head);
    let lastWasList = false; // the most recent element was an inner list
    let continued = false; // the current line is an atom-run continuation
    let prevXy = false;
    for (const s of list.slots) {
      if ("atom" in s) {
        if (atLineStart && col >= ATOM_WRAP_COLUMN) {
          newline(depth + 1);
          put(s.atom);
          continued = true;
        } else {
          put(" " + s.atom);
        }
        lastWasList = false;
        prevXy = false;
        continue;
      }
      const child = view(s);
      if (!child) continue;
      const isXy = child.head === "xy";
      const packed = isXy && prevXy && col < XY_PACK_COLUMN;
      if (packed) put(" ");
      else newline(depth + 1);
      withItem(s, () => {
        if (inlineHeads.has(child.head)) writeFlat(child);
        else writeList(child, depth + 1, !packed);
      });
      lastWasList = true;
      continued = false;
      prevXy = isXy;
    }
    if (lastWasList || continued) newline(depth);
    put(")");
  };

  writeList({ head: root, slots }, 0, true);
  put("\n");
  return out.join("");
}

/** Slots of a parsed list, without hoisting uuid items (plain formatting). */
function nodeSlots(nodes: SNode[]): Slot[] {
  return nodes.map((n): Slot => {
    if (typeof n === "string") return { atom: n };
    const head = n[0];
    if (typeof head !== "string") throw new Error("formatKicadText: list without a head atom");
    return { k: head, v: nodeSlots(n.slice(1)) };
  });
}

/**
 * Re-lay-out KiCad s-expr text (any whitespace) the way KiCad saves it. `mode`
 * defaults to the style `text` is already in (see `detectKicadFormatMode`).
 */
export function formatKicadText(text: string, mode?: KicadFormatMode): string {
  const forms = parseSexpr(text);
  if (forms.length !== 1 || !Array.isArray(forms[0])) {
    throw new Error("formatKicadText: expected exactly one top-level (…) form");
  }
  const [head, ...rest] = forms[0];
  if (typeof head !== "string") throw new Error("formatKicadText: root form has no name atom");
  return renderKicadPretty(head, nodeSlots(rest), {}, { mode: mode ?? detectKicadFormatMode(text) });
}
