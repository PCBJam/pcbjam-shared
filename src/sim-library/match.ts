// Which library part does a symbol get? (simulation 0004: looked up at every Play, nothing
// is written into the schematic.)
//
// Input: the library index and the symbols of the schematic. Output: one line per symbol.
// Checked from top to bottom, the first hit wins:
//   1. a field on the symbol names a part: PCBJam.SimPart holds a part id, or "off"
//   2. the user attached their own SPICE model (the fields Sim.Library or Sim.Name): it is
//      kept and runs as plain analog
//   3. the library has a line for exactly this symbol:  fits: { symbol: "Switch:SW_Push" }
//      or for the symbol plus its value:                 fits: { symbol: "Device:Q_NPN_*", value: "NPN" }
//      The most specific line wins; a line with a value is more specific than one without.
//   4. the library only knows the value (a custom symbol): the part is SUGGESTED and nothing
//      is simulated until the user says yes. That yes is stored as rule 1.
//   5. nothing fits: KiCad's own model if the symbol has one, else it is not simulated.
//
// KiCad's own SPICE line is NOT a sign that a symbol simulates: for a stock LED or transistor
// KiCad writes a line that names the symbol's Value as the model ("D1 a k red"), and nothing
// defines that model. So a library part (rule 3) beats KiCad's line (rule 5).
import type { IndexPart, LibraryIndex, PartFit } from "./format.js";

/** The field that names a symbol's part by hand (rule 1). */
export const FIELD_PART = "PCBJam.SimPart";
/** The field that holds the settings a user changed on a placed part. */
export const FIELD_SETTINGS = "PCBJam.SimSettings";

/** A symbol of the schematic, as the matcher needs it. */
export interface SchematicSymbol {
  ref: string;
  uuid: string;
  /** The sheet instance the symbol is on (a sheet used twice gives two symbols). */
  sheet: string;
  /** "Library:Name" */
  libId: string;
  value: string;
  fields: Record<string, string>;
  /** Pin number -> its name and the net it is on. */
  pins: Record<string, { name: string; node?: string }>;
}

interface Base { ref: string; uuid: string; sheet: string; libId: string; value: string }
export interface Candidate { partId: string; title: string; fits?: boolean; reason?: string }

export type Match = Base & (
  /** The part is used. pinMap[i] is the symbol pin number the part's pin i goes to. */
  | { status: "matched"; rule: 1 | 3; partId: string; pinMap: string[]; unusedPins: string[] }
  /** The user switched simulation off for this symbol. */
  | { status: "off"; rule: 1 }
  /** A part was found and cannot be used; `reason` says why in plain words. */
  | { status: "error"; rule: 1 | 3; partId?: string; reason: string }
  /** Two parts fit equally well; the user has to pick. */
  | { status: "choice"; rule: 3; candidates: Candidate[] }
  /** Offered, not used until the user confirms. */
  | { status: "suggested"; rule: 4; candidates: Candidate[] }
  /** Left to KiCad: the user's own model (rule 2, own = true) or KiCad's line (rule 5). */
  | { status: "kicad"; rule: 2 | 5; own: boolean }
  /** Not simulated. */
  | { status: "none"; rule: 5 }
);

const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const glob = (pattern: string, flags?: string): RegExp =>
  new RegExp("^" + esc(pattern).replace(/\*/g, ".*").replace(/\?/g, ".") + "$", flags);

/** How well a "fits" line of a part matches a symbol: 0 = not at all. */
function fitScore(fit: PartFit, sym: SchematicSymbol): number {
  if (fit.symbol && !glob(fit.symbol).test(sym.libId)) return 0;
  if (fit.value && !glob(fit.value, "i").test(sym.value)) return 0;
  return (fit.value ? 4 : 0) + (fit.symbol ? (fit.symbol.includes("*") ? 1 : 2) : 0);
}

export type PinResult = { ok: true; map: string[]; unused: string[] } | { ok: false; reason: string };

/**
 * Which pin of the symbol each pin of the part goes to. A "fits" line says how: "number",
 * "name" or a table (see PinStyle). The table belongs to the "fits" line because one part can
 * fit several symbols. Refused when the pins do not line up.
 */
export function resolvePins(part: Pick<IndexPart, "pins">, fit: PartFit | undefined, sym: SchematicSymbol): PinResult {
  const style = fit?.pins ?? "number";
  const numbers = Object.keys(sym.pins);
  const map: string[] = [];
  const missing: string[] = [];
  for (const p of part.pins) {
    let n: string | undefined;
    if (style === "number") n = p;
    else if (style === "name") {
      const hits = numbers.filter((k) => sym.pins[k]?.name === p);
      if (hits.length > 1) return { ok: false, reason: `the symbol has ${hits.length} pins named ${p}` };
      n = hits[0];
    } else n = style[p];
    if (n === undefined || !sym.pins[n]) missing.push(p);
    else map.push(n);
  }
  if (missing.length) return { ok: false, reason: `the symbol has no pin for ${missing.join(", ")}` };
  if (new Set(map).size !== map.length) return { ok: false, reason: "two pins of the part go to one pin of the symbol" };
  const used = new Set(map);
  return { ok: true, map, unused: numbers.filter((k) => !used.has(k)) };
}

function matchOne(byId: Map<string, IndexPart>, parts: IndexPart[], sym: SchematicSymbol, override: string | undefined, hasKicadModel: boolean): Match {
  const base: Base = { ref: sym.ref, uuid: sym.uuid, sheet: sym.sheet, libId: sym.libId, value: sym.value };
  const named = (override !== undefined ? override : sym.fields[FIELD_PART] ?? "").trim();

  if (named) {                                                        // rule 1
    if (named.toLowerCase() === "off") return { ...base, status: "off", rule: 1 };
    const part = byId.get(named);
    if (!part) return { ...base, status: "error", rule: 1, reason: `the library has no part "${named}"` };
    // the pin table: a "fits" line written for this symbol first, then any line that works
    const fits = [...part.fits].sort((a, b) => fitScore(b, sym) - fitScore(a, sym));
    let reason = "the part lists no symbol it fits";
    for (const fit of fits) {
      const r = resolvePins(part, fit, sym);
      if (r.ok) return { ...base, status: "matched", rule: 1, partId: part.id, pinMap: r.map, unusedPins: r.unused };
      reason = r.reason;
    }
    return { ...base, status: "error", rule: 1, partId: part.id, reason: `"${named}" does not fit this symbol: ${reason}` };
  }

  if (sym.fields["Sim.Library"] || sym.fields["Sim.Name"]) return { ...base, status: "kicad", rule: 2, own: true };   // rule 2

  const hits: { part: IndexPart; fit: PartFit; score: number }[] = [];
  for (const part of parts)
    for (const fit of part.fits) {
      const score = fitScore(fit, sym);
      if (score) hits.push({ part, fit, score });
    }

  const sure = hits.filter((h) => h.fit.symbol);                      // rule 3
  if (sure.length) {
    const best = Math.max(...sure.map((h) => h.score));
    const top = sure.filter((h) => h.score === best);
    const ids = [...new Set(top.map((h) => h.part.id))];
    const first = top[0];
    if (ids.length > 1 || !first)
      return { ...base, status: "choice", rule: 3, candidates: ids.map((id) => ({ partId: id, title: byId.get(id)?.title ?? id })) };
    const r = resolvePins(first.part, first.fit, sym);
    if (!r.ok) return { ...base, status: "error", rule: 3, partId: first.part.id, reason: `"${first.part.id}" does not fit this symbol: ${r.reason}` };
    return { ...base, status: "matched", rule: 3, partId: first.part.id, pinMap: r.map, unusedPins: r.unused };
  }

  const maybe: Candidate[] = [];                                      // rule 4
  for (const h of hits) {
    if (maybe.some((c) => c.partId === h.part.id)) continue;
    const r = resolvePins(h.part, h.fit, sym);
    maybe.push(r.ok ? { partId: h.part.id, title: h.part.title, fits: true } : { partId: h.part.id, title: h.part.title, fits: false, reason: r.reason });
  }
  if (maybe.length) return { ...base, status: "suggested", rule: 4, candidates: maybe };

  return hasKicadModel ? { ...base, status: "kicad", rule: 5, own: false } : { ...base, status: "none", rule: 5 };   // rule 5
}

export interface MatchOptions {
  /** Symbol uuid -> part id or "off": a pick that is not written on the symbol (yet). */
  overrides?: Record<string, string>;
  /** The references KiCad wrote a SPICE line with a real model for. */
  kicadModels?: Set<string>;
}

export function matchSymbols(index: Pick<LibraryIndex, "parts">, symbols: SchematicSymbol[], { overrides = {}, kicadModels = new Set() }: MatchOptions = {}): Match[] {
  const byId = new Map(index.parts.map((p) => [p.id, p]));
  return symbols.map((sym) => matchOne(byId, index.parts, sym, overrides[sym.uuid], kicadModels.has(sym.ref)));
}
