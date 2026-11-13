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

export interface ResolvedSettings {
  /** Every setting of the part with its value and where the value came from. */
  values: Record<string, { value: string; from: "default" | "value" | "field" }>;
  /** What was dropped and why, in plain words, for the user. */
  notes: string[];
}

/**
 * Where a value comes from, last wins: the part's default, the symbol's Value (when the part
 * says its Value is that setting and the Value is allowed), the settings field. A value the
 * part does not allow is dropped with a note; it never reaches the netlist.
 */
export function resolveSettings(manifest: Pick<PartManifest, "settings">, sym: { ref: string; value: string; fields: Record<string, string> }): ResolvedSettings {
  const given = parseSettings(sym.fields[FIELD_SETTINGS] ?? "");
  const values: ResolvedSettings["values"] = {};
  const notes: string[] = [];
  const settings = manifest.settings ?? [];
  for (const s of settings) {
    let value = s.default;
    let from: "default" | "value" | "field" = "default";
    if (s.fromValue && settingAllows(s, sym.value)) { value = sym.value; from = "value"; }
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
