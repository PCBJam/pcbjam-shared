/**
 * Project sidecar documents as Yjs rooms (proposal 21 WP5): `.kicad_pro` (JSON)
 * and `.kicad_dru` (custom rules, plain text).
 *
 * Both are written WHOLE by KiCad (the native side re-serializes the full file on
 * every save / setup-dialog OK), so the write path is always "full file in,
 * minimal patch out": the writer diffs its new file against the baseline it last
 * agreed on and applies only what changed — a peer's concurrent edit to another
 * key / another rule survives. The same pattern as the board rooms' items.
 *
 *  - json: a nested Y.Map tree under `sidecar_json`. Objects are Y.Maps; arrays of
 *    objects that each carry a unique string `name` (netclasses) are Y.Maps keyed
 *    by name plus an order list, so two peers editing different netclasses merge;
 *    every other array is one atomic leaf. Numbers keep their LEXEME (`1.0`,
 *    `1e-06`) — KiCad writes nlohmann's form and a JS round trip would rewrite
 *    them. Keys serialize sorted, 2-space indented, like nlohmann's dump(2)
 *    (JSON_SETTINGS), so a room renders byte-equal to a native save.
 *  - text: a Y.Text under `sidecar_text`; a save patches the changed line region,
 *    anchored in the current text by its surrounding context.
 */
import * as Y from "yjs";

export type SidecarKind = "json" | "text";

export const Y_SIDECAR_JSON = "sidecar_json";
export const Y_SIDECAR_TEXT = "sidecar_text";

/** Which sidecar codec a project path uses, if any. */
export function sidecarKind(path: string): SidecarKind | null {
  if (path.endsWith(".kicad_pro")) return "json";
  if (path.endsWith(".kicad_dru")) return "text";
  return null;
}

// ── Lossless JSON ─────────────────────────────────────────────────────────────

/** A JSON value whose numbers keep their source lexeme. */
export type JVal = null | boolean | string | JNum | JVal[] | { [key: string]: JVal };
export interface JNum {
  "#n": string;
}

const isNum = (v: unknown): v is JNum =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as JNum)["#n"] === "string" &&
  Object.keys(v).length === 1;
const isObj = (v: unknown): v is { [key: string]: JVal } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !isNum(v);

/** Parse JSON keeping number lexemes. Throws on malformed input. */
export function parseJsonLossless(text: string): JVal {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const fail = (what: string): never => {
    throw new Error(`invalid JSON at ${i}: ${what}`);
  };
  const value = (): JVal => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: { [key: string]: JVal } = {};
      ws();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        ws();
        const k = value();
        if (typeof k !== "string") fail("object key");
        ws();
        if (text[i++] !== ":") fail("':'");
        out[k as string] = value();
        ws();
        const sep = text[i++];
        if (sep === "}") return out;
        if (sep !== ",") fail("',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const out: JVal[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value());
        ws();
        const sep = text[i++];
        if (sep === "]") return out;
        if (sep !== ",") fail("',' or ']'");
      }
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      return JSON.parse(text.slice(start, i)) as string;
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) return fail("value");
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    if (m[0] === "null") return null;
    return { "#n": m[0] };
  };
  const out = value();
  ws();
  if (i !== text.length) fail("trailing content");
  return out;
}

/** Serialize like nlohmann `dump(2)`: sorted keys, 2-space indent, trailing newline. */
export function stringifyKicadJson(v: JVal): string {
  const go = (x: JVal, ind: string): string => {
    if (x === null) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "string") return JSON.stringify(x);
    if (isNum(x)) return x["#n"];
    const next = ind + "  ";
    if (Array.isArray(x)) {
      if (x.length === 0) return "[]";
      return `[\n${x.map((e) => next + go(e, next)).join(",\n")}\n${ind}]`;
    }
    const keys = Object.keys(x).sort();
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((k) => `${next}${JSON.stringify(k)}: ${go(x[k]!, next)}`).join(",\n")}\n${ind}}`;
  };
  return go(v, "") + "\n";
}

const sameJ = (a: JVal | undefined, b: JVal | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

// ── JSON ⇄ Y ──────────────────────────────────────────────────────────────────

/** Marker key: a Y.Map that encodes a NAMED array (entries keyed by `name`). */
const NAMED = "#named";
const ORDER = "#order";
/** Atomic array leaf. */
interface JArr {
  "#a": JVal[];
}
const isArrLeaf = (v: unknown): v is JArr =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Array.isArray((v as JArr)["#a"]);

/** An array of objects each with a unique string `name` — merged per name. */
function namedArray(v: JVal[]): boolean {
  if (v.length === 0) return false;
  const names = new Set<string>();
  for (const e of v) {
    if (!isObj(e) || typeof e.name !== "string" || names.has(e.name)) return false;
    names.add(e.name);
  }
  return true;
}

function encode(v: JVal): unknown {
  if (Array.isArray(v)) {
    if (!namedArray(v)) return { "#a": v } satisfies JArr;
    const m = new Y.Map<unknown>();
    m.set(NAMED, true);
    const order = new Y.Array<string>();
    order.push(v.map((e) => (e as { name: string }).name));
    m.set(ORDER, order);
    for (const e of v) m.set((e as { name: string }).name, encode(e));
    return m;
  }
  if (isObj(v)) {
    const m = new Y.Map<unknown>();
    for (const [k, x] of Object.entries(v)) m.set(k, encode(x));
    return m;
  }
  return v; // null / boolean / string / {#n}
}

function decode(y: unknown): JVal {
  if (y instanceof Y.Map) {
    if (y.get(NAMED) === true) {
      const order = y.get(ORDER);
      const names = order instanceof Y.Array ? (order.toArray() as string[]) : [];
      const seen = new Set<string>();
      const out: JVal[] = [];
      for (const n of names) {
        if (seen.has(n) || !y.has(n)) continue;
        seen.add(n);
        out.push(decode(y.get(n)));
      }
      const rest = [...y.keys()].filter((k) => k !== NAMED && k !== ORDER && !seen.has(k)).sort();
      for (const k of rest) out.push(decode(y.get(k)));
      return out;
    }
    const out: { [key: string]: JVal } = {};
    y.forEach((x, k) => {
      out[k] = decode(x);
    });
    return out;
  }
  if (isArrLeaf(y)) return y["#a"];
  return y as JVal;
}

/** Apply `mine` relative to `base` into Y map `y` (object level). */
function patchObject(y: Y.Map<unknown>, base: { [key: string]: JVal } | undefined, mine: { [key: string]: JVal }): boolean {
  let changed = false;
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(mine)]);
  for (const k of keys) {
    const b = base?.[k];
    const m = mine[k];
    if (sameJ(b, m)) continue; // untouched by the writer — the doc's value stands
    changed = true;
    if (m === undefined) {
      y.delete(k);
      continue;
    }
    const cur = y.get(k);
    if (isObj(m) && isObj(b) && cur instanceof Y.Map && cur.get(NAMED) !== true) {
      patchObject(cur, b, m);
    } else if (Array.isArray(m) && Array.isArray(b) && cur instanceof Y.Map && cur.get(NAMED) === true && namedArray(m)) {
      patchNamed(cur, b, m);
    } else {
      y.set(k, encode(m));
    }
  }
  return changed;
}

function patchNamed(y: Y.Map<unknown>, base: JVal[], mine: JVal[]): void {
  const byName = (arr: JVal[]) => new Map(arr.filter(isObj).map((e) => [e.name as string, e]));
  const B = byName(base);
  const M = byName(mine);
  for (const [n, m] of M) {
    const b = B.get(n);
    if (sameJ(b, m)) continue;
    const cur = y.get(n);
    if (b && cur instanceof Y.Map) patchObject(cur, b, m);
    else y.set(n, encode(m));
  }
  for (const n of B.keys()) if (!M.has(n)) y.delete(n);
  const seqB = [...B.keys()];
  const seqM = [...M.keys()];
  if (JSON.stringify(seqB) !== JSON.stringify(seqM)) {
    // The writer reordered / added / removed: keep entries it never saw at their place.
    const order = y.get(ORDER) as Y.Array<string>;
    const current = order.toArray();
    const known = new Set([...seqB, ...seqM]);
    const target = [...seqM];
    current.forEach((n, i) => {
      if (known.has(n) || !y.has(n)) return;
      const prev = i > 0 ? current[i - 1] : undefined;
      target.splice(prev === undefined ? 0 : target.indexOf(prev) + 1, 0, n);
    });
    order.delete(0, order.length);
    order.push(target);
  }
}

// ── Text ⇄ Y ──────────────────────────────────────────────────────────────────

/** Splice `mine`'s change relative to `base` into Y.Text, anchored by context. */
function patchText(yt: Y.Text, base: string, mine: string): boolean {
  if (base === mine) return false;
  let p = 0;
  while (p < base.length && p < mine.length && base[p] === mine[p]) p++;
  let s = 0;
  while (s < base.length - p && s < mine.length - p && base[base.length - 1 - s] === mine[mine.length - 1 - s]) s++;
  const insert = mine.slice(p, mine.length - s);
  const cur = yt.toString();
  if (cur === base) {
    yt.delete(p, base.length - s - p);
    if (insert) yt.insert(p, insert);
    return true;
  }
  // The doc moved on: locate the edited region by its surrounding context —
  // the widest window (context + removed + context) that occurs exactly once,
  // shrinking so a peer's edit near this one doesn't hide the anchor.
  const end = base.length - s;
  const removed = base.slice(p, end);
  for (const k of [64, 32, 16, 8, 4, 1]) {
    const before = base.slice(Math.max(0, p - k), p);
    const after = base.slice(end, Math.min(base.length, end + k));
    const needle = before + removed + after;
    if (!needle) break;
    const at = cur.indexOf(needle);
    if (at < 0 || cur.indexOf(needle, at + 1) >= 0) continue;
    const start = at + before.length;
    yt.delete(start, removed.length);
    if (insert) yt.insert(start, insert);
    return true;
  }
  // No unambiguous anchor: the writer's file wins (last writer).
  yt.delete(0, yt.length);
  yt.insert(0, mine);
  return true;
}

// ── Codec ─────────────────────────────────────────────────────────────────────

export interface SidecarCodec {
  kind: SidecarKind;
  /** The room holds no sidecar state yet. */
  isEmpty(doc: Y.Doc): boolean;
  /** Write the whole file into an EMPTY doc (first seed). */
  seed(doc: Y.Doc, text: string, origin?: unknown): void;
  /** Render the room as file text (null when empty). */
  render(doc: Y.Doc): string | null;
  /**
   * Apply the writer's `file` relative to its `baseline` (the text it last agreed
   * on). Without a baseline the file replaces the doc wholesale. Returns true
   * when the doc changed. Throws on an unparseable JSON file (never half-writes).
   */
  patch(doc: Y.Doc, file: string, baseline: string | undefined, origin?: unknown): boolean;
}

const jsonCodec: SidecarCodec = {
  kind: "json",
  isEmpty: (doc) => doc.getMap(Y_SIDECAR_JSON).size === 0,
  seed(doc, text, origin) {
    const v = parseJsonLossless(text);
    if (!isObj(v)) throw new Error("sidecar JSON root must be an object");
    doc.transact(() => {
      const root = doc.getMap<unknown>(Y_SIDECAR_JSON);
      for (const [k, x] of Object.entries(v)) root.set(k, encode(x));
    }, origin);
  },
  render(doc) {
    const root = doc.getMap<unknown>(Y_SIDECAR_JSON);
    if (root.size === 0) return null;
    return stringifyKicadJson(decode(root));
  },
  patch(doc, file, baseline, origin) {
    const mine = parseJsonLossless(file);
    if (!isObj(mine)) throw new Error("sidecar JSON root must be an object");
    const base = baseline !== undefined ? parseJsonLossless(baseline) : undefined;
    let changed = false;
    doc.transact(() => {
      const root = doc.getMap<unknown>(Y_SIDECAR_JSON);
      if (base === undefined || !isObj(base) || root.size === 0) {
        const cur = root.size ? decode(root) : undefined;
        if (sameJ(cur, mine)) return;
        root.clear();
        for (const [k, x] of Object.entries(mine)) root.set(k, encode(x));
        changed = true;
        return;
      }
      changed = patchObject(root, base, mine);
    }, origin);
    return changed;
  },
};

const textCodec: SidecarCodec = {
  kind: "text",
  isEmpty: (doc) => doc.getText(Y_SIDECAR_TEXT).length === 0,
  seed(doc, text, origin) {
    doc.transact(() => doc.getText(Y_SIDECAR_TEXT).insert(0, text), origin);
  },
  render(doc) {
    const t = doc.getText(Y_SIDECAR_TEXT);
    return t.length === 0 ? null : t.toString();
  },
  patch(doc, file, baseline, origin) {
    let changed = false;
    doc.transact(() => {
      const yt = doc.getText(Y_SIDECAR_TEXT);
      if (baseline === undefined || yt.length === 0) {
        if (yt.toString() === file) return;
        yt.delete(0, yt.length);
        yt.insert(0, file);
        changed = true;
        return;
      }
      changed = patchText(yt, baseline, file);
    }, origin);
    return changed;
  },
};

export function sidecarCodecFor(path: string): SidecarCodec | null {
  const kind = sidecarKind(path);
  return kind === "json" ? jsonCodec : kind === "text" ? textCodec : null;
}

/** Render an encoded sidecar room state (server materialize / client fetch). */
export function sidecarUpdateToFile(path: string, update: Uint8Array): string | null {
  const codec = sidecarCodecFor(path);
  if (!codec) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return codec.render(doc);
  } finally {
    doc.destroy();
  }
}

/** Transaction origin of a server-side sidecar rewrite (a file op fixing a reference). */
export const SIDECAR_REWRITE_ORIGIN = "sidecar-file-op-rewrite";

/**
 * The sidecar twin of `computeTextRewriteUpdate` (ydoc-rewrite): rewrite a
 * sidecar room's rendered text as a FORWARD, minimal Yjs update (only the keys /
 * lines the rewrite changed), so history and concurrent edits survive. Null when
 * the path is no sidecar, the room is empty, or the rewrite changes nothing.
 */
export function computeSidecarRewriteUpdate(
  path: string,
  current: Uint8Array,
  rewrite: (text: string) => string,
): { update: Uint8Array; merged: Uint8Array } | null {
  const codec = sidecarCodecFor(path);
  if (!codec) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, current);
    const before = codec.render(doc);
    if (before === null) return null;
    const after = rewrite(before);
    if (after === before) return null;
    const sv = Y.encodeStateVector(doc);
    codec.patch(doc, after, before, SIDECAR_REWRITE_ORIGIN);
    const update = Y.encodeStateAsUpdate(doc, sv);
    if (update.length <= 2) return null;
    return { update, merged: Y.mergeUpdates([current, update]) };
  } finally {
    doc.destroy();
  }
}
