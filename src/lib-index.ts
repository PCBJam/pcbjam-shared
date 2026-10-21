/**
 * The library index (libs 0028): one small row per library item, computed from
 * the item's body, so the symbol chooser (and the footprint filters of 0029) can
 * list a library without parsing it into KiCad objects.
 *
 * One pure function per kind turns a stored item body into a row. The server
 * runs it at ingest (ingested origins), the browser runs it for live layers
 * (team, user, override libraries); both get the same rows because both run
 * this code.
 *
 * Rows keep the RAW text of the file (s-expr string escapes decoded, KiCad's
 * `{slash}`-style escapes kept): the KiCad side applies its own
 * `UnescapeString` and text-variable rules, so this module never has to copy
 * them. Short keys keep the JSON small (0028 section 3 measured the sizes).
 */
import { parseSexpr, type SNode } from "./sexpr.js";

export const LIB_INDEX_SCHEMA = 1;

/** One symbol, as its own body says (before derived-symbol resolution). */
export interface SymbolIndexRow {
  /** Symbol name. */
  n: string;
  /** `extends` (parent name); absent for a root symbol. */
  x?: string;
  /** Description property (or the legacy `ki_description`). */
  d?: string;
  /** `ki_keywords`. */
  k?: string;
  /** `ki_fp_filters`, as in the file (space-separated). */
  f?: string;
  /** Footprint property, when not empty. */
  fp?: string;
  /** Datasheet property, when not empty. */
  ds?: string;
  /** Reference property, when not empty. */
  r?: string;
  /** Value property, only when it differs from `n` ("" = an empty value). */
  v?: string;
  /** Every other property (user fields such as LCSC): name → raw text. */
  fl?: Record<string, string>;
  /** Unit count, when > 1. */
  u?: number;
  /** Unit number → `unit_name`, when set. */
  un?: Record<string, string>;
  /** 1 = `(power)`, 2 = `(power local)`. */
  pw?: 1 | 2;
  /** `GetGraphicalPins( 0, 1 ).size()`: pins in body style 0 or 1, all units. */
  gp?: number;
  /** `GetPinCount()`: the same pins, stacked notation expanded. */
  pc?: number;
  /** Some text holds `${` or `@{`: KiCad must resolve it itself. */
  tv?: 1;
}

export interface FootprintIndexRow {
  /** Footprint name (the item name). */
  n: string;
  /** `(descr …)`. */
  d?: string;
  /** `(tags …)`. */
  t?: string;
  /** Every `(property …)` except Reference and Value. */
  fl?: Record<string, string>;
  /** Pad count, `GetPadCount( DO_NOT_INCLUDE_NPTH )`. */
  pc: number;
  /** Unique pad count, `GetUniquePadCount( DO_NOT_INCLUDE_NPTH )`. */
  up: number;
}

export type LibIndexKind = "symbol" | "footprint";

/** The per-version file the server stores next to the item bodies. */
export interface LibIndexFile {
  schema: number;
  libId: string;
  versionId: string;
  kind: LibIndexKind;
  builtAt: string;
  /** `p` = manifest path `<kind>/<name>`. */
  rows: Array<{ p: string } & (SymbolIndexRow | FootprintIndexRow)>;
  /** Paths whose body would not index. */
  bad?: string[];
}

/**
 * The stored file's name at the root of a version prefix (root files are never
 * synced items, see snapshot-bytes). The schema is in the name: a reader asks
 * for exactly the schema it understands, so a schema bump needs no migration
 * and an immutable cached copy of the old one can't be served as the new one.
 */
export const libIndexFileName = (schema: number = LIB_INDEX_SCHEMA) => `lib-index.v${schema}.json`;

/**
 * The official set's combined index: the per-version files of every library in
 * the official lib pack (lib-pack.ts), stored next to it brotli-compressed. One
 * request instead of one per library on a cold run.
 */
export interface LibIndexPack {
  schema: number;
  /** The lib pack id this index belongs to. */
  packId: string;
  libs: LibIndexFile[];
}

// ---------------------------------------------------------------- s-expr helpers

type List = SNode[];

const isList = (n: SNode | undefined): n is List => Array.isArray(n);
const isTag = (n: SNode | undefined, tag: string): n is List => isList(n) && n[0] === tag;

/** A string or bare-atom token as KiCad's lexer reads it; undefined for a list. */
function text(node: SNode | undefined): string | undefined {
  if (typeof node !== "string") return undefined;
  if (node.length < 2 || node[0] !== '"' || node[node.length - 1] !== '"') return node;
  const s = node.slice(1, -1);
  if (!s.includes("\\")) return s;
  // DSNLEXER's escapes (common/dsnlexer.cpp).
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const e = s[++i]!;
    switch (e) {
      case '"':
      case "\\":
        out += e;
        break;
      case "a": out += "\x07"; break;
      case "b": out += "\x08"; break;
      case "f": out += "\x0c"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "v": out += "\x0b"; break;
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += "x";
        break;
      }
      default: {
        const m = /^[0-7]{1,3}/.exec(s.slice(i));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 8));
          i += m[0].length - 1;
        } else {
          out += "\\";
          i--;
        }
      }
    }
  }
  return out;
}

const hasTextVar = (s: string | undefined) => !!s && (s.includes("${") || s.includes("@{"));

// ---------------------------------------------------------------- symbols

/** KiCad's mandatory field names, compared case-insensitively like the parser. */
const MANDATORY: Record<string, "r" | "v" | "fp" | "ds" | "d"> = {
  reference: "r",
  value: "v",
  footprint: "fp",
  datasheet: "ds",
  description: "d",
};

/** `ParseAlphaNumericPin` (common/string_utils.cpp): trailing digits → number. */
function parseAlphaNumericPin(pin: string): [string, number] {
  let numStart = pin.length;
  for (let i = pin.length - 1; i >= 0; i--) {
    if (!/[0-9]/.test(pin[i]!)) {
      numStart = i + 1;
      break;
    }
    if (i === 0) numStart = 0;
  }
  if (numStart < pin.length) return [pin.slice(0, numStart), parseInt(pin.slice(numStart), 10)];
  return [pin, -1];
}

/** `CountStackedPinNotation` (common/string_utils.cpp), without the validity flag. */
export function countStackedPinNotation(pin: string): number {
  const len = pin.length;
  if (len < 3) return 1;
  if (pin[0] !== "[" || pin[len - 1] !== "]") return 1;
  const inner = pin.slice(1, -1);
  let count = 0;
  for (const raw of inner.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const dash = part.indexOf("-");
    if (dash >= 0) {
      const [sp, sv] = parseAlphaNumericPin(part.slice(0, dash).trim());
      const [ep, ev] = parseAlphaNumericPin(part.slice(dash + 1).trim());
      if (sp !== ep || sv === -1 || ev === -1 || sv > ev) return 1;
      count += ev - sv + 1;
    } else count++;
  }
  return count === 0 ? 1 : count;
}

const symName = (node: SNode | undefined) => text(node)?.replaceAll("{slash}", "/");

/** The `(symbol …)` forms of a body: a `kicad_symbol_lib` document or bare symbols. */
function symbolForms(body: string): { version: number; symbols: List[] } {
  const roots = parseSexpr(body);
  const symbols: List[] = [];
  let version = Infinity;
  for (const r of roots) {
    if (isTag(r, "kicad_symbol_lib")) {
      for (const c of r) {
        if (isTag(c, "symbol")) symbols.push(c);
        else if (isTag(c, "version")) version = Number(text(c[1])) || Infinity;
      }
    } else if (isTag(r, "symbol")) symbols.push(r);
  }
  return { version, symbols };
}

/** One symbol form → its row (no parent resolution). */
function symbolRow(sym: List, version: number): SymbolIndexRow {
  const row: SymbolIndexRow = { n: symName(sym[1]) ?? "" };
  const fields: Record<string, string> = {};
  const units = new Map<number, string>();
  let unitCount = 1;
  let gp = 0;
  let pc = 0;
  let tv = false;
  let valueSeen = false;

  const countPin = (pin: List) => {
    gp++;
    const num = pin.find((c) => isTag(c, "number"));
    pc += countStackedPinNotation(isList(num) ? (text(num[1]) ?? "") : "");
  };

  for (const c of sym.slice(2)) {
    if (!isList(c)) continue;
    switch (c[0]) {
      case "power":
        row.pw = text(c[1]) === "local" ? 2 : 1;
        break;
      case "extends":
        row.x = symName(c[1]);
        break;
      case "property": {
        let i = 1;
        if (c[i] === "private") i++;
        const name = text(c[i]);
        if (!name) break;
        let value = text(c[i + 1]) ?? "";
        if (version < 20250318 && value === "~") value = "";
        if (hasTextVar(value)) tv = true;
        const mandatory = MANDATORY[name.toLowerCase()];
        if (mandatory) {
          if (mandatory === "v") {
            valueSeen = true;
            if (value !== row.n) row.v = value;
            else delete row.v;
          } else if (value) row[mandatory] = value;
          else delete row[mandatory];
        } else if (name === "ki_keywords") {
          if (value) row.k = value;
        } else if (name === "ki_description") {
          if (value) row.d = value;
        } else if (name === "ki_fp_filters") {
          if (value) row.f = value;
        } else if (name === "ki_locked") {
          // not a field
        } else {
          // KiCad renames a duplicate user field to name_1 … name_9, else drops it.
          let key = name;
          for (let n = 1; key in fields && n < 10; n++) key = `${name}_${n}`;
          if (!(key in fields)) fields[key] = value;
        }
        break;
      }
      case "symbol": {
        // Unit sub-symbol: "<name>_<unit>_<bodyStyle>".
        const sub = symName(c[1]) ?? "";
        const m = /_(\d+)_(\d+)$/.exec(sub);
        const unit = m ? Number(m[1]) : 1;
        const bodyStyle = m ? Number(m[2]) : 1;
        if (unit > unitCount) unitCount = unit;
        for (const it of c.slice(2)) {
          if (isTag(it, "unit_name")) {
            const un = text(it[1]);
            if (un !== undefined) units.set(unit, un);
          } else if (isTag(it, "pin") && (bodyStyle === 0 || bodyStyle === 1)) countPin(it);
        }
        break;
      }
      case "pin":
        countPin(c);
        break;
    }
  }

  // No Value property: KiCad's Value field stays empty.
  if (!valueSeen && row.n) row.v = "";
  if (hasTextVar(row.k) || hasTextVar(row.d)) tv = true;
  if (Object.keys(fields).length) row.fl = fields;
  if (unitCount > 1) row.u = unitCount;
  if (units.size) row.un = Object.fromEntries([...units].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
  if (gp) row.gp = gp;
  if (pc) row.pc = pc;
  if (tv) row.tv = 1;
  return row;
}

/**
 * Index one stored symbol item. The body is a self-contained `kicad_symbol_lib`
 * holding the symbol plus the parents it extends, or a single `(symbol …)`; the
 * row describes the symbol named `name`, not the bundled parents. Null when the
 * body doesn't parse or doesn't hold that symbol.
 */
export function indexSymbolItem(name: string, body: string): SymbolIndexRow | null {
  let parsed: ReturnType<typeof symbolForms>;
  try {
    parsed = symbolForms(body);
  } catch {
    return null;
  }
  const { version, symbols } = parsed;
  const want = name.replaceAll("{slash}", "/");
  let sym = symbols.find((s) => symName(s[1]) === want);
  // A body holding exactly one symbol under another name (renamed item path).
  if (!sym && symbols.length === 1) sym = symbols[0];
  return sym ? symbolRow(sym, version) : null;
}

/** Every symbol of a whole `.kicad_sym` file, in file order (tests, tools). */
export function indexSymbolLibrary(body: string): SymbolIndexRow[] {
  const { version, symbols } = symbolForms(body);
  return symbols.map((s) => symbolRow(s, version));
}

/**
 * Resolve derived rows against the root symbols of the same merged library.
 * As `LIB_SYMBOL` does at run time, units, unit names, pins and the power flag
 * come from the root. Description, keywords and filters stay the symbol's own:
 * the KiCad side decides where it falls back (its cached chooser text does not).
 * A row whose root is missing is returned unchanged.
 */
export function resolveSymbolRows(rows: SymbolIndexRow[]): SymbolIndexRow[] {
  const byName = new Map(rows.map((r) => [r.n, r]));
  const rootOf = (r: SymbolIndexRow): SymbolIndexRow | undefined => {
    let cur = r;
    for (let depth = 0; cur.x !== undefined; depth++) {
      const next = byName.get(cur.x);
      if (!next || depth > 32) return undefined;
      cur = next;
    }
    return cur;
  };
  return rows.map((r) => {
    if (r.x === undefined) return r;
    const root = rootOf(r);
    if (!root) return r;
    const out: SymbolIndexRow = { ...r };
    for (const k of ["u", "un", "gp", "pc", "pw"] as const) {
      if (root[k] === undefined) delete out[k];
      else (out as unknown as Record<string, unknown>)[k] = root[k];
    }
    return out;
  });
}

// ---------------------------------------------------------------- footprints

const isCopperLayer = (layer: string) => layer.endsWith(".Cu");

/** The top-level `(footprint …)` form (or legacy `(module …)`) of a body. */
function footprintForm(body: string): List | null {
  for (const r of parseSexpr(body)) if (isTag(r, "footprint") || isTag(r, "module")) return r;
  return null;
}

/** Pad counts as KiCad computes them (pcbnew/footprint.cpp). */
function padCounts(fp: List): { pc: number; up: number } {
  let pc = 0;
  const numbers = new Set<string>();
  for (const c of fp) {
    if (!isTag(c, "pad")) continue;
    const number = text(c[1]) ?? "";
    const npth = c[2] === "np_thru_hole";
    if (!npth) pc++;
    // `(layers …)`: no layers form counts as copper (be permissive).
    const layers = c.find((x) => isTag(x, "layers"));
    const onCopper = !isList(layers) || layers.slice(1).some((l) => isCopperLayer(text(l) ?? ""));
    if (number !== "" && !npth && onCopper) numbers.add(number);
  }
  return { pc, up: numbers.size };
}

/**
 * Unique electrical pad count of a footprint document, as
 * `FOOTPRINT::GetUniquePadCount( DO_NOT_INCLUDE_NPTH )`: distinct pad numbers,
 * skipping NPTH, unnumbered and non-copper pads. The symbol chooser's footprint
 * filter matches on exactly this value.
 */
export function countUniquePads(body: string): number {
  const fp = footprintForm(body);
  if (!fp) throw new Error("no (footprint …) found");
  return padCounts(fp).up;
}

/** Index one stored footprint item (`name` is the item name). Null when it won't parse. */
export function indexFootprintItem(name: string, body: string): FootprintIndexRow | null {
  let fp: List | null;
  try {
    fp = footprintForm(body);
  } catch {
    return null;
  }
  if (!fp) return null;
  const row: FootprintIndexRow = { n: name, ...padCounts(fp) };
  const fields: Record<string, string> = {};
  for (const c of fp) {
    if (isTag(c, "descr")) row.d ??= text(c[1]);
    else if (isTag(c, "tags")) row.t ??= text(c[1]);
    else if (isTag(c, "property")) {
      const key = text(c[1]);
      if (key && key !== "Reference" && key !== "Value") fields[key] = text(c[2]) ?? "";
    }
  }
  if (!row.d) delete row.d;
  if (!row.t) delete row.t;
  if (Object.keys(fields).length) row.fl = fields;
  // Keep key order stable for size and readability: n, d, t, fl, pc, up.
  const { n, d, t, fl, pc, up } = row;
  return { n, ...(d ? { d } : {}), ...(t ? { t } : {}), ...(fl ? { fl } : {}), pc, up };
}

// ---------------------------------------------------------------- index files

/** `<kind>/<name>` → name. */
export const libIndexItemName = (path: string) => path.slice(path.indexOf("/") + 1);

/**
 * Build a library's index from its item bodies (manifest path → body text).
 * Paths of another kind are ignored; bodies that won't index go to `bad`.
 */
export function buildLibIndex(
  kind: LibIndexKind,
  items: Iterable<readonly [path: string, body: string]>,
): { rows: LibIndexFile["rows"]; bad: string[] } {
  const rows: LibIndexFile["rows"] = [];
  const bad: string[] = [];
  const prefix = `${kind}/`;
  for (const [p, body] of items) {
    if (!p.startsWith(prefix)) continue;
    const name = libIndexItemName(p);
    const row = kind === "symbol" ? indexSymbolItem(name, body) : indexFootprintItem(name, body);
    if (row) rows.push({ p, ...row });
    else bad.push(p);
  }
  rows.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return { rows, bad };
}

// ---------------------------------------------------------------- bridge encoding

/**
 * Tab-separated form of a symbol library's rows for the wasm bridge: the C++
 * side splits it without a JSON parser (nlohmann is slow in wasm, libs 0013).
 *
 *   v=<token>\tschema=1\tkind=symbol[\tfrom=<i>\ttotal=<n>]\n
 *   <n>\t<x>\t<pw>\t<u>\t<gp>\t<pc>\t<tv>\t<d>\t<k>\t<f>\t<fp>\t<r>\t<v>\t<ds>\t<un>\t<fl>\n
 *
 * Text escapes `\` `\t` `\n` as `\\` `\t` `\n`. `un` and `fl` are `key=value`
 * pairs joined by `\x1f`, with `=` and `\x1f` escaped too (`\=`, `\u`). A
 * missing value is an empty column. The Value column is always written in full
 * (`n` again when the row omits it), so empty and absent can't be confused.
 */
export const LIB_INDEX_TSV_COLUMNS = [
  "n", "x", "pw", "u", "gp", "pc", "tv", "d", "k", "f", "fp", "r", "v", "ds", "un", "fl",
] as const;

const escTsv = (s: string) => s.replace(/[\\\t\n]/g, (c) => (c === "\\" ? "\\\\" : c === "\t" ? "\\t" : "\\n"));
const escPair = (s: string) => escTsv(s).replace(/[=\x1f]/g, (c) => (c === "=" ? "\\=" : "\\u"));

function unescTsv(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\(.)/g, (_, c: string) =>
    c === "t" ? "\t" : c === "n" ? "\n" : c === "u" ? "\x1f" : c,
  );
}

const encodePairs = (m: Record<string, string> | undefined) =>
  m ? Object.entries(m).map(([k, v]) => `${escPair(k)}=${escPair(v)}`).join("\x1f") : "";

function decodePairs(s: string): Record<string, string> | undefined {
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const pair of s.split("\x1f")) {
    // The first `=` not preceded by an escaping backslash.
    let i = 0;
    for (; i < pair.length; i++) {
      if (pair[i] === "\\") i++;
      else if (pair[i] === "=") break;
    }
    out[unescTsv(pair.slice(0, i))] = unescTsv(pair.slice(i + 1));
  }
  return out;
}

/**
 * Encode resolved symbol rows for the bridge; `token` identifies this state of
 * the library. With `page`, only rows [from, from + size) are written and the
 * header says where they start and how many the library has (the warm-up reads
 * a large library in steps).
 */
export function encodeLibIndexTsv(
  token: string,
  rows: readonly SymbolIndexRow[],
  page?: { from: number; size: number },
): string {
  const head = `v=${escTsv(token)}\tschema=${LIB_INDEX_SCHEMA}\tkind=symbol`;
  const lines = [page ? `${head}\tfrom=${page.from}\ttotal=${rows.length}` : head];
  for (const r of page ? rows.slice(page.from, page.from + page.size) : rows) {
    lines.push(
      [
        escTsv(r.n),
        escTsv(r.x ?? ""),
        r.pw ? String(r.pw) : "",
        r.u ? String(r.u) : "",
        r.gp ? String(r.gp) : "",
        r.pc ? String(r.pc) : "",
        r.tv ? "1" : "",
        escTsv(r.d ?? ""),
        escTsv(r.k ?? ""),
        escTsv(r.f ?? ""),
        escTsv(r.fp ?? ""),
        escTsv(r.r ?? ""),
        escTsv(r.v ?? r.n),
        escTsv(r.ds ?? ""),
        encodePairs(r.un),
        encodePairs(r.fl),
      ].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

/** Inverse of `encodeLibIndexTsv` (tests; the C++ side has its own reader). */
export function decodeLibIndexTsv(tsv: string): {
  token: string;
  rows: SymbolIndexRow[];
  page?: { from: number; total: number };
} {
  const lines = tsv.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const head = lines.shift() ?? "";
  const token = unescTsv(/^v=([^\t]*)/.exec(head)?.[1] ?? "");
  const from = /\tfrom=(\d+)/.exec(head);
  const total = /\ttotal=(\d+)/.exec(head);
  const rows = lines.map((line) => {
    const c = line.split("\t");
    const s = (i: number) => unescTsv(c[i] ?? "");
    const num = (i: number) => (c[i] ? Number(c[i]) : undefined);
    const row: SymbolIndexRow = { n: s(0) };
    if (c[1]) row.x = s(1);
    if (c[2]) row.pw = Number(c[2]) as 1 | 2;
    if (num(3)) row.u = num(3);
    if (num(4)) row.gp = num(4);
    if (num(5)) row.pc = num(5);
    if (c[6]) row.tv = 1;
    if (c[7]) row.d = s(7);
    if (c[8]) row.k = s(8);
    if (c[9]) row.f = s(9);
    if (c[10]) row.fp = s(10);
    if (c[11]) row.r = s(11);
    if (s(12) !== row.n) row.v = s(12);
    if (c[13]) row.ds = s(13);
    const un = decodePairs(c[14] ?? "");
    if (un) row.un = un;
    const fl = decodePairs(c[15] ?? "");
    if (fl) row.fl = fl;
    return row;
  });
  return from && total ? { token, rows, page: { from: Number(from[1]), total: Number(total[1]) } } : { token, rows };
}
