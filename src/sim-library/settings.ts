// The settings of one placed part. A user can change settings and nothing else.
//
// A setting's value is the one thing a user's schematic puts into the SPICE netlist, so a
// value passes only when the part allows it: it must be a plain token, and it must be one of
// the part's `options` or match its `accept` pattern.
//
// The changed settings live in the field PCBJam.SimSettings on the symbol, as
// "name=value name=value".
import type { PartManifest, PartSetting } from "./format.js";
import { FIELD_SETTINGS } from "./match.js";

/** What a value may be made of, whatever the part says: nothing that could end or extend a SPICE line. */
const TOKEN = /^[A-Za-z0-9_.+-]{1,32}$/;

/** "name=value name=value" -> { name: value } */
export function parseSettings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split(/\s+/).filter(Boolean)) {
    const k = pair.indexOf("=");
    if (k > 0) out[pair.slice(0, k)] = pair.slice(k + 1);
  }
  return out;
}

/** { name: value } -> "name=value name=value", in the order given. */
export function formatSettings(values: Record<string, string>): string {
  return Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" ");
}

/** May this setting take this value? */
export function settingAllows(setting: PartSetting, value: string): boolean {
  if (!TOKEN.test(value)) return false;
  if (setting.options && !setting.options.includes(value)) return false;
  if (setting.accept !== undefined) {
    try { if (!new RegExp(setting.accept).test(value)) return false; } catch { return false; }
  }
  return true;
}

/**
 * What the symbol's Value says this setting is, or null: the Value itself when it is an
 * allowed value, else the first of the setting's `valueForms` that matches and gives one.
 * `whole: false` leaves the first way out: another setting of the part has taken the Value
 * as it is.
 */
export function settingFromValue(setting: PartSetting, text: string, whole = true): string | null {
  if (whole && settingAllows(setting, text)) return text;
  for (const form of setting.valueForms ?? []) {
    let m: RegExpExecArray | null;
    try { m = new RegExp(form.match).exec(text); } catch { continue; }
    if (!m) continue;
    const groups = m;
    const value = form.value.replace(/\$([1-9])/g, (_, n: string) => groups[Number(n)] ?? "");
    if (settingAllows(setting, value)) return value;
  }
  return null;
}

export interface ResolvedSettings {
  /** Every setting of the part with its value and where the value came from. */
  values: Record<string, { value: string; from: "default" | "symbol" | "value" | "field" | "wire" }>;
  /** What was dropped and why, in plain words, for the user. */
  notes: string[];
}

/**
 * Where a value comes from, last wins: the part's default, what the part's "fits" line says
 * this symbol has (`set`), the symbol's Value (when the part says its Value is that setting
 * and the Value is allowed, or one of the setting's `valueForms` reads an allowed value out
 * of it), the settings field. A value the part does not allow is dropped with a note; it
 * never reaches the netlist.
 *
 * The Value as it is stands for one setting, the first that allows it: a lamp's "12" is its
 * 12 V, and not its 12 A too. The forms can read several settings out of one Value ("12V
 * 100mA").
 */
export function resolveSettings(manifest: Pick<PartManifest, "settings">, sym: { ref: string; value: string; fields: Record<string, string> }, set: Record<string, string> = {}): ResolvedSettings {
  const given = parseSettings(sym.fields[FIELD_SETTINGS] ?? "");
  const values: ResolvedSettings["values"] = {};
  const notes: string[] = [];
  const settings = manifest.settings ?? [];
  let taken = false; // the Value as it is has been one setting's value
  for (const s of settings) {
    let value = s.default;
    let from: "default" | "symbol" | "value" | "field" = "default";
    const fitted = set[s.name];
    if (fitted !== undefined && settingAllows(s, fitted)) { value = fitted; from = "symbol"; }
    const said = s.fromValue ? settingFromValue(s, sym.value, !taken) : null;
    if (said !== null) { value = said; from = "value"; }
    if (said !== null && said === sym.value) taken = true;
    const asked = given[s.name];
    if (asked !== undefined) {
      if (settingAllows(s, asked)) { value = asked; from = "field"; }
      else notes.push(`${sym.ref}: ${s.name}=${asked} is not a value this part takes, using ${value}`);
    }
    values[s.name] = { value, from };
  }
  for (const k of Object.keys(given))
    if (!settings.some((s) => s.name === k)) notes.push(`${sym.ref}: the part has no setting "${k}"`);
  return { values, notes };
}

/** The subcircuit parameters of one placed part: `analog.params` with every "$name" filled in. */
export function analogParams(manifest: Pick<PartManifest, "analog">, resolved: ResolvedSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(manifest.analog.params ?? {}))
    out[k] = v.startsWith("$") ? resolved.values[v.slice(1)]?.value ?? "" : v;
  return out;
}
