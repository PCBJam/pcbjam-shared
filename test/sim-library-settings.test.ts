import { describe, expect, it } from "vitest";
import { FIELD_SETTINGS, analogParams, formatSettings, parseSettings, resolveSettings } from "../src/sim-library/index.js";
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
