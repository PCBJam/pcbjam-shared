// The netlist step: KiCad's SPICE netlist + the matched library parts -> the circuit that runs.
//
// KiCad writes one line per symbol. For what it can simulate by itself (a resistor, a
// source, a symbol with its own model) the line is real. For a symbol it has no model for,
// the line is one no simulator runs: a placeholder, or a line that names a model nothing
// defines (unusableLines() below). This step
//   - drops KiCad's lines of every symbol that got a library part,
//   - drops the lines no simulator runs (and says which symbols they were): one symbol
//     without a model does not stop the rest of the circuit,
//   - gives a resistor, a capacitor or a coil whose Value says its ratings too ("22uF/25V",
//     "10k 1%") the value alone, and says which (values.ts),
//   - takes out the simulator commands a schematic can carry in its texts (a block from
//     ".control" to ".endc", a line that begins with "*#"), and counts them: the circuit
//     runs, a script that came with the schematic does not (withoutCommands() below),
//   - writes one line per placed library part:
//       X<ref> <one node per pin of the part> <subcircuit> <parameters>
//   - ties the nets of every symbol without a line (left out, switched off or excluded) to
//     ground through a very large resistor, so that a net which only that symbol held still
//     has a voltage,
//   - gives a supply wire whose name states a voltage (+5V) a source, when no source of
//     the schematic sits on it (supplies.ts). A regulator of the library is such a source
//     when a source of the schematic reaches its input,
//   - includes the model file of every part that is used,
//   - gives a part its thermal pins when its symbol names the wires they are on, so that
//     heat is part of the circuit the user draws (thermal.ts).
// The nodes come from the editor's pin-to-net table (kicadSimSymbols). Which of KiCad's
// lines belongs to which symbol comes from the editor too (kicadSimNetlist): nothing here
// guesses it from the text.
import type { LoadedPart, SimLibrary } from "./client.js";
import { chipClock, crystalOn, type ChipClock } from "./clock.js";
import type { EditorNetlist, NetlistLine } from "./editor.js";
import type { PartDigital, PartInput } from "./format.js";
import { leftOutSymbols, type LeftOut } from "./left-out.js";
import { matchSymbols, type Match, type SchematicSymbol } from "./match.js";
import { analogParams, resolveSettings, settingAllows, type ResolvedSettings } from "./settings.js";
import { CODE_MODEL_LINE_MAX, chipFile, chipModel, codeModelLines, withExternalSources } from "./spice-text.js";
import {
  AIR_PARAM, THERMAL_SHOWN, THERMAL_SIGNAL, THERMAL_SUFFIX, thermalFile, thermalModel, thermalPins, thermalRoles, wiresOf, wiresSaid,
  type WireProblem,
} from "./thermal.js";
import { fedParts, namedVolts, powerByName, supplyLines, type AssumedSource, type Passing, type Power, type Socket, type Unpowered } from "./supplies.js";
import { ratedValue, type PassiveKind, type RatedValue } from "./values.js";

/**
 * What ties a net of a left-out symbol to ground: large enough to carry nothing that matters
 * (5 nA at 5 V), small enough for the solver to see it.
 */
export const LEFT_OUT_TIE = "1g";

/** "Run until stopped": a transient analysis with a step ceiling of 1 ms and no end in sight. */
export const LIVE_TRAN = ".tran 1m 100000 0 1m";

/** What a live run starts with when one of its parts asks for Gear's method (PartAnalog.method). */
export const LIVE_GEAR = ".options method=gear";

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/** What the checks of KiCad's lines want to know of a symbol. Without its Value nothing is said about ratings. */
type LineSymbol = Pick<SchematicSymbol, "ref" | "fields"> & Partial<Pick<SchematicSymbol, "value">>;

/**
 * The symbols KiCad took for a resistor, a capacitor or a coil by itself, by reference, with
 * whether it read their Value as a plain value (true) or hands it to the simulator as it
 * is, as a formula (false). A model the user chose on the symbol (the field Sim.Device) is
 * theirs and is not in here.
 */
function guessedPassives(netlist: Pick<EditorNetlist, "items">, symbols: readonly LineSymbol[]): Map<string, { kind: PassiveKind; plain: boolean }> {
  // a symbol that says something about its simulation is not a guess: a model it names
  // (Sim.Device, Sim.Library, Sim.Name), or a value it gives (Sim.Params: r="220", which
  // KiCad takes in place of the Value)
  const silent = new Set(symbols.filter((s) => OWN_MODEL_FIELDS.every((f) => (s.fields[f] ?? "").trim() === "")).map((s) => s.ref));
  const out = new Map<string, { kind: PassiveKind; plain: boolean }>();
  for (const item of netlist.items) {
    const kind = item.device;
    if (!item.off && (kind === "R" || kind === "C" || kind === "L") && silent.has(item.ref)) out.set(item.ref, { kind, plain: item.type !== "=" });
  }
  return out;
}
const OWN_MODEL_FIELDS = ["Sim.Device", "Sim.Params", "Sim.Library", "Sim.Name"] as const;

/** A value read without its ratings, on one symbol. */
export interface ValueRead extends RatedValue {
  ref: string;
  /** The symbol's Value, as typed ("22uF/25V"). */
  typed: string;
}

/**
 * The resistors, capacitors and coils whose Value says their ratings too, and reads as a
 * plain value with ratings that are known (values.ts), by reference. Their line runs with
 * the plain value alone. Only what KiCad took for one of the three by itself is looked at.
 */
export function valuesRead(netlist: Pick<EditorNetlist, "items">, symbols: readonly LineSymbol[]): Map<string, ValueRead> {
  const guessed = guessedPassives(netlist, symbols);
  const out = new Map<string, ValueRead>();
  for (const sym of symbols) {
    // also where KiCad read the Value as a plain one: it reads digits with a blank between
    // them as one number, and "100 0603" as 1000603
    const passive = guessed.get(sym.ref);
    if (!passive || sym.value === undefined) continue;
    const read = ratedValue(sym.value, passive.kind);
    if (read && read !== "unreadable") out.set(sym.ref, { ref: sym.ref, typed: sym.value.trim(), ...read });
  }
  return out;
}

/** KiCad's line of a resistor, a capacitor or a coil with another value: its name and its two nodes stay. */
function withValue(text: string, value: string): string {
  const words = statements(text).join(" ").trim().split(/\s+/);
  // a line that is not a name, two nodes and a value is not rewritten
  return words.length >= 4 ? `${words.slice(0, 3).join(" ")} ${value}` : text;
}

/** Why KiCad's line of a symbol cannot run. */
export type Unusable =
  /** KiCad has no model for the symbol: its line is a placeholder. */
  | "no-model"
  /** KiCad's line names a model that nothing in the netlist defines. */
  | "undefined-model"
  /**
   * KiCad took the symbol for a resistor, a capacitor or a coil, and its Value is no number,
   * or says more than one thing and does not read as a value with its ratings.
   */
  | "no-value"
  /**
   * KiCad has a model for the symbol and wrote no line for it: a resistor, a capacitor or a
   * coil whose own model (the fields Sim.Device and Sim.Params) has no value in it.
   */
  | "no-line";

const statements = (text: string): string[] => text.replace(/\r?\n\+/g, " ").split(/\r?\n/);

// The simulator takes a line for the start of a command block by how it begins, whatever
// follows (".controlx" starts one too), and it carries out a line that begins with "*#"
// as a command wherever it stands. Blanks in front change nothing.
const COMMANDS_START = /^\s*\.control/i;
const COMMANDS_END = /^\s*\.endc/i;
const COMMAND_LINE = /^\s*\*#/;
const CONTINUES = /^\s*\+/;

/**
 * KiCad's lines without the simulator commands a schematic can carry.
 *
 * KiCad puts a text of the sheet that holds a line with a dot in front into its netlist as
 * it is, all of it. Most of that defines the circuit (".model", ".param", ".ic") and stays.
 * Two things in it are something else: a block from ".control" to ".endc", and a line that
 * begins with "*#". Those are a script the simulator carries out when it loads the circuit
 * (run, loop, quit, write a file). It comes with the schematic, whoever drew it, and a run
 * of ours needs none of it, so it is taken out and counted: a block is one, a line is one.
 *
 * A block ends at its ".endc". One that has none ends with the texts of the sheet: the
 * symbols' own lines are never part of it. In a symbol's own line (a field with a line
 * break in it) a block ends with that line at the latest. An ".endc" with no block before
 * it is taken out too, and so are the "+" lines that continue a line that is gone.
 *
 * What comes out holds no line that begins with ".control" or with "*#".
 */
export function withoutCommands(lines: readonly Pick<NetlistLine, "text" | "kind">[]): { texts: string[]; commands: number } {
  const texts: string[] = [];
  let commands = 0;
  let inside = false;
  let gone = false;
  for (const line of lines) {
    const own = line.kind === "item" || line.kind === "model";
    if (own) inside = gone = false;
    const stays: string[] = [];
    for (const one of line.text.split(/\r\n?|\n/)) {
      if (inside) {
        if (COMMANDS_END.test(one)) inside = false;
      } else if (COMMANDS_START.test(one)) {
        inside = gone = true;
        commands++;
      } else if (COMMAND_LINE.test(one)) {
        gone = true;
        commands++;
      } else if (COMMANDS_END.test(one)) {
        gone = true;
      } else if (!(gone && CONTINUES.test(one))) {
        gone = false;
        stays.push(one);
      }
    }
    if (own) inside = gone = false;
    // a text that was nothing but commands is gone; any other line stays
    if (stays.length || !line.text.trim()) texts.push(stays.join("\n"));
  }
  return { texts, commands };
}

/**
 * The symbols whose KiCad line no simulator runs, by reference:
 *   - a placeholder: KiCad has no model for the symbol;
 *   - KiCad's fallback. For a symbol it cannot model (a stock LED, a stock transistor) KiCad
 *     writes a raw line that names the symbol's Value as the model ("D1 a k red",
 *     "Q1 c b e NPN"), and reports its device as "SPICE". When nothing defines that model,
 *     ngspice refuses the whole circuit because of this one line.
 *   - KiCad's guess. A symbol with two pins whose reference starts with R, C or L is a
 *     resistor, a capacitor or a coil to KiCad, with the symbol's Value as its value. A
 *     speaker "LS1" with the Value "Speaker", a varistor "RV1", a resistor that has no
 *     value yet ("R") get a line no simulator reads ("LS1 a b Speaker"), and ngspice
 *     refuses the whole circuit because of it. A model the user chose on the symbol
 *     (the field Sim.Device) is theirs and stays.
 *     A Value of several pieces that KiCad did not read as a plain value is such a line
 *     too, unless it reads as a value with its ratings (valuesRead): "10k/22k" stops the
 *     run, and of "10k DNP" the simulator would take whatever number comes last.
 *   - no line at all. A symbol that names its own model as a resistor, a capacitor or a
 *     coil (Sim.Device) and gives it no value (Sim.Params: c="") has a model and no line:
 *     KiCad writes nothing for it and says nothing, whatever the symbol's Value says.
 * A raw line the user asked for (the symbol's own field Sim.Device says SPICE) is theirs and
 * stays. So does a fallback line when the netlist includes a file: the model can be in
 * there. Without `symbols` only the placeholders are found.
 */
export function unusableLines(netlist: Pick<EditorNetlist, "items" | "lines">, symbols: readonly LineSymbol[] = []): Map<string, Unusable> {
  const out = new Map<string, Unusable>();
  const fallback = new Set<string>();
  const guessed = guessedPassives(netlist, symbols);
  const asked = new Map(symbols.map((s) => [s.ref, (s.fields["Sim.Device"] ?? "").trim().toUpperCase()]));
  for (const item of netlist.items) {
    if (item.off) continue;
    if (item.device === "") out.set(item.ref, "no-model");
    else if (item.device === "SPICE" && asked.has(item.ref) && asked.get(item.ref) !== "SPICE") fallback.add(item.ref);
  }
  // a model and no line: the symbol is not in the circuit (a caller that has no lines at
  // all says nothing about them; a netlist in which no symbol has a line is one in which
  // all of them are missing)
  const written = new Set(netlist.lines.flatMap((l) => (l.kind === "item" && l.ref !== undefined && l.text.trim() ? [l.ref] : [])));
  if (netlist.lines.length) for (const item of netlist.items) if (!item.off && item.device !== "" && !written.has(item.ref)) out.set(item.ref, "no-line");
  // KiCad's guess, a Value of several pieces that KiCad did not read: it has to read as a
  // value with its ratings
  for (const sym of symbols) {
    const passive = guessed.get(sym.ref);
    if (passive && !passive.plain && sym.value !== undefined && ratedValue(sym.value, passive.kind) === "unreadable") out.set(sym.ref, "no-value");
  }
  // KiCad's guess: the value, the word after the two nodes, has to start as a number does
  // ("10k", "4.7uF", ".5"), or be a formula
  for (const line of netlist.lines) {
    if (line.kind !== "item" || line.ref === undefined || !guessed.has(line.ref)) continue;
    const value = statements(line.text).join(" ").trim().split(/\s+/)[3] ?? "";
    if (!/^(?:[+-]?(?:\d|\.\d)|[{'])/.test(value)) out.set(line.ref, "no-value");
  }
  if (!fallback.size) return out;

  // what the netlist itself defines, and whether it reads files we do not see here
  const defined = new Set<string>();
  let includes = false;
  for (const line of netlist.lines) {
    if (line.kind === "item") continue;
    for (const text of statements(line.text)) {
      const def = /^\s*\.(model|subckt)\s+(\S+)/i.exec(text);
      if (def?.[2]) defined.add(def[2].toLowerCase());
      else if (/^\s*\.(include|inc|lib)\b/i.test(text)) includes = true;
    }
  }
  if (includes) return out;
  for (const line of netlist.lines) {
    if (line.kind !== "item" || line.ref === undefined || !fallback.has(line.ref)) continue;
    const words = statements(line.text).join(" ").trim().split(/\s+/).slice(1);
    if (!words.some((w) => defined.has(w.toLowerCase()))) out.set(line.ref, "undefined-model");
  }
  return out;
}

/**
 * The references KiCad itself writes a SPICE line for that a simulator can run. This is what
 * the matcher wants as `kicadModels`. With `symbols`, the lines that name a model nothing
 * defines are left out too (see unusableLines).
 */
export function kicadModels(netlist: Pick<EditorNetlist, "items" | "lines">, symbols: readonly LineSymbol[] = []): Set<string> {
  const unusable = unusableLines(netlist, symbols);
  return new Set(netlist.items.filter((i) => !i.off && !unusable.has(i.ref)).map((i) => i.ref));
}

/** A model file the circuit includes. The engine puts `text` where `path` says before it loads the circuit. */
export interface DeckFile {
  path: string;
  text: string;
}

/** A value the user sets while the simulation runs, on one placed part. */
export interface DeckInput {
  ref: string;
  partId: string;
  /** The input as the part describes it: its name, its kind and its values. */
  input: PartInput;
  /** The simulator's name for the source the engine sets. */
  vector: string;
  /** The value it starts with. */
  initial: number;
}

/** A value the overlay shows, on one placed part. */
export interface DeckSignal {
  ref: string;
  partId: string;
  name: string;
  /** The simulator's name for the current that is read. */
  vector: string;
}

/** The digital half of a part that is used: once per part, however often it is placed. */
export interface DeckCodePart {
  partId: string;
  kind: PartDigital["kind"];
  /**
   * The name the model asks the engine for its code under. A part's id; for a chip that runs
   * an emulator the id and the chip's number ("esp32-c3-wroom-02_1"), so that every placed
   * chip has code, and with it a firmware image, of its own.
   */
  name: string;
  /** Only for an emulator: the placed chip the code is for. */
  ref?: string;
  /** The compiled code of a "part-wasm" part. Null for an emulator: its files are loaded by the step that runs it. */
  logic: Uint8Array | null;
}

/** One symbol that runs as a library part. */
export interface PlacedPart {
  ref: string;
  uuid: string;
  sheet: string;
  partId: string;
  /** The part's version in the library that was used. */
  version: number;
  /** How the symbol found the part: 1 = named on the symbol by hand, 3 = the library knows the symbol. */
  rule: 1 | 3;
  /** The name its line in the circuit starts with ("XSW1"). */
  name: string;
  /** The net of each pin of the part, in the order of the part's pins. */
  nodes: string[];
  /** The pins of the part that have something else connected to them, on the pin or on a pin the part joins it with. */
  connected: string[];
  /** Every setting of the part with its value and where the value came from. */
  settings: ResolvedSettings["values"];
  /** Only for a chip without a board: its clock, and where it comes from. */
  clock?: ChipClock;
  /** Where the part's overlay sits on this symbol, when its "fits" line says so (see PartFit). */
  origin?: [number, number];
  /**
   * Only for a part that is on heat wires: the nets its thermal pins are on, in the
   * pins' order (see thermalPins). They follow `nodes` on the part's line.
   */
  thermal?: string[];
  /**
   * Only for a part with code: its place in the call order of a time step (1, 2, 3, ...).
   * The same number is how the engine and the part's own program tell two placed parts
   * apart. 0 for a part without code.
   */
  number: number;
}

/** A wire that carries heat: a net that a thermal pin of a part is on (thermal.ts). */
export interface DeckWire {
  /** Its name, as the first symbol that names it writes it. */
  name: string;
  /** The net it is in the circuit: 1 V on it is 1 degree Celsius. */
  node: string;
  /** The parts that give their heat to it, by reference. */
  heat: string[];
  /** The parts that are as warm as it. */
  feel: string[];
  /** The parts that move air to or from it. */
  air: string[];
}

/** A symbol that names heat wires and is on none. */
export interface NotOnWire {
  ref: string;
  /** What its field says. */
  said: string;
  /**
   * Why: the field does not name the wires of the part's thermal pins ("wires", with the
   * part's title and what is wrong), the symbol's part has no thermal pin ("part", with
   * the part's title), or nothing of the library runs the symbol ("no-part").
   */
  why: "wires" | "part" | "no-part";
  title?: string;
  problem?: WireProblem;
}

export interface Deck {
  /** The circuit, line by line, as the simulator takes it. */
  deck: string[];
  /** The model files the circuit includes. */
  files: DeckFile[];
  inputs: DeckInput[];
  signals: DeckSignal[];
  codeParts: DeckCodePart[];
  placed: PlacedPart[];
  /**
   * Symbols that neither the library nor KiCad has a model for, by reference. They are left
   * out of the circuit, and the rest runs without them.
   */
  notSimulated: string[];
  /**
   * Every symbol the run leaves out, with its reason: no value, no part, nothing to
   * simulate, switched off (left-out.ts). `notSimulated` are the ones of them that neither
   * the library nor KiCad has a model for.
   */
  leftOut: LeftOut[];
  /**
   * The resistors, capacitors and coils that run with the value of their Value alone, without
   * the ratings it says too ("22uF/25V" as 22uF), by reference.
   */
  valuesRead: ValueRead[];
  /**
   * How many simulator commands the schematic carries: a block from ".control" to ".endc"
   * is one, a line that begins with "*#" is one. They are not in the circuit: see
   * withoutCommands.
   */
  commandsLeftOut: number;
  /**
   * Which symbol each line of the circuit belongs to, by the name of the line's element in
   * lower case ("r1", "xu1"): KiCad's own lines and the lines written here for the library's
   * parts. A simulator names lines and elements, never symbols (see symbolsNamed).
   */
  marks: Map<string, string>;
  /** The supply wires the circuit powers by their names, and the ones whose names state no voltage. */
  power: Power;
  /** The wires that carry heat, by name. */
  wires: DeckWire[];
  /** The symbols that name heat wires and are on none. */
  notOnWire: NotOnWire[];
  /** What the user should know. It does not stop the run. */
  notes: string[];
  /** What stops the run. Empty: the circuit can go to the simulator. */
  errors: string[];
}

export interface BuildOptions {
  /** The symbols that take part, as the editor reported them. */
  symbols: SchematicSymbol[];
  /** The symbols KiCad excludes from simulation. They have no line; their nets are tied to ground like those of a left-out symbol. */
  excluded?: (Pick<SchematicSymbol, "pins"> & Partial<SchematicSymbol>)[];
  /** KiCad's netlist of the same schematic. */
  netlist: EditorNetlist;
  /** matchSymbols() of exactly these symbols: `plan[i]` is about `symbols[i]`. */
  plan: Match[];
  /** The loaded part of every matched symbol, by part id. */
  parts: Map<string, LoadedPart>;
  /**
   * true (the default): the parts' inputs become sources the app sets while it runs, and the
   * run never ends. false: a plain circuit that any ngspice takes; it has no analysis line.
   */
  live?: boolean;
  /** Where the engine keeps a part's model file. */
  modelPath?: (partId: string, file: string) => string;
}

function initialValue(input: PartInput): number {
  if (input.type === "momentary") return input.released;
  if (input.type === "range") return input.default;
  return input.default === "on" ? input.on : input.off;
}

export function buildDeck({ symbols, excluded = [], netlist, plan, parts, live = true, modelPath = (id, file) => `/sim-library/${id}/${file}` }: BuildOptions): Deck {
  if (plan.length !== symbols.length) throw new Error("the plan is not about these symbols");
  const errors: string[] = [];
  const notes: string[] = [];

  if (!netlist.ok) {
    const said = netlist.messages.filter((m) => m.severity === "error").map((m) => `KiCad: ${m.text}`);
    errors.push(...(said.length ? said : ["KiCad could not write the netlist of this schematic"]));
  }
  for (const m of netlist.messages) if (m.severity === "warning") notes.push(`KiCad: ${m.text}`);

  const items = new Map(netlist.items.map((i) => [i.ref, i]));
  const matched: { m: Extract<Match, { status: "matched" }>; sym: SchematicSymbol }[] = [];
  plan.forEach((m, i) => {
    const sym = symbols[i];
    if (m.status === "matched" && sym) matched.push({ m, sym });
  });
  matched.sort((a, b) => natural(a.m.ref, b.m.ref));

  // 1. one line per matched symbol
  const lines: string[] = [];
  const files: DeckFile[] = [];
  const inputs: DeckInput[] = [];
  const signals: DeckSignal[] = [];
  const codeParts: DeckCodePart[] = [];
  const placed: PlacedPart[] = [];
  /** The model text of each part that is in the circuit, as the run takes it. */
  const used = new Map<string, string>();
  /** The nets a source sits on: no power by name for them. */
  const driven = new Set<string>();
  /** The sources that run with their part's own voltage. */
  const assumed: AssumedSource[] = [];
  /** The parts with nothing connected to a pin they take their power through. */
  const noPower: Unpowered[] = [];
  /** The parts that pass power on (regulators): a source only when one reaches their input. */
  const passing: Passing[] = [];
  /** The sockets power can come in through, with what each does in this run. */
  const sockets: Socket[] = [];
  /** The nets each simulated part that is not a chip joins: power on one reaches the others. */
  const links: string[][] = [];
  /** The nets of the schematic: a symbol names the wire of a thermal pin among them. */
  const netNames = [...new Set([...symbols, ...excluded].flatMap((s) => Object.values(s.pins).flatMap((p) => (p.node ? [p.node] : []))))];
  /** The wires that carry heat, by the name the circuit knows their net under. */
  const wires = new Map<string, DeckWire>();
  const notOnWire: NotOnWire[] = [];
  /** The parts whose model with thermal pins is in the circuit. */
  const thermalUsed = new Set<string>();
  /** A part asks for Gear's method. */
  let gear = false;
  let order = 0;
  for (const { m, sym } of matched) {
    if (items.get(m.ref)?.off) {
      notes.push(`${m.ref}: its model is switched off in KiCad, so it is left out`);
      continue;
    }
    const part = parts.get(m.partId);
    if (!part) {
      errors.push(`${m.ref}: the library part "${m.partId}" is not loaded`);
      continue;
    }
    const man = part.manifest;
    const settings = resolveSettings(man, sym, m.set);
    notes.push(...settings.notes);
    // A pin without a net gets a node of its own, named the way KiCad names a net with one pin.
    const nodes = m.pinMap.map((n) => sym.pins[n]?.node ?? `unconnected-${m.ref}-${n}`);
    // KiCad calls a net with nothing else on it "unconnected-...". Pins the part joins inside
    // (a board's ground pins) are one net: a wire on one of them is a wire on each.
    const alone = (pin: string): boolean => /^unconnected-/i.test(nodes[man.pins.indexOf(pin)] ?? "unconnected-");
    const wired = (pin: string): boolean => (man.joined?.find((group) => group.includes(pin)) ?? [pin]).some((p) => !alone(p));
    // A chip without its supply does nothing, and looks like a part that is broken.
    const open = (man.powered ?? []).flatMap((pin) => {
      const i = man.pins.indexOf(pin);
      return i >= 0 && !wired(pin) ? [m.pinMap[i] ?? pin] : [];
    });
    if (open.length) noPower.push({ ref: m.ref, pins: open.sort(natural) });
    if (man.analog.method === "gear") gear = true;
    // A socket is a source only while its setting says that something is plugged in. One that
    // is not is as if it were not there: its model leaves its pins open.
    const socket = man.supplies?.length && !man.suppliesFrom?.length ? man.suppliesWhen : undefined;
    const feeds = !socket || settings.values[socket.setting]?.value === socket.on;
    // A socket whose Value says no voltage, between wires whose names say one (a jack between
    // "+12V" and "GND"): the board says what it is fed with, and that goes before the part's
    // own voltage. The voltage is that of the first pin of `supplies` against the second.
    const volts = socket ? man.settings?.find((s) => s.unit === "V") : undefined;
    if (volts?.fromValue && settings.values[volts.name]?.from === "default" && man.supplies?.length === 2) {
      const [plus, minus] = man.supplies.map((pin) => namedVolts(nodes[man.pins.indexOf(pin)] ?? ""));
      const named = plus != null && minus != null ? String(Math.round((plus - minus) * 1000) / 1000) : "";
      if (named && named !== "0" && settingAllows(volts, named)) settings.values[volts.name] = { value: named, from: "wire" };
    }
    const params = Object.entries(analogParams(man, settings)).map(([k, v]) => `${k}=${v}`);
    if (socket) {
      params.push(`${socket.param}=${feeds ? 1 : 0}`);
      const got = volts ? settings.values[volts.name] : undefined;
      sockets.push({
        ref: m.ref, title: man.title, feeds, volts: got?.value ?? "", label: volts?.label ?? "Voltage",
        assumed: !!volts?.fromValue && got?.from === "default", ...(got?.from === "wire" ? { fromWire: true } : {}),
        setting: socket.setting, on: socket.on,
      });
    }
    const number = man.digital ? ++order : 0;
    if (man.digital) params.push(`${man.digital.orderParam}=${number}`);
    const name = `X${m.ref}`;
    // A chip that runs firmware has its model to itself (see chipModel), under a name of its own.
    const own = man.digital?.kind === "emulator" ? `_${number}` : "";
    // The wires the symbol names for its part's thermal pins. On them the part runs as its
    // model with those pins after its own (see thermalModel).
    const thermal = man.thermal;
    const said = wiresSaid(sym);
    let onWires: string[] | undefined;
    if (said.length && !thermal) notOnWire.push({ ref: m.ref, said: said.join(" "), why: "part", title: man.title });
    else if (said.length && thermal) {
      const found = wiresOf(sym, thermalPins(thermalRoles(thermal)).length, netNames);
      if (found && "problem" in found) notOnWire.push({ ref: m.ref, said: said.join(" "), why: "wires", title: man.title, problem: found.problem });
      else if (found) onWires = found.nodes;
    }
    const given = (v: string): string => (v.startsWith("$") ? settings.values[v.slice(1)]?.value ?? "0" : v);
    if (onWires && thermal?.air) params.push(`${AIR_PARAM}=${given(thermal.air.full)}`);
    const warmInput = onWires ? thermal?.temperature : undefined;
    lines.push(`${name} ${[...nodes, ...(onWires ?? [])].join(" ")} ${man.analog.subckt}${own}${onWires ? THERMAL_SUFFIX : ""}${params.length ? " " + params.join(" ") : ""}`);
    // A source (a battery): the wires on its supply pins have their power from it. When the
    // symbol's Value does not say its voltage, it runs with the part's own, and the run says so.
    // A part that passes power on (a regulator) is a source only when one reaches its input.
    const netsOf = (pins: readonly string[]): string[] => pins.flatMap((pin) => {
      const node = nodes[man.pins.indexOf(pin)];
      return node === undefined ? [] : [node];
    });
    if (man.supplies?.length && man.suppliesFrom?.length) {
      const pins = man.suppliesFrom.flatMap((pin) => {
        const i = man.pins.indexOf(pin);
        return i >= 0 ? [m.pinMap[i] ?? pin] : [];
      });
      passing.push({ ref: m.ref, pins: pins.sort(natural), from: netsOf(man.suppliesFrom), to: netsOf(man.supplies) });
    } else if (feeds) {
      for (const node of netsOf(man.supplies ?? [])) driven.add(node);
      if (!man.powered?.length) links.push(nodes);
    }
    // a socket says its own voltage in its own sentence
    if (man.supplies?.length && !socket) {
      for (const s of man.settings ?? []) {
        const got = settings.values[s.name];
        if (s.fromValue && got?.from === "default") assumed.push({ ref: m.ref, label: s.label ?? s.name, value: got.value, unit: s.unit ?? "" });
      }
    }

    const first = !used.has(m.partId);
    if (first) {
      const sources = (man.inputs ?? []).map((i) => i.source);
      let text = part.analog;
      if (live && sources.length) {
        try { text = withExternalSources(part.analog, man.analog.subckt, sources); } catch (err) { errors.push(`${m.partId}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      used.set(m.partId, text);
    }
    if (own) {
      // one model and one piece of code per placed chip
      const code = `${m.partId}${own}`;
      try {
        files.push({ path: modelPath(m.partId, chipFile(man.analog.file, number)), text: chipModel(used.get(m.partId) ?? "", man.analog.subckt, m.partId, own) });
      } catch (err) {
        errors.push(`${m.ref}: ${err instanceof Error ? err.message : String(err)}`);
      }
      codeParts.push({ partId: m.partId, kind: "emulator", name: code, ref: m.ref, logic: null });
    } else if (first) {
      files.push({ path: modelPath(m.partId, man.analog.file), text: used.get(m.partId) ?? "" });
      if (man.digital) codeParts.push({ partId: m.partId, kind: man.digital.kind, name: m.partId, logic: part.logic });
    }

    const inst = `x${m.ref.toLowerCase()}`;
    if (onWires && thermal && !thermalUsed.has(m.partId)) {
      // the part's model with its thermal pins
      thermalUsed.add(m.partId);
      const current = (signal: string | undefined): string | undefined => (signal === undefined ? undefined : man.signals?.find((s) => s.name === signal)?.current ?? "");
      const others = (man.inputs ?? []).filter((i) => i.name !== warmInput).map((i) => i.source);
      try {
        let text = thermalModel(part.analog, man.analog.subckt, {
          ...(warmInput !== undefined ? { temperature: man.inputs?.find((i) => i.name === warmInput)?.source ?? "" } : {}),
          ...(thermal.heat !== undefined ? { heat: current(thermal.heat) } : {}),
          ...(thermal.air ? { air: current(thermal.air.signal) } : {}),
        });
        if (live && others.length) text = withExternalSources(text, `${man.analog.subckt}${THERMAL_SUFFIX}`, others);
        files.push({ path: modelPath(m.partId, thermalFile(man.analog.file)), text });
      } catch (err) {
        errors.push(`${m.partId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const input of man.inputs ?? [])
      if (input.name !== warmInput) inputs.push({ ref: m.ref, partId: m.partId, input, vector: `v.${inst}.${input.source.toLowerCase()}`, initial: initialValue(input) });
    for (const s of man.signals ?? [])
      signals.push({ ref: m.ref, partId: m.partId, name: s.name, vector: `v.${inst}.${s.current.toLowerCase()}#branch` });
    if (onWires && thermal) {
      // which wire each thermal pin is on, and the temperature of the part's own wire
      thermalPins(thermalRoles(thermal)).forEach((pin, i) => {
        const node = onWires[i] ?? "";
        const wire = wires.get(node.toLowerCase()) ?? { name: said[i] ?? node, node, heat: [], feel: [], air: [] };
        wires.set(node.toLowerCase(), wire);
        if (pin.does === "air") { if (!wire.air.includes(m.ref)) wire.air.push(m.ref); return; }
        if (pin.does !== "feels") wire.heat.push(m.ref);
        if (pin.does !== "heats") wire.feel.push(m.ref);
        signals.push({ ref: m.ref, partId: m.partId, name: THERMAL_SIGNAL, vector: `v.${inst}.${THERMAL_SHOWN.toLowerCase()}#branch` });
      });
    }
    // a chip without a board: its clock is what the schematic has on its clock pins, or a setting
    const crystal = man.digital?.kind === "emulator" ? man.digital.crystal : undefined;
    const clock = man.digital?.kind === "emulator" && crystal
      ? chipClock(man.digital, settings.values[crystal.setting]?.value, crystalOn([nodes[man.pins.indexOf(crystal.pins[0])], nodes[man.pins.indexOf(crystal.pins[1])]], symbols, m.ref))
      : undefined;
    placed.push({
      ref: m.ref, uuid: m.uuid, sheet: m.sheet, partId: m.partId, version: man.version, rule: m.rule, name, nodes,
      // the pins of a crystal that clocks the chip are its oscillator: no pads, nothing to drive or read
      connected: man.pins.filter((pin) => wired(pin) && !(clock?.from === "crystal" && crystal?.pins.includes(pin))),
      settings: settings.values, number,
      ...(clock ? { clock } : {}),
      ...(m.origin ? { origin: m.origin } : {}),
      ...(onWires ? { thermal: onWires } : {}),
    });
  }
  // a symbol that names heat wires and that no library part runs
  const mine = new Set(placed.map((p) => p.ref));
  for (const sym of symbols) {
    const said = wiresSaid(sym);
    if (said.length && !mine.has(sym.ref) && !notOnWire.some((n) => n.ref === sym.ref)) notOnWire.push({ ref: sym.ref, said: said.join(" "), why: "no-part" });
  }
  notOnWire.sort((a, b) => natural(a.ref, b.ref));
  const wireList = [...wires.values()].sort((a, b) => natural(a.name, b.name));

  // 2. KiCad's netlist without the lines we replace and without the lines no simulator runs
  const unusable = unusableLines(netlist, symbols);
  const notSimulated = [...unusable.keys()].filter((ref) => !mine.has(ref)).sort(natural);
  // a crystal that clocks a chip does its job in the run: it is not left out
  const clocking = placed.flatMap((p) => (p.clock?.from === "crystal" && p.clock.crystal ? [p.clock.crystal] : []));
  const leftOut = leftOutSymbols({ symbols, plan, excluded, items: netlist.items, unusable, placed: new Set([...mine, ...clocking]) });
  // KiCad's lines by the names KiCad gave them, ours by the names given above ("X" and the reference)
  const marks = new Map<string, string>();
  for (const item of netlist.items) if (!item.off) marks.set(item.name.toLowerCase(), item.ref);
  for (const p of placed) marks.set(p.name.toLowerCase(), p.ref);
  const keptLines = netlist.lines.filter((l) => l.ref === undefined || !(mine.has(l.ref) || unusable.has(l.ref)));
  // a Value that says its ratings too: the line runs with the value alone
  const read = valuesRead(netlist, symbols);
  const readOf = (l: NetlistLine): ValueRead | undefined => (l.kind === "item" && l.ref !== undefined ? read.get(l.ref) : undefined);
  // and without the simulator commands the schematic carries
  const { texts: kept, commands: carried } = withoutCommands(keptLines.map((l) => {
    const value = readOf(l);
    return { text: value ? withValue(l.text, value.value) : l.text, kind: l.kind };
  }));
  const valuesUsed = keptLines.flatMap((l) => readOf(l) ?? []).sort((a, b) => natural(a.ref, b.ref));
  if (/^\.end\s*$/i.test(kept[kept.length - 1] ?? "")) kept.pop();
  // The first line of a SPICE circuit is its title, whatever it says.
  const title = kept.shift() ?? ".title KiCad schematic";

  // 3. A symbol without a line (left out, switched off or excluded in KiCad) leaves the nets
  // of its pins behind. A net that nothing else holds (a resistor between two chips that are
  // both left out) has no path to ground, and the simulator finds no voltage for it. Each of
  // those nets gets a path. A net with this pin alone ("unconnected-...") is in no line.
  const hasLine = new Set([...mine, ...keptLines.flatMap((l) => (l.kind === "item" && l.ref !== undefined ? [l.ref] : []))]);
  const ties = new Set<string>();
  for (const sym of [...symbols.filter((s) => !hasLine.has(s.ref)), ...excluded])
    for (const pin of Object.values(sym.pins))
      if (pin.node && !/^(0|gnd)$/i.test(pin.node) && !/^unconnected-/i.test(pin.node)) ties.add(pin.node);
  const tied = [...ties].sort(natural).map((node, i) => `Rpj_left_${i + 1} ${node} 0 ${LEFT_OUT_TIE}`);

  // 4. Power. A real schematic draws no source: its supply wires are only named. A wire
  // whose name states a voltage gets a source of ours, unless a source of the schematic
  // sits on it: a voltage source KiCad wrote a line for, or a library part that is one.
  for (const l of keptLines) {
    if (l.kind !== "item") continue;
    for (const statement of statements(l.text)) {
      const words = statement.trim().split(/\s+/);
      if (/^v/i.test(words[0] ?? "")) for (const node of words.slice(1, 3)) driven.add(node);
      // what KiCad wrote a line for and power passes through: a resistor, a coil, a diode
      // (two nodes), a transistor (three)
      else if (/^[rld]/i.test(words[0] ?? "")) links.push(words.slice(1, 3));
      else if (/^[qmj]/i.test(words[0] ?? "")) links.push(words.slice(1, 4));
    }
  }
  const nets = [...symbols, ...excluded].flatMap((s) => Object.values(s.pins).flatMap((p) => (p.node ? [p.node] : [])));
  const { fed, unfed } = fedParts(nets, driven, links, passing);
  for (const p of passing) if (fed.has(p.ref)) for (const node of p.to) driven.add(node);
  const power: Power = { ...powerByName(nets, driven), assumed, noPower, unfed, sockets: sockets.sort((a, b) => natural(a.ref, b.ref)) };

  // Nothing that goes to the simulator is a command, wherever its text came from: the lines
  // written here are looked through as well, each on its own.
  const whole = withoutCommands([
    title, ...files.map((f) => `.include "${f.path}"`), ...kept.flatMap((t) => t.split("\n")),
    ...lines, ...tied, ...supplyLines(power.byName),
  ].map((text) => ({ text, kind: "item" as const })));
  const deck = whole.texts.flatMap((t) => t.split("\n"));
  const commandsLeftOut = carried + whole.commands;
  if (live) deck.push(...(gear ? [LIVE_GEAR] : []), LIVE_TRAN);
  deck.push(".end");

  // 5. the simulator does not take a code-model line of any length
  for (const [where, text] of [["the circuit", deck.join("\n")], ...files.map((f) => [f.path, f.text])] as [string, string][])
    for (const l of codeModelLines(text))
      if (l.pieces > CODE_MODEL_LINE_MAX)
        errors.push(`${where}: the line of ${l.name} is too long for the simulator (${l.pieces} pieces, at most ${CODE_MODEL_LINE_MAX})`);

  return { deck, files, inputs, signals, codeParts, placed, notSimulated, leftOut, valuesRead: valuesUsed, commandsLeftOut, marks, power, wires: wireList, notOnWire, notes, errors };
}

export interface PrepareOptions {
  library: Pick<SimLibrary, "index" | "loadPart">;
  symbols: SchematicSymbol[];
  /** The symbols KiCad excludes from simulation (see BuildOptions). */
  excluded?: BuildOptions["excluded"];
  netlist: EditorNetlist;
  /** Symbol uuid -> part id or "off": a pick that is not written on the symbol (yet). */
  overrides?: Record<string, string>;
  live?: boolean;
  modelPath?: (partId: string, file: string) => string;
}

export interface PreparedRun extends Deck {
  /** One line per symbol: `plan[i]` is about `symbols[i]`. */
  plan: Match[];
  /** The loaded parts that are used, by part id. */
  parts: Map<string, LoadedPart>;
}

/** The whole way from an open library and a schematic to a circuit: match, load the parts, build. */
export async function prepareRun({ library, symbols, excluded, netlist, overrides, live, modelPath }: PrepareOptions): Promise<PreparedRun> {
  const plan = matchSymbols(library.index, symbols, { overrides, kicadModels: kicadModels(netlist, symbols) });
  const ids = [...new Set(plan.flatMap((m) => (m.status === "matched" ? [m.partId] : [])))];
  const loaded = await Promise.all(ids.map((id) => library.loadPart(id)));
  const parts = new Map(loaded.map((p) => [p.id, p]));
  return { plan, parts, ...buildDeck({ symbols, excluded, netlist, plan, parts, live, modelPath }) };
}
