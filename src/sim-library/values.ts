// A Value that says more than the value: "22uF/25V", "10k 1%", "100n 50V X7R".
//
// People write what they buy into the Value of a resistor, a capacitor or a coil: the
// voltage it stands, its tolerance, its housing. KiCad reads a Value that is a number with
// its unit ("22uF", "4k7") and hands every other text to the simulator as it is, as a
// formula. The simulator reads no ratings. "22uF/25V" stops the whole run, and of
// "10k 1%" it takes the last number: the resistor runs with 1 ohm, and nothing says so.
//
// This file reads such a Value the one way that is safe: the first piece has to be a plain
// value, and every other piece a rating that is known here. Then the plain value runs, and
// the lists say which. Everything else is not guessed at: the netlist step leaves the
// symbol out as one without a value (netlist.ts), and the user types a plain one.
//
// What is not looked at: a Value of one piece (KiCad or the simulator reads it, as before),
// and a text that reads as a formula or as parameters of the simulator ("{R1*2}",
// "1u ic=0"): those are the user's.
//
// Where a text can be read in two ways, it is not read: a capacitor's "47/63V" (47 farad,
// or the 47 uF it was meant as), its "1F" (KiCad and the simulator take the F as femto), a
// capital P (peta for KiCad, pico for the simulator).

/** The kind of part a Value is read for: a resistor, a capacitor, a coil. */
export type PassiveKind = "R" | "C" | "L";

/** A Value read as a plain value and its ratings. */
export interface RatedValue {
  /** The plain value as the simulator takes it ("22u", "4.7k", "1Meg"). */
  value: string;
  /** The same as the user typed it ("22uF", "4k7", "1M"). */
  shown: string;
  /** The ratings, as typed ("25V", "1%"). */
  ratings: string[];
}

// A number with one decimal point or comma, a multiplier, a unit, and the digits behind the
// multiplier or the unit when it stands in the decimal point's place ("4k7", "2R2").
// (\u00b5 and \u03bc are the two "micro" signs, \u03a9 and \u2126 the two "ohm" signs.)
const PLAIN = /^(\d+)(?:([.,])(\d+))?(meg|[fpnu\u00b5\u03bcmkgt])?(f|h|r|\u03a9|\u2126|ohms?)?(\d+)?(f|h|r|\u03a9|\u2126|ohms?)?$/i;

interface Plain { value: string; multiplier: string; unit: boolean }

function readPlain(piece: string): Plain | null {
  const m = PLAIN.exec(piece);
  if (!m) return null;
  const [, whole = "", separator, decimals, multiplier = "", unit, behind, unitBehind] = m;
  if (unit !== undefined && unitBehind !== undefined) return null;
  // a capital P is peta for KiCad ("10PF" leaves it as 1e+16) and pico for the simulator
  if (multiplier === "P") return null;
  // "4k7", "4u7F" and "2R2": the letter stands where the decimal point is. One letter, and
  // no decimal point beside it.
  if (behind !== undefined && (decimals !== undefined || (multiplier ? unit !== undefined : unit === undefined))) return null;
  let number = whole;
  if (decimals !== undefined) {
    const thousands = separator === "," && decimals.length === 3 && whole !== "0";
    number = thousands ? `${whole}${decimals}` : `${whole}.${decimals}`;
  }
  if (behind !== undefined) number = `${whole}.${behind}`;
  const scale = multiplier === "M" || /^meg$/i.test(multiplier) ? "Meg" : /^[\u00b5\u03bc]$/.test(multiplier) ? "u" : multiplier;
  return { value: `${number}${scale}`, multiplier, unit: unit !== undefined || unitBehind !== undefined };
}

/**
 * A plain value ("22uF", "4k7", "5,1K", "1M", "2R2", "100") as the simulator takes it
 * ("22u", "4.7k", "5.1K", "1Meg", "2.2", "100"), or null for a text that is not one. It
 * reads the notations KiCad reads in a Value: a capital M is mega and a small one milli, a
 * comma is the decimal point unless exactly three digits follow it ("3,300uF"), and the
 * unit is left away. A capital P is not read: KiCad and the simulator take it differently.
 */
export function plainValue(piece: string): string | null {
  return readPlain(piece)?.value ?? null;
}

/**
 * True when a plain value can be meant in two ways on this kind of part. A capacitor or a
 * coil needs its multiplier or its unit: a bare "47" is 47 farad to the simulator, and
 * people write it for 47 uF. On a capacitor an "F" behind the number is femto to KiCad and
 * to the simulator ("1F", "0.47F" of a supercapacitor), so a femtofarad is read only as
 * "1fF".
 */
function twoMeanings(plain: Plain, kind: PassiveKind | undefined): boolean {
  if (kind === undefined || kind === "R") return false;
  if (plain.multiplier === "") return !plain.unit;
  return kind === "C" && /^f$/i.test(plain.multiplier) && !plain.unit;
}

const RATINGS: readonly RegExp[] = [
  // the voltage it stands: 25V, 6.3V, 6V3, 1kV, 250VAC
  /^\d+(?:[.,]\d+)?k?v\d*(?:ac|dc|rms)?$/i,
  // its tolerance: 1%, 0.1%, ±5%, +/-10%
  /^±?\d+(?:[.,]\d+)?%$/,
  // the power it stands: 1W, 0.25W, 250mW, 1/4W
  /^\d+(?:[.,]\d+)?m?w$/i,
  /^\d+\u2044\d+w$/i,
  // the current it stands: 2A, 500mA
  /^\d+(?:[.,]\d+)?m?a$/i,
  // how its value moves with temperature: 25ppm, 100ppm/K
  /^\d+ppm(?:\/°?[ck])?$/i,
  // its housing
  /^(?:01005|0201|0402|0603|0805|1008|1206|1210|1806|1808|1812|2010|2220|2512)$/,
  // the material of a ceramic capacitor: X7R, X5R, Y5V, C0G, NP0
  /^(?:[xyz]\d[a-z]|c0g|cog|np0|npo|u2j)$/i,
];

/**
 * The two ratings that are written with a "/" get a sign of their own before a Value is
 * split at "/": the fraction of a power ("1/4W", "1/4 W") and the tolerance ("+/-5%",
 * "+/- 5%").
 */
const FRACTION = "\u2044";
function oneSign(text: string): string {
  return text.replace(/(\d+)\/(\d+)\s*(?=w(?![a-z0-9]))/gi, `$1${FRACTION}$2`).replace(/(?:\+\/-|\+-|±)\s*(?=\d)/g, "±");
}

/** True for a rating that is known here: a voltage, a tolerance, a power, a current, a housing, a material. */
export function isRating(piece: string): boolean {
  const text = oneSign(piece);
  return RATINGS.some((re) => re.test(text));
}

/** What makes a text a formula or parameters of the simulator, and not ours to read. */
const FORMULA = /[{}'"=*]/;

/**
 * The pieces of a Value: split at blanks, at brackets and at "/", a unit that stands alone
 * joined to its number ("22 uF", "25 V"). `text` has been through oneSign.
 */
function pieces(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/[()[\]]/g, " ").trim().split(/\s+/)) {
    const chunk = raw.replace(/[,;]$/, "");
    if (!chunk) continue;
    const last = out[out.length - 1];
    if (last !== undefined && !/\d/.test(chunk) && /\d$/.test(last) && (out.length === 1 ? plainValue(last + chunk) !== null : known(last + chunk))) {
      out[out.length - 1] = last + chunk;
      continue;
    }
    out.push(...chunk.split("/").filter((p) => p));
  }
  return out;
}

const known = (piece: string): boolean => RATINGS.some((re) => re.test(piece));

/**
 * Reads the Value of a resistor, a capacitor or a coil that says more than its value:
 *   - a RatedValue when its first piece is a plain value and every other piece a rating
 *     that is known here;
 *   - "unreadable" for any other Value of several pieces ("10k/22k", "10k DNP"), for a
 *     rating that stands alone ("1/4W"), and for a value that can be meant in two ways on
 *     this kind of part (`kind`; a capacitor's "47/63V");
 *   - null when it is not ours to read: any other single piece, or a formula or parameters
 *     of the simulator.
 */
export function ratedValue(value: string, kind?: PassiveKind): RatedValue | "unreadable" | null {
  const typed = value.trim();
  if (!typed || FORMULA.test(typed)) return null;
  const [first, ...rest] = pieces(oneSign(typed));
  if (first === undefined) return null;
  // one piece is KiCad's or the simulator's to read, unless it is a rating and nothing else
  if (!rest.length) return known(first) ? "unreadable" : null;
  const plain = known(first) ? null : readPlain(first);
  if (plain === null || twoMeanings(plain, kind) || !rest.every(known)) return "unreadable";
  return { value: plain.value, shown: first, ratings: rest.map((r) => r.replace(FRACTION, "/")) };
}
