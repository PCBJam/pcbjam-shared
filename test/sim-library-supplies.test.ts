// Where the power comes from when the schematic draws no source: the names that state a
// voltage, and the circuit that gets a source for them.
import { describe, expect, it } from "vitest";
import {
  buildDeck, isSupplyWithoutVolts, kicadModels, matchSymbols, namedVolts, powerByName, readEditorNetlist, supplyLines,
  type LoadedPart, type PartManifest, type SchematicSymbol,
} from "../src/sim-library/index.js";

describe("the voltage a wire's name states", () => {
  it("reads the names of KiCad's power symbols", () => {
    const volts = (names: string[]) => names.map((n) => namedVolts(n));
    expect(volts(["+5V", "+12V", "-12V", "+3.3V", "+7.5V", "+48V"])).toEqual([5, 12, -12, 3.3, 7.5, 48]);
    expect(volts(["+3V3", "+1V8", "+1V35", "-2V5", "+3V0"])).toEqual([3.3, 1.8, 1.35, -2.5, 3]);
    // a short suffix says which supply of that voltage it is
    expect(volts(["+5VA", "+5VD", "+3.3VADC", "-12VA", "+3V3A"])).toEqual([5, 5, 3.3, -12, 3.3]);
    expect(volts(["+12C", "+12LF", "+5P"])).toEqual([12, 12, 5]);
    // written small, as some labels are
    expect(volts(["+5v", "3v3"])).toEqual([5, 3.3]);
  });

  it("reads 0 V out of the name of a second ground", () => {
    for (const name of ["GNDA", "GNDD", "GND1", "GNDPWR", "GNDREF", "AGND", "DGND", "PGND", "Earth", "Earth_Protective", "/GND", "/Analog/AGND"])
      expect([name, namedVolts(name)]).toEqual([name, 0]);
    for (const name of ["GND_SENSE", "GNDSENSE_P", "Earthing", "VSS", "NGND"]) expect([name, namedVolts(name)]).toEqual([name, null]);
  });

  it("reads a label that is written without the sign, also inside a sheet", () => {
    expect(namedVolts("5V")).toBe(5);
    expect(namedVolts("3V3")).toBe(3.3);
    expect(namedVolts("/5V")).toBe(5);
    expect(namedVolts("/Power/3.3V")).toBe(3.3);
  });

  it("takes nothing out of a name that states no voltage, or that can be a signal", () => {
    for (const name of ["VCC", "VDD", "VBUS", "+BATT", "0", "Net-_R1-Pad1_", "/SDA", "V1", "+V", "5", "12C", "V5", "12VAC", "230VAC", "VAC"])
      expect([name, namedVolts(name)]).toEqual([name, null]);
    for (const name of ["5V_EN", "+3V3_MCU", "+5V_USB", "3V3_PGOOD", "/Key_1/5V_SENSE", "+5VSTANDBY"])
      expect([name, namedVolts(name)]).toEqual([name, null]);
  });

  it("knows a supply name without a voltage from any other name", () => {
    for (const name of ["VCC", "VDD", "VEE", "VSS", "VBUS", "VAA", "VDDA", "VCCQ", "VPP", "+BATT", "-BATT", "VBAT", "VIN", "+VSW", "/Power/VCC", "VCC1"])
      expect([name, isSupplyWithoutVolts(name)]).toEqual([name, true]);
    for (const name of ["+5V", "GND", "GNDA", "/SDA", "VOUT", "VREF", "V1", "Net-_U1-VCC_", "VSENSE", "VINP", "VCOMP", "VSYNC", "VDDCORE_EN"])
      expect([name, isSupplyWithoutVolts(name)]).toEqual([name, false]);
  });
});

describe("which wires get power by their name", () => {
  it("the ones whose name states a voltage, when no source sits on them", () => {
    const nets = ["GND", "+5V", "Net-_D1-A_", "+3V3", "VCC", "-12V", "+9V", "/SDA", "+BATT", "unconnected-_U1-Pad3_", "+5V", "GNDA"];
    const power = powerByName(nets, ["+9V", "+BATT", "GND"]);
    expect(power.byName).toEqual([{ net: "-12V", volts: -12 }, { net: "+3V3", volts: 3.3 }, { net: "+5V", volts: 5 }, { net: "GNDA", volts: 0 }]);
    // VCC states no voltage; +BATT does not either, but a source sits on it
    expect(power.noVolts).toEqual(["VCC"]);
    // each a source to ground and its small resistance to the wire
    expect(supplyLines(power.byName)).toEqual([
      "Vpj_supply_1 pj_supply_1 0 DC -12", "Rpj_supply_1 pj_supply_1 -12V 10m",
      "Vpj_supply_2 pj_supply_2 0 DC 3.3", "Rpj_supply_2 pj_supply_2 +3V3 10m",
      "Vpj_supply_3 pj_supply_3 0 DC 5", "Rpj_supply_3 pj_supply_3 +5V 10m",
      "Vpj_supply_4 pj_supply_4 0 DC 0", "Rpj_supply_4 pj_supply_4 GNDA 10m",
    ]);
  });

  it("holds a second ground at 0 V also when a source sits on it", () => {
    // a battery from +9V to GNDA: the battery powers +9V, and GNDA still needs its path to ground
    const power = powerByName(["+9V", "GNDA", "GND"], ["+9V", "GNDA"]);
    expect(power.byName).toEqual([{ net: "GNDA", volts: 0 }]);
  });

  it("does not tell upper from lower case, as the simulator does not", () => {
    expect(powerByName(["+5V", "+5v"], []).byName).toEqual([{ net: "+5V", volts: 5 }]);
    expect(powerByName(["+5V"], ["+5v"]).byName).toEqual([]);
    expect(powerByName(["gnd", "GND"], []).byName).toEqual([]);
  });
});

// A board with no simulation source: +5V into a resistor, a battery BT1 on +9V, and VCC.
const sym = (ref: string, libId: string, value: string, pins: Record<string, string>, fields: Record<string, string> = {}): SchematicSymbol => ({
  ref, uuid: `uuid-${ref}`, libId, value, sheet: "/", fields: { Value: value, ...fields },
  pins: Object.fromEntries(Object.entries(pins).map(([n, node]) => [n, { name: "", node }])),
});
const SYMBOLS = [
  sym("R1", "Device:R", "330", { "1": "+5V", "2": "GND" }),
  sym("R2", "Device:R", "1k", { "1": "+9V", "2": "GND" }),
  sym("R3", "Device:R", "1k", { "1": "VCC", "2": "GND" }),
  sym("BT1", "Device:Battery", "9V", { "1": "+9V", "2": "GND" }, { "Sim.Device": "V", "Sim.Type": "DC", "Sim.Pins": "1=+ 2=-" }),
];
const symbolsWith = (batteryValue: string) => SYMBOLS.map((s) => (s.ref === "BT1" ? { ...s, value: batteryValue, fields: { ...s.fields, Value: batteryValue } } : s));
const netlistOf = (battery: string) => readEditorNetlist({
  ok: true, messages: [],
  items: [
    { device: "R", name: "R1", ref: "R1", type: "" }, { device: "R", name: "R2", ref: "R2", type: "" },
    { device: "R", name: "R3", ref: "R3", type: "" }, { device: "V", name: "VBT1", ref: "BT1", type: "DC" },
  ],
  lines: [
    { text: ".title KiCad schematic" },
    { kind: "item", ref: "R1", text: "R1 +5V GND 330" },
    { kind: "item", ref: "R2", text: "R2 +9V GND 1k" },
    { kind: "item", ref: "R3", text: "R3 VCC GND 1k" },
    { kind: "item", ref: "BT1", text: battery },
    { text: ".end" },
  ],
});
const BATTERY: PartManifest = {
  schema: 1, id: "battery", version: 1, title: "Battery",
  fits: [{ symbol: "Device:Battery", pins: { P: "1", N: "2" } }],
  pins: ["P", "N"], supplies: ["P", "N"],
  settings: [{ name: "voltage", label: "Voltage", unit: "V", default: "9", accept: "^[0-9]+(\\.[0-9]+)?[Vv]?$", fromValue: true }],
  analog: { file: "model.lib", subckt: "T_BATTERY", params: { VOLTS: "$voltage" } },
};
const loaded = (manifest: PartManifest): LoadedPart => ({ id: manifest.id, manifest, analog: `.subckt ${manifest.analog.subckt} P N VOLTS=9\nV1 P i dc {VOLTS}\nR1 i N 0.2\n.ends ${manifest.analog.subckt}\n`, logic: null });
const indexOf = (parts: PartManifest[]) => ({ parts: parts.map((m) => ({ id: m.id, version: m.version, title: m.title, description: "", fits: m.fits, pins: m.pins, code: false, files: [] })) });

function build(parts: PartManifest[], batteryValue = "9V") {
  // KiCad writes the Value into its own line as it is: "DC 9" for 9V, "DC Battery" for Battery
  const netlist = netlistOf(`VBT1 +9V GND DC ${batteryValue === "9V" ? "9" : batteryValue} `);
  const symbols = symbolsWith(batteryValue);
  const plan = matchSymbols(indexOf(parts), symbols, { kicadModels: kicadModels(netlist, symbols) });
  return buildDeck({ symbols, netlist, plan, parts: new Map(parts.map((m) => [m.id, loaded(m)])), live: false });
}

describe("the circuit of a schematic that draws no source", () => {
  it("powers +5V by its name, and leaves alone the wire a voltage source sits on", () => {
    const { deck, power, errors } = build([]);
    expect(errors).toEqual([]);
    expect(deck).toEqual([
      ".title KiCad schematic",
      "R1 +5V GND 330",
      "R2 +9V GND 1k",
      "R3 VCC GND 1k",
      "VBT1 +9V GND DC 9 ",
      "Vpj_supply_1 pj_supply_1 0 DC 5",
      "Rpj_supply_1 pj_supply_1 +5V 10m",
      ".end",
    ]);
    expect(power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: ["VCC"], assumed: [] });
  });

  it("leaves alone the wire a library part is the source of", () => {
    const { deck, power, placed } = build([BATTERY]);
    expect(placed.map((p) => `${p.ref}=${p.partId}`)).toEqual(["BT1=battery"]);
    expect(deck.slice(-4)).toEqual(["XBT1 +9V GND T_BATTERY VOLTS=9V", "Vpj_supply_1 pj_supply_1 0 DC 5", "Rpj_supply_1 pj_supply_1 +5V 10m", ".end"]);
    expect(power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: ["VCC"], assumed: [] });
  });

  it("says which battery runs with the part's own voltage, because its value does not say one", () => {
    const { deck, power } = build([BATTERY], "Battery");
    expect(deck).toContain("XBT1 +9V GND T_BATTERY VOLTS=9");
    // KiCad's own line for it ("DC Battery") is gone with the part in its place
    expect(deck.join("\n")).not.toContain("DC Battery");
    expect(power.assumed).toEqual([{ ref: "BT1", label: "Voltage", value: "9", unit: "V" }]);
  });

  it("powers the wire when the part on it is not a source", () => {
    const { supplies: _, ...plain } = BATTERY;
    const { power } = build([plain]);
    expect(power.byName).toEqual([{ net: "+5V", volts: 5 }, { net: "+9V", volts: 9 }]);
  });
});
