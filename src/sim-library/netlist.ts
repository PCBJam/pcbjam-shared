// The netlist step: KiCad's SPICE netlist + the matched library parts -> the circuit that runs.
//
// KiCad writes one line per symbol. For what it can simulate by itself (a resistor, a
// source, a symbol with its own model) the line is real. For a symbol it has no model for,
// the line is one no simulator runs: a placeholder, or a line that names a model nothing
// defines (unusableLines() below). This step
//   - drops KiCad's lines of every symbol that got a library part,
//   - drops the lines no simulator runs (and says which symbols they were): one symbol
//     without a model does not stop the rest of the circuit,
//   - writes one line per placed library part:
//       X<ref> <one node per pin of the part> <subcircuit> <parameters>
//   - ties the nets of every symbol without a line (left out, switched off or excluded) to
//     ground through a very large resistor, so that a net which only that symbol held still
//     has a voltage,
//   - includes the model file of every part that is used.
// The nodes come from the editor's pin-to-net table (kicadSimSymbols). Which of KiCad's
// lines belongs to which symbol comes from the editor too (kicadSimNetlist): nothing here
// guesses it from the text.
import type { LoadedPart, SimLibrary } from "./client.js";
import type { EditorNetlist } from "./editor.js";
import type { PartDigital, PartInput } from "./format.js";
import { matchSymbols, type Match, type SchematicSymbol } from "./match.js";
import { analogParams, resolveSettings, type ResolvedSettings } from "./settings.js";
import { CODE_MODEL_LINE_MAX, codeModelLines, withExternalSources } from "./spice-text.js";

/**
 * What ties a net of a left-out symbol to ground: large enough to carry nothing that matters
 * (5 nA at 5 V), small enough for the solver to see it.
 */
export const LEFT_OUT_TIE = "1g";

/** "Run until stopped": a transient analysis with a step ceiling of 1 ms and no end in sight. */
export const LIVE_TRAN = ".tran 1m 100000 0 1m";

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/** Why KiCad's line of a symbol cannot run. */
export type Unusable =
  /** KiCad has no model for the symbol: its line is a placeholder. */
  | "no-model"
  /** KiCad's line names a model that nothing in the netlist defines. */
  | "undefined-model";

const statements = (text: string): string[] => text.replace(/\r?\n\+/g, " ").split(/\r?\n/);

/**
 * The symbols whose KiCad line no simulator runs, by reference:
 *   - a placeholder: KiCad has no model for the symbol;
 *   - KiCad's fallback. For a symbol it cannot model (a stock LED, a stock transistor) KiCad
 *     writes a raw line that names the symbol's Value as the model ("D1 a k red",
 *     "Q1 c b e NPN"), and reports its device as "SPICE". When nothing defines that model,
 *     ngspice refuses the whole circuit because of this one line.
 * A raw line the user asked for (the symbol's own field Sim.Device says SPICE) is theirs and
 * stays. So does a fallback line when the netlist includes a file: the model can be in
 * there. Without `symbols` only the placeholders are found.
 */
export function unusableLines(netlist: Pick<EditorNetlist, "items" | "lines">, symbols: Pick<SchematicSymbol, "ref" | "fields">[] = []): Map<string, Unusable> {
  const out = new Map<string, Unusable>();
  const fallback = new Set<string>();
  const asked = new Map(symbols.map((s) => [s.ref, (s.fields["Sim.Device"] ?? "").trim().toUpperCase()]));
  for (const item of netlist.items) {
    if (item.off) continue;
    if (item.device === "") out.set(item.ref, "no-model");
    else if (item.device === "SPICE" && asked.has(item.ref) && asked.get(item.ref) !== "SPICE") fallback.add(item.ref);
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
export function kicadModels(netlist: Pick<EditorNetlist, "items" | "lines">, symbols: Pick<SchematicSymbol, "ref" | "fields">[] = []): Set<string> {
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
  /** The pins of the part that have something else connected to them. */
  connected: string[];
  /** Every setting of the part with its value and where the value came from. */
  settings: ResolvedSettings["values"];
  /**
   * Only for a part with code: its place in the call order of a time step (1, 2, 3, ...).
   * The same number is how the engine and the part's own program tell two placed parts
   * apart. 0 for a part without code.
   */
  number: number;
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
  /** What the user should know. It does not stop the run. */
  notes: string[];
  /** What stops the run. Empty: the circuit can go to the simulator. */
  errors: string[];
}

export interface BuildOptions {
  /** The symbols that take part, as the editor reported them. */
  symbols: SchematicSymbol[];
  /** The symbols KiCad excludes from simulation. They have no line; their nets are tied to ground like those of a left-out symbol. */
  excluded?: Pick<SchematicSymbol, "pins">[];
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
  const used = new Set<string>();
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
    const settings = resolveSettings(man, sym);
    notes.push(...settings.notes);
    // A pin without a net gets a node of its own, named the way KiCad names a net with one pin.
    const nodes = m.pinMap.map((n) => sym.pins[n]?.node ?? `unconnected-${m.ref}-${n}`);
    const params = Object.entries(analogParams(man, settings)).map(([k, v]) => `${k}=${v}`);
    const number = man.digital ? ++order : 0;
    if (man.digital) params.push(`${man.digital.orderParam}=${number}`);
    const name = `X${m.ref}`;
    lines.push(`${name} ${nodes.join(" ")} ${man.analog.subckt}${params.length ? " " + params.join(" ") : ""}`);

    if (!used.has(m.partId)) {
      used.add(m.partId);
      const sources = (man.inputs ?? []).map((i) => i.source);
      let text = part.analog;
      if (live && sources.length) {
        try { text = withExternalSources(part.analog, man.analog.subckt, sources); } catch (err) { errors.push(`${m.partId}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      files.push({ path: modelPath(m.partId, man.analog.file), text });
      if (man.digital) codeParts.push({ partId: m.partId, kind: man.digital.kind, logic: part.logic });
    }

    const inst = `x${m.ref.toLowerCase()}`;
    for (const input of man.inputs ?? [])
      inputs.push({ ref: m.ref, partId: m.partId, input, vector: `v.${inst}.${input.source.toLowerCase()}`, initial: initialValue(input) });
    for (const s of man.signals ?? [])
      signals.push({ ref: m.ref, partId: m.partId, name: s.name, vector: `v.${inst}.${s.current.toLowerCase()}#branch` });
    placed.push({
      ref: m.ref, uuid: m.uuid, sheet: m.sheet, partId: m.partId, version: man.version, rule: m.rule, name, nodes,
      // KiCad calls a net with nothing else on it "unconnected-..."
      connected: man.pins.filter((_, i) => !/^unconnected-/i.test(nodes[i] ?? "unconnected-")),
      settings: settings.values, number,
    });
  }

  // 2. KiCad's netlist without the lines we replace and without the lines no simulator runs
  const mine = new Set(placed.map((p) => p.ref));
  const unusable = unusableLines(netlist, symbols);
  const notSimulated = [...unusable.keys()].filter((ref) => !mine.has(ref)).sort(natural);
  const keptLines = netlist.lines.filter((l) => l.ref === undefined || !(mine.has(l.ref) || unusable.has(l.ref)));
  const kept = keptLines.map((l) => l.text);
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

  const deck = [title, ...files.map((f) => `.include "${f.path}"`), ...kept.flatMap((t) => t.split("\n")), ...lines, ...tied];
  if (live) deck.push(LIVE_TRAN);
  deck.push(".end");

  // 4. the simulator does not take a code-model line of any length
  for (const [where, text] of [["the circuit", deck.join("\n")], ...files.map((f) => [f.path, f.text])] as [string, string][])
    for (const l of codeModelLines(text))
      if (l.pieces > CODE_MODEL_LINE_MAX)
        errors.push(`${where}: the line of ${l.name} is too long for the simulator (${l.pieces} pieces, at most ${CODE_MODEL_LINE_MAX})`);

  return { deck, files, inputs, signals, codeParts, placed, notSimulated, notes, errors };
}

export interface PrepareOptions {
  library: Pick<SimLibrary, "index" | "loadPart">;
  symbols: SchematicSymbol[];
  /** The symbols KiCad excludes from simulation (see BuildOptions). */
  excluded?: Pick<SchematicSymbol, "pins">[];
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
