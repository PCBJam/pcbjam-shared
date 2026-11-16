// Where the power comes from, when the schematic does not draw it.
//
// A real schematic has no simulation source. Its supply wires are named by power symbols
// (+5V, +3V3) or labels, and the power itself comes in through a connector or a regulator
// that nothing simulates. KiCad's netlist then has the wire and nothing that holds it: every
// supply sits at 0 V and nothing happens.
//
// So a wire whose NAME states a voltage is given that voltage, by a source of ours from the
// wire to ground, unless a source of the schematic already sits on it (a battery, a voltage
// source). Nothing else is looked at: the rule has to be one a user can predict. The run
// says which wires it powered this way.
//
// A second ground (GNDA, AGND, Earth) is a supply wire too: its name states 0 V. The
// simulator knows only "GND" and "0" as ground, and what joins the grounds on a real board
// (a net tie, a ferrite bead) is not simulated.
//
// A supply name that states no voltage (VCC, VDD, VBUS, +BATT) gets nothing: there is no
// number to take. The run says that too.

/** A net's own name: KiCad puts the sheet in front of a label's name ("/Power/5V"). */
const ownName = (net: string): string => net.slice(net.lastIndexOf("/") + 1);

// "+5V", "-12V", "+3.3V", "5V", "+12VA", "+3.3VADC": a number, V, and at most a short suffix
const VOLTS_DOT = /^([+-]?)([0-9]+(?:\.[0-9]+)?)V([A-Z]{0,4})$/i;
// "+3V3", "-2V5", "+1V35", "3V3", "+3V3A": the V stands where the decimal point is
const VOLTS_V = /^([+-]?)([0-9]+)V([0-9]+)([A-Z]{0,4})$/i;
// KiCad's power library also has "+12C", "+12L", "+12LF", "+12P", "+5C", "+5F", "+5P"
const VOLTS_OLD = /^([+-])([0-9]+)(?:C|F|L|LF|P)$/;
// a second ground: "GNDA", "GNDD", "GND1", "GNDPWR", "AGND", "DGND", "PGND", "Earth", and "GND" inside a sheet
const GROUND = /^(?:[ADPS]?GND[A-Z0-9]{0,4}|Earth(?:_[A-Za-z]+)?)$/;

/**
 * The voltage a net's name states, or null. "+5V" is 5, "+3V3" and "3.3V" are 3.3, "-12V" is
 * -12, "+5VA" is 5, "GNDA" is 0. A longer name ("5V_EN", "+3V3_MCU") states none: it can be
 * a signal. An alternating voltage ("12VAC") is none a steady source can stand for.
 */
export function namedVolts(net: string): number | null {
  const name = ownName(net);
  if (GROUND.test(name)) return 0;
  let m = VOLTS_DOT.exec(name);
  let text = m?.[2] ?? "";
  let suffix = m?.[3] ?? "";
  if (!m && (m = VOLTS_V.exec(name))) {
    text = `${m[2]}.${m[3]}`;
    suffix = m[4] ?? "";
  }
  if (!m && (m = VOLTS_OLD.exec(name))) text = m[2] ?? "";
  if (!m || /^AC$/i.test(suffix)) return null;
  const volts = Number(text);
  if (!Number.isFinite(volts)) return null;
  return m[1] === "-" ? -volts : volts;
}

// The supply names of KiCad's power library that carry no number, and the usual ones beside
// them. Kept narrow: a name that only starts like one (VSENSE, VINP, VCOMP) is a signal.
const NO_NUMBER = /^(?:[+-]?V(?:CC|DD|EE|SS)(?:[ADFQ]|IO|[0-9])?|[+-]?V(?:AA|BUS|BAT|BATT|IN|PP|MEM|COM|SW|DC|SYS|S|D)|[+-]BATT|Vdrive|HT)$/;

/** Is this the name of a supply wire that does not say its voltage (VCC, VDD, VBUS, +BATT)? */
export function isSupplyWithoutVolts(net: string): boolean {
  return namedVolts(net) === null && NO_NUMBER.test(ownName(net));
}

export interface NamedSupply {
  /** The net, as the netlist names it. */
  net: string;
  volts: number;
}

/** A source of the schematic (a battery) that runs with the part's own voltage: the symbol's Value does not say one. */
export interface AssumedSource {
  ref: string;
  /** The setting's label, value and unit: "Voltage", "9", "V". */
  label: string;
  value: string;
  unit: string;
}

export interface Power {
  /** Supply wires that got a source of ours: the name states the voltage, and no source of the schematic sits on the wire. */
  byName: NamedSupply[];
  /** Supply wires whose name states no voltage and that no source of the schematic sits on. They get nothing. */
  noVolts: string[];
  /** Sources of the schematic whose voltage is the part's default, because the symbol's Value does not say it. */
  assumed: AssumedSource[];
}

/**
 * What a source of ours has inside, in ohms. Small enough not to matter (10 mV at 1 A), and
 * it keeps the circuit solvable when two powered wires are joined by something without
 * resistance (an inductor between +5V and +5VA).
 */
export const SUPPLY_OHMS = "10m";

/** Ground is no supply wire: the sources go from a wire to it. */
const isGround = (net: string): boolean => /^(0|gnd)$/i.test(net);

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;

/**
 * Which nets get power by their name. `nets` are the nets of the circuit; `driven` the nets a
 * source of the schematic sits on. Net names do not tell upper from lower case, as in SPICE.
 */
export function powerByName(nets: Iterable<string>, driven: Iterable<string>): Pick<Power, "byName" | "noVolts"> {
  const held = new Set([...driven].map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const out: Pick<Power, "byName" | "noVolts"> = { byName: [], noVolts: [] };
  for (const net of [...nets].sort(natural)) {
    const key = net.toLowerCase();
    if (seen.has(key) || isGround(net) || /^unconnected-/i.test(net)) continue;
    seen.add(key);
    const volts = namedVolts(net);
    // A second ground is held at 0 V also with a source on it: a battery from +9V to GNDA
    // powers the wire +9V, but only a path to ground makes GNDA the ground it is drawn as.
    if (held.has(key) && volts !== 0) continue;
    if (volts !== null) out.byName.push({ net, volts });
    else if (isSupplyWithoutVolts(net)) out.noVolts.push(net);
  }
  return out;
}

/** The lines that power the wires: for each a source to ground, and its small resistance to the wire. */
export function supplyLines(byName: readonly NamedSupply[]): string[] {
  return byName.flatMap((s, i) => [
    `Vpj_supply_${i + 1} pj_supply_${i + 1} 0 DC ${s.volts}`,
    `Rpj_supply_${i + 1} pj_supply_${i + 1} ${s.net} ${SUPPLY_OHMS}`,
  ]);
}
