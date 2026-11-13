// What the schematic editor says about a schematic, read into the matcher's symbols.
//
// The editor's binding `Module.kicadSimSymbols()` (pcbjam: wasm/bindings/sim_symbols.h)
// returns JSON text: every symbol of every sheet with its fields, and each pin's net under
// the name KiCad's SPICE netlist uses. This file checks that text and sorts it:
//   symbols   what gets simulated, ready for matchSymbols()
//   excluded  symbols the user excluded from simulation in KiCad (the symbol itself, or the
//             sheet it is on). KiCad writes no SPICE line for them, and neither do we.
import type { SchematicSymbol } from "./match.js";

/** A symbol as the editor reports it. */
export interface EditorSymbol extends SchematicSymbol {
  /** The sheet instance as the editor's sheet navigator names it ("/", "/<sheet uuid>/"). */
  sheetPath: string;
}

export interface EditorSchematic {
  symbols: EditorSymbol[];
  excluded: EditorSymbol[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readSymbol(raw: unknown, at: number): { symbol: EditorSymbol; excluded: boolean } {
  const bad = (what: string): Error => new Error(`the editor's answer is not understood: symbol ${at} ${what}`);
  if (!isRecord(raw)) throw bad("is not an object");
  const text = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string") throw bad(`has no "${key}"`);
    return v;
  };
  if (!isRecord(raw.fields)) throw bad("has no fields");
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.fields)) if (typeof value === "string") fields[name] = value;
  if (!isRecord(raw.pins)) throw bad("has no pins");
  const pins: SchematicSymbol["pins"] = {};
  for (const [number, pin] of Object.entries(raw.pins)) {
    if (!isRecord(pin) || typeof pin.name !== "string") throw bad(`has a pin ${number} without a name`);
    pins[number] = typeof pin.node === "string" && pin.node ? { name: pin.name, node: pin.node } : { name: pin.name };
  }
  const symbol: EditorSymbol = {
    ref: text("ref"), uuid: text("uuid"), sheet: text("sheet"), sheetPath: text("sheetPath"),
    libId: text("libId"), value: text("value"), fields, pins,
  };
  return { symbol, excluded: raw.excluded === true };
}

/**
 * Reads the answer of `Module.kicadSimSymbols()`: the JSON text, or the value parsed from it.
 * Throws with a plain message when the editor has no schematic open, or when the answer is
 * not what this code expects (an editor build and a page of different versions).
 */
export function readEditorSymbols(answer: unknown): EditorSchematic {
  let data: unknown = answer;
  if (typeof answer === "string") {
    try { data = JSON.parse(answer); } catch { throw new Error("the editor's answer is not understood: it is not JSON"); }
  }
  if (!isRecord(data)) throw new Error("the editor's answer is not understood: it is not an object");
  if (typeof data.error === "string") throw new Error(`the schematic could not be read: ${data.error}`);
  if (!Array.isArray(data.symbols)) throw new Error("the editor's answer is not understood: it has no list of symbols");
  const out: EditorSchematic = { symbols: [], excluded: [] };
  data.symbols.forEach((raw, i) => {
    const { symbol, excluded } = readSymbol(raw, i);
    (excluded ? out.excluded : out.symbols).push(symbol);
  });
  return out;
}
