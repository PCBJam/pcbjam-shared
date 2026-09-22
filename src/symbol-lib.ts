/**
 * Symbol-library helpers for parts that arrive from outside the editor (remote
 * providers, plugins): pick one symbol out of a `.kicad_sym`, make it
 * self-contained, and build the clipboard blob the native placement tool
 * accepts. Pure text on top of the shared s-expr tokenizer — no KiCad
 * semantics, so it lives here rather than in the GPL standalone.
 *
 * Adapted from the published plugin example
 * (`plugin-platform/examples/external-symbol-import-source/src/logic/`), which
 * stays a separate download; the editor must not import a shipped example.
 */
import { parseSexpr, printSexpr, type SNode } from "./sexpr.js";

/** A list node whose head is a bare tag. */
export type Form = [string, ...SNode[]];

export const isForm = (node: SNode | undefined, tag: string): node is Form =>
  Array.isArray(node) && node[0] === tag;

/** `"text"` → `text`; a bare atom is returned as is; a list → undefined. */
export function unquote(node: SNode | undefined): string | undefined {
  if (typeof node !== "string") return undefined;
  if (node.length >= 2 && node.startsWith('"') && node.endsWith('"')) {
    return node.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return node;
}

export const quote = (text: string): string =>
  '"' + text.replace(/[\\"]/g, (c) => "\\" + c) + '"';

/**
 * The team library a provider's parts go into, from the provider's origin:
 * `https://www.eda.cn` → `eda_cn`, `https://api.datasheets.md` → `datasheets_md`.
 * The name is derived here, never supplied by the provider: KiCad forbids `:`
 * in a nickname and the server does not sanitize library names. No public
 * suffix list — `parts.foo.co.uk` becomes `parts_foo_co_uk`.
 */
export function providerLibName(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new Error("Invalid provider origin");
  }
  const name = host
    .toLowerCase()
    .replace(/^(?:www|api)\./, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!name) throw new Error("Invalid provider origin");
  return name;
}

const MAX_TEXT = 4 * 1024 * 1024;
const MAX_NODES = 120_000;
const MAX_DEPTH = 48;

/** Bounded parse of a whole library or a single symbol form. */
function parseSymbols(text: string): Map<string, Form> {
  if (text.length > MAX_TEXT) throw new Error("Symbol library is too large");
  let depth = 0;
  let forms = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(") {
      if (++depth > MAX_DEPTH || ++forms > MAX_NODES) throw new Error("Symbol library exceeds limits");
    } else if (c === ")" && --depth < 0) throw new Error("Unbalanced symbol library");
  }
  if (depth || quoted) throw new Error("Unbalanced symbol library");

  const roots = parseSexpr(text);
  if (roots.length !== 1 || !Array.isArray(roots[0])) throw new Error("Expected one symbol library or symbol");
  const root = roots[0] as Form;
  const entries: SNode[] = isForm(root, "kicad_symbol_lib") ? root.slice(1) : isForm(root, "symbol") ? [root] : [];
  if (!entries.length) throw new Error("Expected one symbol library or symbol");

  const symbols = new Map<string, Form>();
  for (const node of entries) {
    if (!isForm(node, "symbol")) continue;
    const name = unquote(node[1]);
    if (!name || name.length > 160 || symbols.has(name)) throw new Error("Invalid or duplicate symbol name");
    symbols.set(name, node);
  }
  if (!symbols.size || symbols.size > 2000) throw new Error("Expected 1–2000 symbols");
  return symbols;
}

/** Match a derived symbol's fields with the parent fields they replace. */
function fieldKey(node: Form): string {
  if (isForm(node, "property")) return "property:" + unquote(node[1]);
  if (isForm(node, "symbol")) return "unit:" + unquote(node[1])?.replace(/^.*(_\d+_\d+)$/, "$1");
  return node[0];
}

/**
 * One symbol from `text` (a `kicad_symbol_lib` or a bare `symbol`) as a
 * self-contained definition named `name`: `extends` chains are flattened (the
 * placement allowlist rejects `extends`), units are renamed `<name>_U_C`, and
 * any `Lib:` prefix on the definition name is dropped. When `text` holds a
 * single symbol under another name, that symbol is used and renamed. Throws on
 * a missing, duplicate or cyclic symbol.
 */
export function resolveSymbolDefinition(text: string, name: string): Form {
  const symbols = parseSymbols(text);
  const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  if (!bare) throw new Error("Invalid symbol name");
  // Providers may key the library by "Lib:Name" or by the bare name.
  const byName = new Map<string, Form>();
  for (const [key, form] of symbols) byName.set(key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key, form);
  let target = byName.has(bare) ? bare : undefined;
  if (target === undefined && byName.size === 1) target = [...byName.keys()][0];
  if (target === undefined) throw new Error("Symbol not found in library: " + bare);

  function resolve(current: string, seen: Set<string>): Form {
    if (seen.has(current) || seen.size > 16) throw new Error("Circular or overly deep symbol inheritance");
    const form = byName.get(current);
    if (!form) throw new Error("Missing parent symbol: " + current);
    seen.add(current);
    const parentRef = unquote(form.find((node) => isForm(node, "extends"))?.[1]);
    const parentName = parentRef?.includes(":") ? parentRef.slice(parentRef.lastIndexOf(":") + 1) : parentRef;
    const parent: Form = parentName ? resolve(parentName, seen) : ["symbol", quote(current)];
    const children = new Map<string, Form>();
    for (const child of [...parent.slice(2), ...form.slice(2)]) {
      if (!Array.isArray(child) || typeof child[0] !== "string") continue;
      if (child[0] === "extends" || child[0] === "in_pos_files" || child[0] === "embedded_fonts") continue;
      let value = child as Form;
      if (isForm(child, "symbol")) {
        const suffix = unquote(child[1])?.match(/_\d+_\d+$/)?.[0];
        if (!suffix) throw new Error("Invalid symbol unit name");
        value = ["symbol", quote(bare + suffix), ...child.slice(2)];
      }
      children.set(fieldKey(value), value);
    }
    return ["symbol", quote(bare), ...children.values()];
  }
  return resolve(target, new Set());
}

/** The definition with its `Footprint` property set to `value` (replaced or inserted, hidden). */
export function withFootprintProperty(def: Form, value: string): Form {
  const effects = ["effects", ["font", ["size", "1.27", "1.27"]], ["hide", "yes"]] as SNode;
  let replaced = false;
  const out: SNode[] = def.slice(2).map((node) => {
    if (isForm(node, "property") && unquote(node[1]) === "Footprint") {
      replaced = true;
      return ["property", quote("Footprint"), quote(value), ...node.slice(3)];
    }
    return node;
  });
  if (!replaced) {
    // After the last existing property, so the field order stays KiCad-like.
    let at = 0;
    out.forEach((node, i) => { if (isForm(node, "property")) at = i + 1; });
    out.splice(at, 0, ["property", quote("Footprint"), quote(value), ["at", "0", "0", "0"], effects]);
  }
  return [def[0], def[1], ...out] as Form;
}

/** A `.kicad_sym` file holding just this definition — the body saved into a library. */
export function wrapSymbolLib(def: Form): string {
  return printSexpr(["kicad_symbol_lib", ["version", "20241209"], ["generator", quote("pcbjam")], ["generator_version", quote("9.0")], def]);
}

/**
 * Clipboard text for the native placement tool: the definition under its
 * library id plus one instance at the origin. Reference gets a `?` suffix so
 * the editor annotates it; Value defaults to the symbol name; Footprint and
 * Datasheet are copied from the definition.
 */
export function buildSymbolClipboard(def: Form, nickname: string, name: string, uuid: string): { label: string; sexpr: string } {
  const libId = nickname + ":" + name;
  const property = (key: string, fallback = "") =>
    unquote(def.find((node) => isForm(node, "property") && unquote(node[1]) === key)?.[2]) ?? fallback;
  const reference = property("Reference", "U").replace(/\?+$/, "") + "?";
  const effects = "(effects (font (size 1.27 1.27)))";
  const properties = [
    `(property "Reference" ${quote(reference)} (at 2.54 -1.27 0) ${effects})`,
    `(property "Value" ${quote(property("Value", name))} (at 2.54 1.27 0) ${effects})`,
    `(property "Footprint" ${quote(property("Footprint"))} (at 0 0 0) (hide yes) ${effects})`,
    `(property "Datasheet" ${quote(property("Datasheet"))} (at 0 0 0) (hide yes) ${effects})`,
  ];
  const definition: Form = ["symbol", quote(libId), ...def.slice(2)];
  const instance = `(symbol (lib_id ${quote(libId)}) (at 0 0 0) (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid ${quote(uuid)}) ${properties.join("\n")})`;
  return { label: libId.slice(0, 100), sexpr: `(lib_symbols ${printSexpr(definition)})\n${instance}` };
}
