/**
 * `(property "Sheetfile" "child.kicad_sch")` references between schematic
 * files — ONE implementation for both sides: the editor scopes its per-sheet
 * collab rooms by them (standalone `sheet-hierarchy.ts`), and the platform's
 * file ops must know which parents a rename would orphan (project-page 0003).
 * Two resolvers disagreeing about `../` or `${KIPRJMOD}/` would mean a move
 * the server calls safe silently drops a sheet out of the editor's hierarchy.
 *
 * Heuristic by design: a regex over s-expr text, no parse.
 */

/** `(property "Sheetfile" "…")` — value may contain escaped quotes. */
export const SHEETFILE_RE = /\(property\s+"Sheetfile"\s+"((?:[^"\\]|\\.)*)"/g;

const KIPRJMOD = "${KIPRJMOD}/";

function unescapeSexpr(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/**
 * Resolve a Sheetfile reference against the REFERENCING sheet's directory.
 * KiCad writes plain relative paths (`Power.kicad_sch`, `../shared/x.kicad_sch`);
 * a `${KIPRJMOD}/` prefix (project root) appears in some hand-edited files.
 * Returns a normalized project-relative path ("" when it escapes the root).
 */
export function resolveSheetRef(parentPath: string, ref: string): string {
  let r = unescapeSexpr(ref).trim().replace(/\\/g, "/");
  const projRelative = r.startsWith(KIPRJMOD);
  if (projRelative) r = r.slice(KIPRJMOD.length);
  const out = projRelative ? [] : parentPath.split("/").slice(0, -1);
  for (const seg of r.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Every Sheetfile reference in one schematic's text: raw value + resolved path. */
export function sheetRefsOf(parentPath: string, text: string): Array<{ raw: string; path: string }> {
  const out: Array<{ raw: string; path: string }> = [];
  for (const match of text.matchAll(SHEETFILE_RE)) {
    out.push({ raw: match[1]!, path: resolveSheetRef(parentPath, match[1]!) });
  }
  return out;
}
