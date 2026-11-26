// What a live run leaves out, and why.
//
// A symbol that has no line in the circuit does not stop the run: the rest runs without it.
// The user has to know which symbols those are, and for each of them why, because what they
// can do differs:
//
//   no value   a resistor, a capacitor or a coil whose Value is no number (still "R"), or
//              says more than one thing and does not read as a value with its ratings
//              ("10k/22k"): the user types the value, and it runs. Also one whose symbol
//              names a model of its own without a value in it (Sim.Device, Sim.Params):
//              KiCad writes no line for it, whatever its Value says;
//   no part    neither the simulation library nor KiCad has a model for the symbol (a chip,
//              a sensor): nothing to do today, the rest runs without it;
//   nothing    there is nothing to simulate: a mounting hole, a pin header, a test point,
//              an antenna. A protection diode (TVS) is counted here too: it acts only on a
//              voltage spike, and no model of it is right without its voltage. These are
//              counted, not named one by one;
//   off        somebody switched it off: KiCad's "exclude from simulation" on the symbol or
//              its sheet, the symbol's model disabled in KiCad, or our own field on the
//              symbol (PCBJam.SimPart: off). With our field KiCad's own model of the symbol
//              can still run in its place; the entry says so.
//
// The rules are here so that every reader gives the same answer: the netlist step (which
// puts the list into the run it writes), the page (the notice at Play, the Simulation parts
// list) and a count over boards.
//
// A run that does not start at all is another thing and is not in this list: a chip without
// its firmware file, a model the simulator refuses.
import type { NetlistItem } from "./editor.js";
import { FIELD_PART, type Match, type SchematicSymbol } from "./match.js";
import type { Unusable } from "./netlist.js";
import { ratedValue, type PassiveKind } from "./values.js";

export type LeftOutReason = "no-value" | "no-part" | "nothing" | "off";

/** One symbol a run leaves out, or runs in another way than the library would. */
export interface LeftOut {
  ref: string;
  uuid: string;
  /** The sheet instance in words ("/", "/Key 1/"). */
  sheet: string;
  libId: string;
  value: string;
  reason: LeftOutReason;
  /**
   * Only for "off", what switched it off: our field on the symbol ("field"), KiCad's "exclude
   * from simulation" on the symbol or on its sheet ("excluded"), or the symbol's model
   * disabled in KiCad ("model").
   */
  off?: "field" | "excluded" | "model";
  /** Only for "off" by our field: KiCad's own model of the symbol runs in its place. */
  instead?: "kicad";
  /**
   * Only for "no-value": the value that is missing is the one of the symbol's own model (its
   * fields Sim.Device and Sim.Params). KiCad writes no line for the symbol, and its Value
   * is not used.
   */
  ownModel?: true;
  /**
   * Only for "no-part", when the library knows something about the symbol and cannot use
   * it: a part it offers and the user has not said yes to, two parts to pick from, or a
   * part that does not fit. A sentence without its end.
   */
  library?: string;
}

/**
 * The symbols with nothing to simulate, by "Library:Name" as KiCad's libraries have them
 * ("*" stands for any text). A short list of named symbols and of families of one kind,
 * never a whole library: a connector can be what feeds the board, and then it is a part.
 * The list is looked at only for a symbol that nothing runs, so a symbol with a part or a
 * model of its own is never taken for one of these.
 *
 * The name decides, not the library (hasNothingToSimulate): a board often keeps its symbols
 * in a library of its own, and a copy of a mounting hole is a mounting hole.
 */
export const NOTHING_TO_SIMULATE: readonly string[] = [
  "Mechanical:MountingHole",
  "Mechanical:MountingHole_Pad",
  "Mechanical:MountingHole_Pad_MP",
  "Mechanical:Fiducial",
  "Mechanical:Heatsink",
  "Mechanical:Heatsink_Pad",
  "Mechanical:Heatsink_Pad_2Pin",
  "Mechanical:Heatsink_Pad_3Pin",
  "Mechanical:Housing",
  "Mechanical:Housing_Pad",
  "Connector:TestPoint",
  "Connector:TestPoint_*",
  // pin headers and sockets: one row, two rows
  "Connector:Conn_01x*",
  "Connector_Generic:Conn_01x*",
  "Connector_Generic:Conn_02x*",
  "Connector_Generic_MountingPin:Conn_01x*",
  "Connector_Generic_MountingPin:Conn_02x*",
  "Graphic:Logo_*",
  "Graphic:SYM_*",
  // what is there for radio: it has no part in a circuit of voltages and currents
  "Device:Antenna",
  "Device:Antenna_Chip",
  "Device:Antenna_Dipole",
  "Device:Antenna_Loop",
  "Device:Antenna_Shield",
  "Device:RFShield_OnePiece",
  "Device:RFShield_TwoPieces",
  // protection diodes: see PROTECTION
  "Device:D_TVS",
  "Device:D_TVS_Filled",
  "Device:D_TVS_Small",
  "Device:D_TVS_Small_Filled",
  "Device:D_TVS_Dual_AAC",
  "Device:D_TVS_Dual_ACA",
  "Device:D_TVS_Dual_CAA",
];

/**
 * The names on the list that are protection diodes (TVS). One of those is not without
 * effect as a mounting hole is: it conducts when the voltage on it goes far above normal,
 * and cuts the spike off. Below that voltage it does nothing, and the voltage is not known
 * here (a symbol's Value is a type number), so no model of it would be right. It is left
 * out, and the words say what that means: a spike it would cut off stays in the run.
 */
const PROTECTION = /^D_TVS(?:_Small)?(?:_Filled)?$|^D_TVS_Dual_(?:AAC|ACA|CAA)$/;

/** True for a protection diode among the symbols with nothing to simulate, by its name in any library. */
export function isProtectionDiode(libId: string): boolean {
  return PROTECTION.test(libId.slice(libId.lastIndexOf(":") + 1));
}

const pattern = (text: string): RegExp => new RegExp("^" + text.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*") + "$");
const NOTHING = NOTHING_TO_SIMULATE.map(pattern);
/** The list by the symbols' names alone. */
const NOTHING_NAMES = [...new Set(NOTHING_TO_SIMULATE.map((entry) => entry.slice(entry.indexOf(":") + 1)))].map(pattern);
/**
 * The names KiCad gives its pin headers: the size, how the pins are counted, and what is on
 * the housing ("Conn_01x04_Pin", "Conn_02x05_Odd_Even_MountingPin"; "Male" and "Female" are
 * KiCad 6's). A copy in another library has to keep to them: "Conn_01x04_LoadSwitch" is
 * somebody's own part.
 */
const HEADER_NAME = /^Conn_0[12]x\d+(?:_(?:Pin|Socket|Male|Female|Counter_Clockwise|Odd_Even|Row_Letter_First|Row_Letter_Last|Top_Bottom))?(?:_(?:MountingPin|Shielded))?$/;

/**
 * True for a symbol with nothing to simulate (see NOTHING_TO_SIMULATE): one of KiCad's, or a
 * symbol of any other library that carries the name of one ("MyBoard:MountingHole",
 * "MyBoard:Conn_01x04"). Only the exact names count: a symbol somebody called "Header" or
 * "Logo" is not known here, and neither is a pin header's name with a word of their own
 * behind it.
 */
export function hasNothingToSimulate(libId: string): boolean {
  if (NOTHING.some((re) => re.test(libId))) return true;
  const name = libId.slice(libId.lastIndexOf(":") + 1);
  return NOTHING_NAMES.some((re) => re.test(name)) && (!name.startsWith("Conn_") || HEADER_NAME.test(name));
}

/**
 * True for the reference of a resistor, a capacitor or a coil: the letter and its number
 * ("R1", "C12", "L3", and "R?" before the schematic is annotated). KiCad takes every symbol
 * with two pins whose reference starts with one of the three letters for one ("RV1" a
 * varistor, "LS1" a speaker, "CB1" a circuit breaker); a value does not mend those.
 */
export function isPassiveRef(ref: string): boolean {
  return /^[RCL][0-9?]/.test(ref);
}

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

export interface LeftOutOptions {
  /** The symbols that take part, as the editor reported them. */
  symbols: SchematicSymbol[];
  /** matchSymbols() of exactly these symbols. */
  plan: Match[];
  /** The symbols KiCad excludes from simulation. */
  excluded?: readonly Partial<SchematicSymbol>[];
  /** Every symbol KiCad made a SPICE item for. */
  items: readonly NetlistItem[];
  /** The symbols whose KiCad line no simulator runs (unusableLines). */
  unusable: ReadonlyMap<string, Unusable>;
  /** The symbols that run as a library part in this circuit, by reference. */
  placed: ReadonlySet<string>;
}

/** What the library says about a symbol it cannot run as it is. */
function libraryWords(m: Match): string | undefined {
  const titles = (c: { title: string }[]): string => c.map((x) => x.title).join(", ");
  if (m.status === "suggested" && m.candidates.length) return `the library offers ${titles(m.candidates)} for this value, not used until it is confirmed`;
  if (m.status === "choice" && m.candidates.length) return `several library parts fit (${titles(m.candidates)}), one has to be picked`;
  if (m.status === "error") return m.reason;
  return undefined;
}

/**
 * Every symbol the run leaves out, with its reason, by reference (R2 before R10). A symbol
 * that our field switches off while KiCad's own model runs it is in the list too, marked
 * `instead`.
 */
export function leftOutSymbols({ symbols, plan, excluded = [], items, unusable, placed }: LeftOutOptions): LeftOut[] {
  if (plan.length !== symbols.length) throw new Error("the plan is not about these symbols");
  const item = new Map(items.map((i) => [i.ref, i]));
  const out: LeftOut[] = [];
  symbols.forEach((sym, i) => {
    const m = plan[i];
    if (!m || placed.has(sym.ref)) return;
    const base = { ref: sym.ref, uuid: sym.uuid, sheet: sym.sheet, libId: sym.libId, value: sym.value };
    const kicad = item.get(sym.ref);
    // the symbol's model is disabled in KiCad: no line of KiCad's, and none of ours
    if (kicad?.off) return void out.push({ ...base, reason: "off", off: "model" });
    // a part that is named and is not in the circuit could not be loaded: the run does not start
    if (m.status === "matched") return;
    const runs = kicad !== undefined && !unusable.has(sym.ref);
    if (m.status === "off") return void out.push({ ...base, reason: "off", off: "field", ...(runs ? { instead: "kicad" as const } : {}) });
    if (runs) return; // KiCad's own model, or the user's
    // KiCad has a model for it and wrote no line: the symbol's own model has no value. (KiCad
    // writes no line for a resistor, a capacitor or a coil without a value; a symbol of
    // another kind without a line is one without a part, below.)
    if (unusable.get(sym.ref) === "no-line" && /^[RCL]$/.test(kicad?.device ?? "")) return void out.push({ ...base, reason: "no-value", ownModel: true });
    if (unusable.get(sym.ref) === "no-value" && isPassiveRef(sym.ref)) return void out.push({ ...base, reason: "no-value" });
    // with an empty Value KiCad does not even guess: its line is a placeholder, as for a chip
    if (unusable.get(sym.ref) === "no-model" && isPassiveRef(sym.ref) && !sym.value.trim() && Object.keys(sym.pins).length === 2) return void out.push({ ...base, reason: "no-value" });
    const library = libraryWords(m);
    if (library === undefined && hasNothingToSimulate(sym.libId)) return void out.push({ ...base, reason: "nothing" });
    out.push({ ...base, reason: "no-part", ...(library !== undefined ? { library } : {}) });
  });
  for (const sym of excluded) {
    if (!sym.ref) continue;
    out.push({ ref: sym.ref, uuid: sym.uuid ?? "", sheet: sym.sheet ?? "", libId: sym.libId ?? "", value: sym.value ?? "", reason: "off", off: "excluded" });
  }
  return out.sort((a, b) => natural(a.ref, b.ref));
}

// --- the words ---------------------------------------------------------------------------

/** How many symbols a sentence names before it counts the rest. */
const NAMED = 6;

const firstFew = (items: readonly string[]): string => {
  const more = items.length - NAMED;
  return `${items.slice(0, NAMED).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

/** What the symbol is, for a reader who knows the board: its Value, or its name in its library. */
function kindOf(s: Pick<LeftOut, "libId" | "value">): string {
  const name = s.libId.slice(s.libId.indexOf(":") + 1);
  return s.value.trim() || name;
}

/** "U1 (ATmega328P-A)"; the reference alone when the Value says nothing more. */
const named = (s: LeftOut): string => {
  const kind = kindOf(s);
  return kind && kind !== s.ref ? `${s.ref} (${kind})` : s.ref;
};

/**
 * How a list names a left-out symbol: with what it is where that says something, "U1
 * (ATmega328P-A)", and by its reference alone for a missing value and for a symbol that is
 * switched off.
 */
export const leftOutName = (s: LeftOut): string => (s.reason === "no-value" || s.reason === "off" ? s.ref : named(s));

/**
 * What a list says of one symbol beside its group's words, when they do not cover it: what
 * the library knows about a symbol it cannot run as it is, and for a symbol that is switched
 * off, where and what runs in its place. Null when the group's words say it all.
 */
export function leftOutRemark(s: LeftOut): string | null {
  if (s.reason === "no-part") return s.library ?? null;
  if (s.reason !== "off") return null;
  if (s.off === "excluded") return "excluded from simulation in KiCad, on the symbol or on its sheet";
  if (s.off === "model") return "its simulation model is switched off in KiCad";
  return `switched off on its symbol (${FIELD_PART}: off); ${s.instead === "kicad" ? "KiCad's own model runs in its place" : "nothing runs in its place"}`;
}

/** A value to type, as an example: by the first letter of the reference. */
const example = (ref: string): string => (/^C/.test(ref) ? "100n" : /^L/.test(ref) ? "10u" : "10k");

/** How a symbol was switched off, where, and what runs in its place: one sentence. */
function offSentence(s: LeftOut): string {
  if (s.off === "excluded") return `${s.ref} is excluded from simulation in KiCad, on the symbol or on its sheet.`;
  if (s.off === "model") return `${s.ref} is left out: its simulation model is switched off in KiCad.`;
  return s.instead === "kicad"
    ? `${s.ref} is switched off on its symbol (${FIELD_PART}: off). KiCad's own model runs in its place.`
    : `${s.ref} is switched off on its symbol (${FIELD_PART}: off). Nothing runs in its place.`;
}

/** The kind of part a reference stands for, as KiCad guesses it: by its first letter. */
function passiveKind(ref: string): PassiveKind | undefined {
  const letter = ref.trim().charAt(0).toUpperCase();
  return letter === "R" || letter === "C" || letter === "L" ? letter : undefined;
}

/** What to do about one left-out symbol, or what it means: one sentence. */
export function leftOutSentence(s: LeftOut): string {
  switch (s.reason) {
    case "no-value":
      if (s.ownModel) return `${s.ref} is left out: its symbol names a simulation model of its own with no value in it (the fields Sim.Device and Sim.Params), and its Value${s.value.trim() ? ` "${s.value.trim()}"` : ""} is not used. Delete the two fields, and the Value runs.`;
      return ratedValue(s.value, passiveKind(s.ref)) === "unreadable"
        ? `${s.ref}: its Value "${s.value.trim()}" is not read as one value. Type the value alone (${example(s.ref)}) and it runs.`
        : `${s.ref} has no value. Type one (${example(s.ref)}) and it runs.`;
    case "nothing":
      return isProtectionDiode(s.libId)
        ? `${named(s)} is a protection diode. It acts only on a voltage spike, and it is not simulated: a spike it would cut off stays in the run.`
        : `${named(s)} has nothing to simulate.`;
    case "off":
      return offSentence(s);
    default:
      return s.library !== undefined
        ? `${named(s)} is not simulated: ${s.library}.`
        : `${named(s)} is not simulated: the library has no part for it. The rest runs without it.`;
  }
}

/** The left-out symbols of one reason. */
export const leftOutBy = (list: readonly LeftOut[], reason: LeftOutReason): LeftOut[] => list.filter((s) => s.reason === reason);

/**
 * A group of left-out symbols: its title and what the user can do, for a list. With the
 * group's symbols, the words say which of them miss their value in a model of their own:
 * typing a Value does not mend those.
 */
export function leftOutGroup(reason: LeftOutReason, group: readonly LeftOut[] = []): { title: string; todo: string } {
  switch (reason) {
    case "no-value": {
      const typed = "Type the value on the symbol (10k, 100n), then it runs.";
      const own = group.filter((s) => s.ownModel);
      if (!own.length) return { title: "No value", todo: typed };
      const one = own.length === 1;
      const all = own.length === group.length;
      const who = all ? (one ? "It names" : "They name") : `${firstFew(own.map((s) => s.ref))} ${one ? "names" : "name"}`;
      const words = `${who} a simulation model of ${one ? "its" : "their"} own with no value in it (the fields Sim.Device and Sim.Params on the symbol): KiCad leaves ${one ? "it" : "them"} out, and the Value is not used. Delete the two fields, and the Value runs.`;
      return { title: "No value", todo: all ? words : `${typed} ${words}` };
    }
    case "nothing": {
      const plain = "Mounting holes, pin headers, test points: they do nothing in a circuit.";
      const guards = group.some((s) => isProtectionDiode(s.libId)) ? " Protection diodes (TVS) act only on a voltage spike and are not simulated." : "";
      return { title: "Nothing to simulate", todo: `${plain}${guards} Nothing to do.` };
    }
    case "off":
      return { title: "Switched off", todo: "Somebody switched these off, in KiCad or on the symbol. Switch one on again where it was switched off." };
    default:
      return { title: "No part", todo: "The library has no part for these and KiCad has no model. The rest of the circuit runs without them." };
  }
}

/** The order the reasons are said in: what the user can mend at once comes first. */
export const LEFT_OUT_ORDER: readonly LeftOutReason[] = ["no-value", "no-part", "off", "nothing"];

/** True for a reason the user did not choose and may want to mend: a missing value, a missing part. */
export const leftOutMatters = (s: Pick<LeftOut, "reason">): boolean => s.reason === "no-value" || s.reason === "no-part";

/**
 * The notice about what a run leaves out. One symbol: its sentence. More: the count of each
 * reason, the missing values first (the user can mend them at once), each with the first few
 * of its symbols; what has nothing to simulate is only counted.
 *
 * Null when the run leaves nothing out, and when all it leaves out is what somebody
 * switched off or what has nothing to simulate: a board with four mounting holes runs as
 * it should, and a notice at every Play would say nothing new. A list still shows those.
 */
export function leftOutNotice(list: readonly LeftOut[]): string | null {
  if (!list.some(leftOutMatters)) return null;
  if (list.length === 1) return leftOutSentence(list[0] as LeftOut);
  const symbols = (n: number): string => (n === 1 ? "1 symbol" : `${n} symbols`);
  const out: string[] = [];
  const noValue = leftOutBy(list, "no-value").filter((s) => !s.ownModel);
  if (noValue.length) {
    const one = noValue.length === 1;
    out.push(`${symbols(noValue.length)} ${one ? "has" : "have"} no value (${firstFew(noValue.map((s) => s.ref))}): type ${one ? "its value and it runs" : "their values and they run"}.`);
  }
  // a value typed on these does nothing: the list says what does
  const ownModel = leftOutBy(list, "no-value").filter((s) => s.ownModel);
  if (ownModel.length) {
    const one = ownModel.length === 1;
    out.push(`${symbols(ownModel.length)} ${one ? "names" : "name"} a simulation model of ${one ? "its" : "their"} own with no value in it (${firstFew(ownModel.map((s) => s.ref))}): ${one ? "it is" : "they are"} left out, and ${one ? "its Value is" : "their Values are"} not used.`);
  }
  const noPart = leftOutBy(list, "no-part");
  if (noPart.length) out.push(`${symbols(noPart.length)} ${noPart.length === 1 ? "has" : "have"} no part in the library: ${firstFew(noPart.map(named))}.`);
  const off = leftOutBy(list, "off");
  if (off.length) out.push(`${symbols(off.length)} ${off.length === 1 ? "is" : "are"} switched off: ${firstFew(off.map((s) => s.ref))}.`);
  const nothing = leftOutBy(list, "nothing");
  if (nothing.length) out.push(`${symbols(nothing.length)} ${nothing.length === 1 ? "has" : "have"} nothing to simulate.`);
  out.push("The rest of the circuit runs.");
  return out.join(" ");
}

/** "No value", "No part", ...: what a mark on the sheet says of a left-out symbol, in two words. */
export function leftOutWords(reason: LeftOutReason): string {
  switch (reason) {
    case "no-value":
      return "no value";
    case "nothing":
      return "nothing to simulate";
    case "off":
      return "switched off";
    default:
      return "no part";
  }
}
