// What the schematic editor says about a schematic: its symbols, read into the matcher's
// symbols, and its SPICE netlist as KiCad writes it.
//
// The editor's binding `Module.kicadSimSymbols()` (pcbjam: wasm/bindings/sim_symbols.h)
// returns JSON text: every symbol of every sheet with its fields, and each pin's net under
// the name KiCad's SPICE netlist uses. This file checks that text and sorts it:
//   symbols   what gets simulated, ready for matchSymbols()
//   excluded  symbols the user excluded from simulation in KiCad (the symbol itself, or the
//             sheet it is on). KiCad writes no SPICE line for them, and neither do we.
//
// The binding `Module.kicadSimNetlist()` (pcbjam: wasm/bindings/sim_netlist.h) returns the
// netlist of the same schematic, one entry per statement, each marked with the symbol it
// belongs to. readEditorNetlist() checks that text; netlist.ts builds the circuit from it.
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

/** One statement of KiCad's netlist. It can be several text lines (a .model with its "+" lines). */
export interface NetlistLine {
  text: string;
  /** The symbol the statement belongs to. Missing for the title, includes, directives and ".end". */
  ref?: string;
  /** "item": the symbol's own line. "model": a .model KiCad wrote for that symbol. */
  kind?: "item" | "model";
}

/** A symbol KiCad made a SPICE item for. */
export interface NetlistItem {
  ref: string;
  /** The item's name in SPICE ("R1", "XU1"). */
  name: string;
  /** KiCad's kind of device ("R", "D", "NPN", "SUBCKT", ...). Empty: KiCad has no model, the line is a placeholder. */
  device: string;
  /** The model type inside that kind ("", "POT", "DC", ...). */
  type: string;
  /** The symbol's model is disabled in KiCad: it has no line. */
  off: boolean;
}

export interface NetlistMessage {
  severity: "error" | "warning" | "info";
  text: string;
}

export interface EditorNetlist {
  /** The netlist in KiCad's order. The texts joined with line ends are the netlist as KiCad writes it. */
  lines: NetlistLine[];
  /** Every symbol KiCad made a SPICE item for, in netlist order. */
  items: NetlistItem[];
  /** What KiCad's exporter reported (a model file that was not found, ...). */
  messages: NetlistMessage[];
  /** False when the exporter reported an error: the netlist can miss symbols. */
  ok: boolean;
}

/**
 * Reads the answer of `Module.kicadSimNetlist()`: the JSON text, or the value parsed from it.
 * Throws with a plain message when the editor has no schematic open, or when the answer is
 * not what this code expects (an editor build and a page of different versions).
 */
export function readEditorNetlist(answer: unknown): EditorNetlist {
  const bad = (what: string): Error => new Error(`the editor's netlist is not understood: ${what}`);
  let data: unknown = answer;
  if (typeof answer === "string") {
    try { data = JSON.parse(answer); } catch { throw bad("it is not JSON"); }
  }
  if (!isRecord(data)) throw bad("it is not an object");
  if (typeof data.error === "string") throw new Error(`the netlist could not be written: ${data.error}`);
  if (!Array.isArray(data.lines)) throw bad("it has no list of lines");
  if (!Array.isArray(data.items)) throw bad("it has no list of items");

  const lines = data.lines.map((raw: unknown, i): NetlistLine => {
    if (!isRecord(raw) || typeof raw.text !== "string") throw bad(`line ${i} has no text`);
    if (typeof raw.ref !== "string") return { text: raw.text };
    if (raw.kind !== "item" && raw.kind !== "model") throw bad(`line ${i} is of an unknown kind`);
    return { text: raw.text, ref: raw.ref, kind: raw.kind };
  });
  const items = data.items.map((raw: unknown, i): NetlistItem => {
    if (!isRecord(raw) || typeof raw.ref !== "string" || typeof raw.name !== "string" || typeof raw.device !== "string")
      throw bad(`item ${i} has no reference, name or device`);
    return { ref: raw.ref, name: raw.name, device: raw.device, type: typeof raw.type === "string" ? raw.type : "", off: raw.off === true };
  });
  const messages: NetlistMessage[] = [];
  for (const raw of Array.isArray(data.messages) ? data.messages : []) {
    if (!isRecord(raw) || typeof raw.text !== "string") continue;
    messages.push({ severity: raw.severity === "warning" || raw.severity === "info" ? raw.severity : "error", text: raw.text });
  }
  return { lines, items, messages, ok: data.ok === true };
}
