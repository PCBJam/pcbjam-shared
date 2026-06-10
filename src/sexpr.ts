/**
 * Minimal s-expr tokenizer + printer (MIT) — the parsing primitive under the
 * KiCad file ⇄ Y.Doc converter (ysync 0007). Pure text manipulation: no KiCad
 * semantics, no GPL linkage, so it lives in `@pcbjam/shared` and is usable from
 * the GPL standalone, the closed server, and the sync worker alike.
 *
 * A parsed node is either an atom (a `string`, with quoted strings keeping their
 * surrounding quotes so a string value stays distinct from the same bare token)
 * or a list (`SNode[]`). `printSexpr` is the inverse: `parseSexpr(printSexpr(n))`
 * reproduces `n` structurally (whitespace is not preserved — it carries no
 * meaning in KiCad saves).
 */

export type SNode = string | SNode[];

/** Parse s-expr text into its top-level forms (a KiCad file has exactly one). */
export function parseSexpr(src: string): SNode[] {
  let i = 0;
  const n = src.length;
  const isWs = (c: string | undefined) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

  const skipWs = () => {
    while (i < n && isWs(src[i])) i++;
  };

  const parseString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2; // escape — skip the next char too
        continue;
      }
      if (c === '"') {
        i++;
        return src.slice(start, i); // keep surrounding quotes
      }
      i++;
    }
    throw new Error("parseSexpr: unterminated string");
  };

  const parseAtom = (): string => {
    const start = i;
    while (i < n && !isWs(src[i]) && src[i] !== "(" && src[i] !== ")" && src[i] !== '"') i++;
    return src.slice(start, i);
  };

  const parseList = (): SNode[] => {
    i++; // consume '('
    const list: SNode[] = [];
    for (;;) {
      skipWs();
      if (i >= n) throw new Error("parseSexpr: unbalanced parens (EOF inside list)");
      const c = src[i];
      if (c === ")") {
        i++;
        return list;
      }
      if (c === "(") list.push(parseList());
      else if (c === '"') list.push(parseString());
      else list.push(parseAtom());
    }
  };

  const forms: SNode[] = [];
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (src[i] === ")") throw new Error("parseSexpr: unbalanced parens (stray ')')");
    if (src[i] === "(") forms.push(parseList());
    else if (src[i] === '"') forms.push(parseString());
    else forms.push(parseAtom());
  }
  return forms;
}

/** Serialize a node back to compact s-expr text. */
export function printSexpr(node: SNode): string {
  if (typeof node === "string") return node;
  return "(" + node.map(printSexpr).join(" ") + ")";
}

/** The uuid carried by a list node's direct `(uuid "X")` child, else null. */
export function directUuid(node: SNode): string | null {
  if (!Array.isArray(node)) return null;
  for (const c of node) {
    if (Array.isArray(c) && c[0] === "uuid" && typeof c[1] === "string") {
      const v = c[1];
      return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
    }
  }
  return null;
}
