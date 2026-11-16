import { describe, expect, it } from "vitest";
import { FIELD_SETTINGS, analogParams, formatSettings, parseSettings, resolveSettings, settingFromValue, type PartSetting } from "../src/sim-library/index.js";
import { LED as led, POT as pot } from "./sim-library-fixtures.js";
const sym = (value: string, settings?: string): { ref: string; value: string; fields: Record<string, string> } =>
  ({ ref: "RV1", value, fields: settings === undefined ? {} : { [FIELD_SETTINGS]: settings } });

describe("the settings of a placed part", () => {
  it("start from the part's default", () => {
    expect(resolveSettings(pot, sym("RV"))).toEqual({ values: { resistance: { value: "10k", from: "default" } }, notes: [] });
  });
  it("take the symbol's Value when the part says so and the Value is allowed", () => {
    expect(resolveSettings(pot, sym("47k")).values.resistance).toEqual({ value: "47k", from: "value" });
    expect(resolveSettings(led, sym("green")).values.color).toEqual({ value: "green", from: "value" });
    expect(resolveSettings(led, sym("LTST-C150")).values.color).toEqual({ value: "red", from: "default" });
  });
  it("read the setting out of a Value written another way, when the part gives the forms", () => {
    const volts: PartSetting = {
      name: "voltage", default: "5.1", accept: "^[0-9]+(\\.[0-9]+)?$", fromValue: true,
      valueForms: [{ match: "([0-9]+)V([0-9]+)", value: "$1.$2" }, { match: "^ZD([0-9]+)$", value: "$1" }, { match: "^bad(", value: "1" }, { match: "^X(.*)$", value: "$1" }],
    };
    // the Value itself, when it is allowed, before any form
    expect(settingFromValue(volts, "12")).toBe("12");
    // the first form that matches and gives an allowed value
    expect(settingFromValue(volts, "BZX84C5V1")).toBe("5.1");
    expect(settingFromValue(volts, "ZD12")).toBe("12");
    // a form whose value the part does not allow gives nothing; a broken pattern is passed over
    expect(settingFromValue(volts, "Xabc")).toBeNull();
    expect(settingFromValue(volts, "X; .include")).toBeNull();
    expect(settingFromValue(volts, "1N4148")).toBeNull();
    // in a placed part: from the Value, and the settings field still wins
    const part = { settings: [volts] };
    expect(resolveSettings(part, sym("BZX84C5V1")).values.voltage).toEqual({ value: "5.1", from: "value" });
    expect(resolveSettings(part, sym("1N4148")).values.voltage).toEqual({ value: "5.1", from: "default" });
    expect(resolveSettings(part, sym("BZX84C5V1", "voltage=9")).values.voltage).toEqual({ value: "9", from: "field" });
    // without fromValue the forms are not looked at
    expect(resolveSettings({ settings: [{ ...volts, fromValue: false }] }, sym("BZX84C5V1")).values.voltage).toEqual({ value: "5.1", from: "default" });
  });
  it("give the Value as it is to one setting only, the first that allows it", () => {
    // a lamp: both of its settings can come from the Value, and both would allow a bare "12"
    const lamp = { settings: [
      { name: "voltage", default: "6", accept: "^[0-9]+$", fromValue: true, valueForms: [{ match: "([0-9]+) ?V", value: "$1" }] },
      { name: "current", default: "100m", accept: "^[0-9]+m?$", fromValue: true, valueForms: [{ match: "([0-9]+) ?mA", value: "$1m" }] },
    ] };
    const of = (value: string) => Object.fromEntries(Object.entries(resolveSettings(lamp, { ref: "LA1", value, fields: {} }).values).map(([k, v]) => [k, `${v.value} (${v.from})`]));
    expect(of("12")).toEqual({ voltage: "12 (value)", current: "100m (default)" });
    // written out, the Value says both
    expect(of("12V 50mA")).toEqual({ voltage: "12 (value)", current: "50m (value)" });
    // a Value only the second setting allows is the second one's
    expect(of("20m")).toEqual({ voltage: "6 (default)", current: "20m (value)" });
  });

  it("take the settings field last", () => {
    expect(resolveSettings(pot, sym("47k", "resistance=1k")).values.resistance).toEqual({ value: "1k", from: "field" });
  });
  it("drop a value the part does not allow, and say so", () => {
    expect(resolveSettings(pot, sym("47k", "resistance=lots"))).toEqual({
      values: { resistance: { value: "47k", from: "value" } },
      notes: ["RV1: resistance=lots is not a value this part takes, using 47k"],
    });
    expect(resolveSettings(led, sym("red", "color=pink")).notes).toEqual(["RV1: color=pink is not a value this part takes, using red"]);
  });
  it("never let SPICE text through, whatever the part's own rule says", () => {
    const loose = { settings: [{ name: "r", default: "1k", accept: ".*" }] };
    for (const evil of ["1k\n.include x", "1k}", "1k'", "{1k}", "1k;x", "1k x"])
      expect(resolveSettings(loose, { ref: "R1", value: "", fields: { [FIELD_SETTINGS]: `r=${evil}` } }).values.r?.value).toBe("1k");
  });
  it("name a setting the part does not have", () => {
    expect(resolveSettings(pot, sym("10k", "taper=log")).notes).toEqual(["RV1: the part has no setting \"taper\""]);
  });
  it("reach the analog model as subcircuit parameters", () => {
    expect(analogParams(pot, resolveSettings(pot, sym("47k")))).toEqual({ RTOT: "47k" });
    expect(analogParams(led, resolveSettings(led, sym("red")))).toEqual({});
  });
  it("read and write the field", () => {
    expect(parseSettings("noise=1m  rate=10k")).toEqual({ noise: "1m", rate: "10k" });
    expect(formatSettings({ noise: "1m", rate: "10k" })).toBe("noise=1m rate=10k");
    expect(parseSettings("")).toEqual({});
  });
});
