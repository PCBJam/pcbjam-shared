// The few things we need to know about SPICE text. Not a parser.

export interface Subcircuit {
  name: string;
  pins: string[];
  params: string[];
  /** The lines between .subckt and .ends, as written. */
  lines: string[];
}

/**
 * The subcircuits of a model file, by lower-case name, and `outside`: every statement that is
 * not inside a subcircuit (comments left out).
 */
export function subcircuits(text: string): { subs: Map<string, Subcircuit>; outside: string[] } {
  const subs = new Map<string, Subcircuit>();
  const outside: string[] = [];
  const lines = text.split(/\r?\n/);
  let cur: Subcircuit | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(line);
    if (m) {
      let rest = m[2] ?? "";
      while (i + 1 < lines.length && /^\+/.test(lines[i + 1] ?? "")) rest += " " + (lines[++i] ?? "").slice(1);
      const pins: string[] = [];
      const params: string[] = [];
      let inParams = false;
      for (const t of rest.split(/\s+/).filter(Boolean)) {
        if (/^params:$/i.test(t)) { inParams = true; continue; }
        if (t.includes("=")) { inParams = true; params.push(t.split("=")[0] ?? ""); } else if (!inParams) pins.push(t);
      }
      cur = { name: m[1] ?? "", pins, params, lines: [] };
      subs.set(cur.name.toLowerCase(), cur);
      continue;
    }
    if (/^\.ends\b/i.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
    else if (line.trim() && !line.trim().startsWith("*")) outside.push(line);
  }
  return { subs, outside };
}

/**
 * The longest code-model line ("A...") we allow, counted in pieces. A piece is a word or one
 * of < > [ ] ~ %. ngspice does not take lines of any length, so a long connection list is
 * split over several lines instead.
 */
export const CODE_MODEL_LINE_MAX = 240;

/** Every code-model line of a SPICE text with its number of pieces. */
export function codeModelLines(text: string): { name: string; pieces: number }[] {
  const out: { name: string; pieces: number }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (!/^a/i.test(line)) continue;
    while (i + 1 < lines.length && /^\+/.test(lines[i + 1] ?? "")) line += " " + (lines[++i] ?? "").slice(1);
    const pieces = line.match(/[<>[\]~%]|[^\s=(),<>[\]~%]+/g) ?? [];
    out.push({ name: pieces[0] ?? "", pieces: pieces.length });
  }
  return out;
}

const sourceRe = (name: string): RegExp =>
  new RegExp(`^(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+(\\S+)\\s+(\\S+)\\s+dc\\s+(\\S+)\\s*$`, "i");

/** A voltage source "Vname n+ n- dc value" inside a subcircuit, or null. */
export function findSource(sub: Subcircuit, name: string): { name: string; plus: string; minus: string; dc: number } | null {
  if (!name) return null;
  const re = sourceRe(name);
  for (const line of sub.lines) {
    const m = re.exec(line);
    if (m) return { name: m[1] ?? "", plus: m[2] ?? "", minus: m[3] ?? "", dc: Number(m[4]) };
  }
  return null;
}

/** Is there an element of that name inside the subcircuit? */
export function hasElement(sub: Subcircuit, name: string): boolean {
  const lower = name.toLowerCase();
  return sub.lines.some((l) => (l.split(/\s+/)[0] ?? "").toLowerCase() === lower);
}

/**
 * The model text with the named sources of one subcircuit turned into EXTERNAL sources:
 * values the app sets while the simulation runs. The file in the library keeps plain sources,
 * so it loads in any ngspice.
 */
export function withExternalSources(text: string, subckt: string, sources: string[]): string {
  const res = sources.map(sourceRe);
  const want = subckt.toLowerCase();
  let inside = false;
  const done = new Set<number>();
  const out = text.split(/\r?\n/).map((line) => {
    const m = /^\.subckt\s+(\S+)/i.exec(line);
    if (m) inside = (m[1] ?? "").toLowerCase() === want;
    else if (/^\.ends\b/i.test(line)) inside = false;
    else if (inside) {
      for (let k = 0; k < res.length; k++) {
        const s = res[k]?.exec(line);
        if (s) { done.add(k); return `${s[1]} ${s[2]} ${s[3]} dc 0 external`; }
      }
    }
    return line;
  });
  if (done.size !== sources.length) throw new Error(`${subckt}: not every input source was found (${sources.join(", ")})`);
  return out.join("\n");
}
