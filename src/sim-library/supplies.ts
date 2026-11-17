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
//
// A regulator of the library is a source too, but only with something to regulate. A real
// board takes its power through a connector that nothing simulates: the regulator behind it
// has no input, and the wire +3V3 on its output would sit at 0 V, where it ran before the
// regulator had a model. So a regulator counts as a source when a source of the schematic
// reaches its input (fedParts() below). When none does, the wire on its output keeps the
// power of its name, and the run says which regulator gives nothing.

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

/** A placed part with nothing connected to pins it takes its power through. */
export interface Unpowered {
  ref: string;
  /** Those pins, by the symbol's pin numbers. */
  pins: string[];
}

/** A part that passes power on (a regulator), as the netlist step sees it. */
export interface Passing {
  ref: string;
  /** The pins it takes its power through, by the symbol's pin numbers. */
  pins: string[];
  /** The nets on those pins. */
  from: string[];
  /** The nets on the pins it powers. */
  to: string[];
}

export interface Power {
  /** Supply wires that got a source of ours: the name states the voltage, and no source of the schematic sits on the wire. */
  byName: NamedSupply[];
  /** Supply wires whose name states no voltage and that no source of the schematic sits on. They get nothing. */
  noVolts: string[];
  /** Sources of the schematic whose voltage is the part's default, because the symbol's Value does not say it. */
  assumed: AssumedSource[];
  /** Parts that do nothing, because nothing is connected to a pin they take their power through. */
  noPower: Unpowered[];
  /** Regulators that give nothing, because no source of the schematic reaches their input. `pins`: the input. */
  unfed: Unpowered[];
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

/**
 * Which regulators have something to regulate.
 *
 * `nets`: the nets of the circuit. `driven`: the nets a source of the schematic sits on.
 * `links`: for every simulated part that is not a chip (a switch, a diode, a resistor), the
 * nets on its pins; power on one of them reaches the others. `passing`: the regulators.
 *
 * A regulator is fed when one of its input nets is reached by a source: a driven net, a net
 * powered by its name, or the output of a fed regulator. Ground is never walked through.
 * The rest have no source. Of those, a regulator with a wire on its output whose name
 * states a voltage hands that wire back to its name, the one furthest upstream first, so
 * that a second regulator behind it is fed again (VIN, no source -> U1 -> +5V -> U2 -> +3V3:
 * +5V is powered by its name, U2 regulates).
 */
export function fedParts(nets: Iterable<string>, driven: Iterable<string>, links: Iterable<readonly string[]>, passing: readonly Passing[]): { fed: Set<string>; unfed: Unpowered[] } {
  // a wire that is ground, a second ground or a pin with nothing on it carries no power to anyone
  const dead = (net: string): boolean => isGround(net) || namedVolts(net) === 0 || /^unconnected-/i.test(net);
  const parent = new Map<string, string>();
  const root = (net: string): string => {
    let at = net.toLowerCase();
    for (let up = parent.get(at); up !== undefined; up = parent.get(at)) at = up;
    return at;
  };
  for (const group of links) {
    const live = group.filter((n) => !dead(n));
    for (const net of live.slice(1)) {
      const a = root(live[0] ?? net);
      const b = root(net);
      if (a !== b) parent.set(b, a);
    }
  }
  const outputs = new Set(passing.flatMap((p) => p.to.map((n) => n.toLowerCase())));
  const stated = (net: string): boolean => !dead(net) && namedVolts(net) !== null;
  const powered = new Set<string>();
  const power = (list: Iterable<string>): void => {
    for (const net of list) if (!dead(net)) powered.add(root(net));
  };
  power(driven);
  power([...nets].filter((n) => stated(n) && !outputs.has(n.toLowerCase())));

  const reached = (p: Passing): boolean => p.from.some((n) => !dead(n) && powered.has(root(n)));
  const behind = (q: Passing, p: Passing): boolean => q !== p && q.to.some((n) => !dead(n) && p.from.some((m) => !dead(m) && root(m) === root(n)));
  let open = [...passing].sort((a, b) => natural(a.ref, b.ref));
  const fed = new Set<string>();
  const unfed: Passing[] = [];
  for (;;) {
    const now = open.filter(reached);
    if (now.length) {
      for (const p of now) {
        fed.add(p.ref);
        power(p.to);
      }
      open = open.filter((p) => !now.includes(p));
      continue;
    }
    const named = open.filter((p) => p.to.some(stated));
    if (!named.length) break;
    const first = named.filter((p) => !named.some((q) => behind(q, p)));
    // regulators in a ring: the first by its reference
    const back = first.length ? first : named.slice(0, 1);
    for (const p of back) {
      unfed.push(p);
      power(p.to.filter(stated));
    }
    open = open.filter((p) => !back.includes(p));
  }
  unfed.push(...open);
  return { fed, unfed: unfed.sort((a, b) => natural(a.ref, b.ref)).map(({ ref, pins }) => ({ ref, pins })) };
}

/** The lines that power the wires: for each a source to ground, and its small resistance to the wire. */
export function supplyLines(byName: readonly NamedSupply[]): string[] {
  return byName.flatMap((s, i) => [
    `Vpj_supply_${i + 1} pj_supply_${i + 1} 0 DC ${s.volts}`,
    `Rpj_supply_${i + 1} pj_supply_${i + 1} ${s.net} ${SUPPLY_OHMS}`,
  ]);
}
