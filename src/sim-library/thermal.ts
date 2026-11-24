// Heat: parts that act on each other through it.
//
// Heat is drawn as a circuit, the way ngspice's own electro-thermal examples do it. On a
// wire that carries heat a voltage is a temperature (1 V is 1 degree Celsius) and a
// current is heat that flows (1 A is 1 W). What the heat goes into is drawn with ordinary
// parts:
//
//   - a capacitor to ground is something that holds heat (its farads are joules for
//     every degree),
//   - a resistor is a way heat gets through (its ohms are degrees for every watt),
//   - a voltage source is something that keeps its temperature, like the air outside.
//
// A part that has to do with heat has thermal pins (PartThermal): a heater pushes the
// power it takes into its pin as a current, a temperature sensor is as warm as its pin,
// a fan carries heat between its two pins. Pins on one wire are as warm as each other.
// The part then runs as its model with those pins after its own (thermalModel).
//
// KiCad's symbols draw no thermal pin, so the pin is joined to a wire by the wire's name:
// the symbol's field PCBJam.SimThermal says the names of labels, one for every thermal
// pin of its part. Nothing else is added to the circuit: no part of ours stands for a
// room, the air in it or the air outside it. The user draws those.
import type { OverlayEntry, PartManifest, PartThermal, ThermalRole } from "./format.js";
import { sourceRe } from "./spice-text.js";

/** The field that names the wires a symbol's thermal pins are on, a blank between two. */
export const FIELD_THERMAL = "PCBJam.SimThermal";

/** What a wire's name may be here: a label's text, which has no blank in it. */
export const WIRE_NAME = /^\S{1,64}$/;

/** The name of the signal that is the temperature of the wire a part's thermal pin is on. */
export const THERMAL_SIGNAL = "wire";

/** The pin a part's model gets for its own temperature: it gives its heat to it, or is as warm as it. */
export const THERMAL_PIN = "PJTH";

/** The two pins a part's model gets for the air it moves: heat goes from the warmer to the cooler. */
export const AIR_PINS = ["PJTA", "PJTB"] as const;

/** The parameter of such a model that says how much heat the moved air carries at full speed. */
export const AIR_PARAM = "PJFULL";

/** What the name of a part's subcircuit ends with when it has its thermal pins. */
export const THERMAL_SUFFIX = "_TH";

/** The source inside such a model whose current is the temperature of its pin: 1 A is 1 degree Celsius. */
export const THERMAL_SHOWN = "Vpjwire";

/** What a part does with heat, as a list: what the library's index says about it. */
export function thermalRoles(thermal: PartThermal): ThermalRole[] {
  const roles: ThermalRole[] = [];
  if (thermal.heat !== undefined) roles.push("heat");
  if (thermal.temperature !== undefined) roles.push("temperature");
  if (thermal.air !== undefined) roles.push("air");
  return roles;
}

/** One thermal pin of a part. */
export interface ThermalPin {
  /** The pin's name in the part's model with thermal pins. */
  pin: string;
  /**
   * What the part does on it: gives its heat to the wire ("heats"), is as warm as the wire
   * ("feels"), both, or moves air to or from the wire ("air").
   */
  does: "heats" | "feels" | "heats-feels" | "air";
}

/**
 * The thermal pins of a part, in the order its model has them and its symbol's field
 * names their wires: its own temperature first, then the two ends of the air it moves.
 */
export function thermalPins(roles: readonly ThermalRole[]): ThermalPin[] {
  const heats = roles.includes("heat");
  const feels = roles.includes("temperature");
  const pins: ThermalPin[] = [];
  if (heats || feels) pins.push({ pin: THERMAL_PIN, does: heats && feels ? "heats-feels" : heats ? "heats" : "feels" });
  if (roles.includes("air")) pins.push(...AIR_PINS.map((pin): ThermalPin => ({ pin, does: "air" })));
  return pins;
}

/** The wire names a symbol's field says, as written. Empty for a symbol without the field. */
export function wiresSaid(sym: { fields: Record<string, string> }): string[] {
  return (sym.fields[FIELD_THERMAL] ?? "").split(/\s+/).filter(Boolean);
}

/** Why a symbol's thermal pins are on no wires. */
export type WireProblem =
  /** The field names another number of wires than the part has thermal pins. */
  | { why: "count"; needs: number }
  /** A text of the field cannot be a wire's name. */
  | { why: "name"; name: string }
  /** No wire of the schematic has the name. */
  | { why: "no-wire"; name: string }
  /** Wires on several sheets have the name, and none of them is on the symbol's own sheet. */
  | { why: "several"; name: string };

// KiCad writes a net's name into its netlist without the characters SPICE cannot have in
// a name; the editor's net names are those. A label's text is compared the same way.
const asNode = (text: string): string => text.replace(/[() ]/g, "_").toLowerCase();

/**
 * The net a wire's name means, among the nets of the schematic: the wire with that label
 * on the symbol's own sheet, a wire named for every sheet (a global label, a power
 * symbol), or the one wire with that label on another sheet. SPICE does not tell upper
 * from lower case, so neither does this. `sheet` is the symbol's sheet as the editor says
 * it ("/", "/Key 1/").
 */
export function findWire(name: string, nets: Iterable<string>, sheet = "/"): { node: string } | { problem: WireProblem } {
  if (!WIRE_NAME.test(name)) return { problem: { why: "name", name } };
  const want = asNode(name);
  const byName = new Map<string, string>();
  for (const net of nets) if (!byName.has(net.toLowerCase())) byName.set(net.toLowerCase(), net);
  const own = byName.get(asNode(`${sheet.endsWith("/") ? sheet : sheet + "/"}${name}`));
  if (own !== undefined) return { node: own };
  const exact = byName.get(want);
  if (exact !== undefined) return { node: exact };
  const ends = [...byName].filter(([lower]) => lower.endsWith(`/${want}`)).map(([, net]) => net);
  if (ends.length === 1 && ends[0] !== undefined) return { node: ends[0] };
  return { problem: ends.length ? { why: "several", name } : { why: "no-wire", name } };
}

/**
 * The nets the thermal pins of a symbol's part are on, in the pins' order, or why they
 * are on none. `null` for a symbol whose field is empty or missing. A part is on its
 * wires with every thermal pin or with none.
 */
export function wiresOf(
  sym: { fields: Record<string, string>; sheet?: string }, pins: number, nets: Iterable<string>,
): { nodes: string[] } | { problem: WireProblem } | null {
  const said = wiresSaid(sym);
  if (!said.length) return null;
  if (said.length !== pins) return { problem: { why: "count", needs: pins } };
  const all = [...nets];
  const nodes: string[] = [];
  for (const name of said) {
    const found = findWire(name, all, sym.sheet);
    if ("problem" in found) return found;
    nodes.push(found.node);
  }
  return { nodes };
}

/** A wire problem as a sentence for the user. `ref` is the symbol, `title` its part. */
export function wireProblemText(ref: string, title: string, problem: WireProblem): string {
  switch (problem.why) {
    case "count":
      return problem.needs === 1
        ? `${ref} is on no heat wire: ${title} has one thermal pin, so it takes the name of one wire.`
        : `${ref} is on no heat wires: ${title} has ${problem.needs} thermal pins, so it takes the names of ${problem.needs} wires.`;
    case "name":
      return `${ref} is on no heat wire: "${problem.name}" cannot be a wire's name.`;
    case "several":
      return `${ref} is on no heat wire: wires on several sheets are called "${problem.name}". Write the name with its sheet, as the netlist does ("/sheet/${problem.name}").`;
    default:
      return `${ref} is on no heat wire: no wire of the schematic is called "${problem.name}". A wire has the name of the label on it, and something has to be connected to it.`;
  }
}

/**
 * The widgets of a placed part: its own, and on heat wires without the ones of the input
 * the wire has taken over and with the ones it has only there.
 */
export function overlayOf(manifest: Pick<PartManifest, "overlay" | "thermal">, onWires: boolean): OverlayEntry[] {
  const own = manifest.overlay ?? [];
  const thermal = manifest.thermal;
  if (!onWires || !thermal) return own;
  return [...own.filter((o) => thermal.temperature === undefined || o.input !== thermal.temperature), ...(thermal.overlay ?? [])];
}

/** The sources of a part's model that its thermal pins are made from. */
export interface ThermalSources {
  /** The source that is the part's temperature in degrees Celsius. It stands on ground. */
  temperature?: string;
  /** The source whose current is the heat the part gives off: 1 A is 1 W. */
  heat?: string;
  /** The source whose current is how hard the part moves air: 1 A is its full speed. */
  air?: string;
}

/**
 * A part's model with its thermal pins: the part's subcircuit alone, under its name with
 * THERMAL_SUFFIX, with the pins after its own.
 *
 *   - THERMAL_PIN, when the part has a temperature or gives off heat. The source of its
 *     temperature stands on that pin with 0 V in place of standing on ground with the
 *     user's value: the part is as warm as the wire. The heat it gives off is a current
 *     into the pin. It starts to flow when the circuit starts: a circuit starts settled,
 *     and a wire that a heater has warmed for ever is not how a board is switched on.
 *     A source of 0 V reads the pin's temperature as a current (THERMAL_SHOWN), because
 *     a current is what the app can read.
 *   - AIR_PINS, when the part moves air: a current from the first to the second that
 *     grows with its speed and with how much warmer the first is. AIR_PARAM says how
 *     many watts that is at full speed for every degree.
 */
export function thermalModel(text: string, subckt: string, sources: ThermalSources): string {
  const want = subckt.toLowerCase();
  const body = sources.temperature !== undefined || sources.heat !== undefined;
  const added = [...(body ? [THERMAL_PIN] : []), ...(sources.air !== undefined ? AIR_PINS : [])];
  if (!added.length) throw new Error(`${subckt}: the part has no thermal pin`);
  const tail: string[] = [];
  if (sources.heat !== undefined) tail.push(`Bpjheat 0 ${THERMAL_PIN} I = I(${sources.heat}) * min(1, time * 1meg)`);
  if (body) tail.push(`Bpjwire pjwv 0 V = V(${THERMAL_PIN})`, "Rpjwire pjwv pjwi 1", `${THERMAL_SHOWN} pjwi 0 dc 0`);
  if (sources.air !== undefined) tail.push(`Bpjair ${AIR_PINS[0]} ${AIR_PINS[1]} I = I(${sources.air}) * {${AIR_PARAM}} * V(${AIR_PINS[0]}, ${AIR_PINS[1]})`);
  const ours = new Set(tail.map((l) => (l.split(" ")[0] ?? "").toLowerCase()));
  const re = sources.temperature !== undefined ? sourceRe(sources.temperature) : null;
  /** The sources the added lines read, and whether the subcircuit has them. */
  const read = new Map([sources.heat, sources.air].flatMap((s) => (s === undefined ? [] : [[s.toLowerCase(), false] as [string, boolean]])));
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  /** The subcircuit's name as the file writes it. */
  let named = "";
  let moved = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const start = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(line);
    if (start) {
      inside = (start[1] ?? "").toLowerCase() === want;
      if (!inside) continue;
      named = start[1] ?? "";
      let rest = start[2] ?? "";
      while (i + 1 < lines.length && /^\+/.test(lines[i + 1] ?? "")) rest += " " + (lines[++i] ?? "").slice(1);
      const words = rest.split(/\s+/).filter(Boolean);
      const at = words.findIndex((w) => w.includes("=") || /^params:$/i.test(w));
      const pins = at < 0 ? words : words.slice(0, at);
      const taken = pins.find((p) => added.some((a) => a.toLowerCase() === p.toLowerCase()));
      if (taken !== undefined) throw new Error(`${subckt}: the subcircuit has a pin "${taken}" of its own`);
      out.push([`.subckt ${named}${THERMAL_SUFFIX}`, ...pins, ...added, ...(at < 0 ? [] : words.slice(at)), ...(sources.air !== undefined ? [`${AIR_PARAM}=1`] : [])].join(" "));
      continue;
    }
    if (!inside) continue;
    if (/^\.ends\b/i.test(line)) {
      out.push(...tail, `.ends ${named}${THERMAL_SUFFIX}`);
      inside = false;
      continue;
    }
    const first = (line.split(/\s+/)[0] ?? "").toLowerCase();
    if (ours.has(first)) throw new Error(`${subckt}: the subcircuit has a "${line.split(/\s+/)[0]}" of its own`);
    if (read.has(first)) read.set(first, true);
    const s = re?.exec(line);
    if (s) {
      if (s[3] !== "0") throw new Error(`${subckt}: the source "${sources.temperature}" must stand on ground (0) to stand on a wire`);
      out.push(`${s[1]} ${s[2]} ${THERMAL_PIN} dc 0`);
      moved = true;
      continue;
    }
    out.push(line);
  }
  if (!named) throw new Error(`the model file has no subcircuit "${subckt}"`);
  if (re && !moved) throw new Error(`${subckt}: the source "${sources.temperature}" was not found`);
  for (const [name, found] of read) if (!found) throw new Error(`${subckt}: the source "${name}" was not found`);
  return out.join("\n");
}

/** The name of the file a part's model with thermal pins is kept in: "model.lib" gives "model.thermal.lib". */
export function thermalFile(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot > file.lastIndexOf("/") + 1 ? `${file.slice(0, dot)}.thermal${file.slice(dot)}` : `${file}.thermal`;
}
