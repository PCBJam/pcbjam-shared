// The clock of a chip that has no board around it (a bare microcontroller).
//
// A board part knows its clock: an Arduino Uno has a 16 MHz crystal on it. A chip that is
// drawn by itself has what the schematic gives it. The rule, last wins:
//   1. the chip's own oscillator, at the speed the part names (`digital.clock`). It is
//      assumed: the schematic cannot say how the chip's fuses are set
//   2. a crystal or a resonator the schematic has on the chip's two clock pins: its Value
//      is the clock
//   3. the part's clock setting on the symbol, when it is not "auto"
// A sketch is built for one speed. On a chip that runs at another, its delays and its
// serial speed are off by the same factor, so a run says which speed it took and why.
import type { DigitalEmulator } from "./format.js";
import type { SchematicSymbol } from "./match.js";

/** The value of the clock setting that leaves the clock to the schematic. */
export const CLOCK_AUTO = "auto";

/** What a crystal on a chip's clock pins can be, for the chip to run from it (the AVR data sheet's range). */
export const CRYSTAL_MIN_HZ = 400_000;
/** The fastest clock a setting or a crystal can ask for. */
export const CLOCK_MAX_HZ = 20_000_000;
/** The slowest clock a setting can ask for. */
export const CLOCK_MIN_HZ = 100_000;

export interface ChipClock {
  /** The chip's clock in Hz. */
  hz: number;
  /** Where it comes from. */
  from: "setting" | "crystal" | "assumed";
  /** The crystal on the chip's clock pins, when the schematic has one. */
  crystal?: string;
  /** Why that crystal does not set the clock, when it does not and no setting does. */
  why?: "no-value" | "too-slow" | "too-fast";
  /** A clock setting that was not used: what it said. */
  refused?: string;
}

/**
 * A frequency as a crystal's Value or a setting writes it, in Hz, or null: "16MHz",
 * "16 MHz", "16M", "16.000MHz", "7.3728MHz", "32.768kHz", "8000000", and a maker's name
 * with the frequency in it ("ABM3-16.000MHZ-B2-T"). A bare "16" is none: it could be
 * anything.
 */
export function readFrequency(text: string): number | null {
  const m = /(?<![A-Za-z0-9.,])(\d+(?:[.,]\d+)?)\s*(MHz|kHz|Hz|M|k)(?![A-Za-z])/i.exec(text);
  if (m) {
    const n = Number((m[1] ?? "").replace(",", "."));
    const unit = (m[2] ?? "").toLowerCase();
    const hz = n * (unit.startsWith("m") ? 1e6 : unit.startsWith("k") ? 1e3 : 1);
    return Number.isFinite(hz) && hz > 0 ? Math.round(hz) : null;
  }
  const plain = /^\s*(\d{4,9})\s*$/.exec(text);
  return plain ? Number(plain[1]) : null;
}

/**
 * What somebody typed for a clock, as the value the clock setting holds: "16 mhz" and
 * "16M" are "16MHz", "500 khz" is "500kHz", nothing at all is "auto". Text that says no
 * frequency comes back as it was typed, for the setting's own rule to refuse.
 */
export function clockSettingValue(typed: string): string {
  const text = typed.trim();
  if (!text || text.toLowerCase() === CLOCK_AUTO) return CLOCK_AUTO;
  const m = /^(\d+(?:[.,]\d+)?)\s*(mhz|khz|m|k)$/i.exec(text);
  if (!m) return text;
  return `${(m[1] ?? "").replace(",", ".")}${(m[2] ?? "").toLowerCase().startsWith("m") ? "MHz" : "kHz"}`;
}

/** "16 MHz", "7.3728 MHz", "32.768 kHz". */
export function frequencyText(hz: number): string {
  const short = (n: number): string => String(Number(n.toFixed(6)));
  return hz >= 1e6 ? `${short(hz / 1e6)} MHz` : hz >= 1e3 ? `${short(hz / 1e3)} kHz` : `${hz} Hz`;
}

/** Is this symbol a crystal or a resonator? By KiCad's symbol, by a library of the user's own, or by its reference. */
export function isCrystal(sym: Pick<SchematicSymbol, "ref" | "libId">): boolean {
  return /(crystal|resonator|xtal)/i.test(sym.libId) || /^(Y|X|XTAL)[0-9?]/.test(sym.ref);
}

/**
 * The crystal on a chip's two clock pins: a symbol that is one, with a pin on each of the
 * two nets. Null when a pin has no wire, when the two are one net, or when nothing of the
 * kind is there.
 */
export function crystalOn(nets: readonly [string | undefined, string | undefined], symbols: readonly Pick<SchematicSymbol, "ref" | "libId" | "value" | "pins">[], chip: string): Pick<SchematicSymbol, "ref" | "value"> | null {
  const [a, b] = nets;
  if (!a || !b || a === b || /^unconnected-/i.test(a) || /^unconnected-/i.test(b)) return null;
  for (const sym of symbols) {
    if (sym.ref === chip || !isCrystal(sym)) continue;
    const on = new Set(Object.values(sym.pins).map((p) => p.node));
    if (on.has(a) && on.has(b)) return { ref: sym.ref, value: sym.value };
  }
  return null;
}

/**
 * The clock of one placed chip (see the rule at the top). `setting` is the value of the
 * part's clock setting, `crystal` what the schematic has on the clock pins.
 */
export function chipClock(digital: Pick<DigitalEmulator, "clock">, setting: string | undefined, crystal: Pick<SchematicSymbol, "ref" | "value"> | null): ChipClock {
  const own = digital.clock ?? 8_000_000;
  let refused: string | undefined;
  if (setting !== undefined && setting !== CLOCK_AUTO) {
    const hz = readFrequency(setting);
    if (hz !== null && hz >= CLOCK_MIN_HZ && hz <= CLOCK_MAX_HZ) return { hz, from: "setting", ...(crystal ? { crystal: crystal.ref } : {}) };
    refused = setting;
  }
  const more = refused !== undefined ? { refused } : {};
  if (!crystal) return { hz: own, from: "assumed", ...more };
  const hz = readFrequency(crystal.value);
  if (hz === null) return { hz: own, from: "assumed", crystal: crystal.ref, why: "no-value", ...more };
  // a watch crystal on these pins clocks a timer, not the chip
  if (hz < CRYSTAL_MIN_HZ) return { hz: own, from: "assumed", crystal: crystal.ref, why: "too-slow", ...more };
  if (hz > CLOCK_MAX_HZ) return { hz: own, from: "assumed", crystal: crystal.ref, why: "too-fast", ...more };
  return { hz, from: "crystal", crystal: crystal.ref, ...more };
}

/**
 * What a run says about a chip's clock, or null when there is nothing to tell: a chip that
 * runs from its crystal is as drawn. `settingLabel` is the clock setting's name in the
 * parts list.
 */
export function clockSentence(ref: string, clock: ChipClock, settingLabel = "Clock"): string | null {
  const at = frequencyText(clock.hz);
  const refused = clock.refused !== undefined ? ` Its setting "${clock.refused}" is not a clock this chip takes.` : "";
  if (clock.from === "crystal") return refused ? `${ref} runs at ${at}, from its crystal ${clock.crystal}.${refused}` : null;
  if (clock.from === "setting") return null;
  const fix = `A sketch built for another speed runs at the wrong pace: the setting "${settingLabel}" on the chip's line in the Simulation parts list says the speed.`;
  if (!clock.crystal) return `${ref} runs at ${at}: no crystal is on its clock pins, so the chip's own oscillator is assumed. ${fix}${refused}`;
  const why = clock.why === "no-value" ? `the Value of its crystal ${clock.crystal} says no frequency (16MHz)`
    : clock.why === "too-slow" ? `its crystal ${clock.crystal} is too slow to clock the chip (it can clock a timer)`
    : `its crystal ${clock.crystal} is faster than the chip can run`;
  return `${ref} runs at ${at}, the chip's own oscillator: ${why}. ${fix}${refused}`;
}

/** The chip's line in the parts list: its speed and where it comes from. */
export function clockSource(clock: ChipClock): string {
  const at = frequencyText(clock.hz);
  return clock.from === "crystal" ? `${at}, from its crystal ${clock.crystal}` : clock.from === "setting" ? `${at}, by its setting` : `${at}, its own oscillator (assumed)`;
}
