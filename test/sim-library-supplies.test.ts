// Where the power comes from when the schematic draws no source: the names that state a
// voltage, and the circuit that gets a source for them.
import { describe, expect, it } from "vitest";
import {
  buildDeck, fedParts, isSupplyWithoutVolts, kicadModels, matchSymbols, namedVolts, powerByName, readEditorNetlist, supplyLines,
  type LoadedPart, type Passing, type PartManifest, type SchematicSymbol,
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
    expect(power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: ["VCC"], assumed: [], noPower: [], unfed: [] });
  });

  it("leaves alone the wire a library part is the source of", () => {
    const { deck, power, placed } = build([BATTERY]);
    expect(placed.map((p) => `${p.ref}=${p.partId}`)).toEqual(["BT1=battery"]);
    expect(deck.slice(-4)).toEqual(["XBT1 +9V GND T_BATTERY VOLTS=9V", "Vpj_supply_1 pj_supply_1 0 DC 5", "Rpj_supply_1 pj_supply_1 +5V 10m", ".end"]);
    expect(power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: ["VCC"], assumed: [], noPower: [], unfed: [] });
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

// A dual op-amp: the part takes its power through VP and VN, and a symbol may lack the pins
// of a unit that is not placed.
const AMP_PINS = { INP1: "3", INN1: "2", OUT1: "1", INP2: "5", INN2: "6", OUT2: "7", VP: "8", VN: "4" };
const AMP: PartManifest = {
  schema: 1, id: "opamp-dual", version: 1, title: "Op-amp, dual",
  fits: [{ symbol: "Amplifier_Operational:LM358", pins: AMP_PINS, set: { high: "1.5", low: "0.02" } }],
  pins: Object.keys(AMP_PINS), mayLack: Object.keys(AMP_PINS), powered: ["VP", "VN"],
  settings: [{ name: "high", default: "0.05", accept: "^[0-9.]+$" }, { name: "low", default: "0.05", accept: "^[0-9.]+$" }],
  analog: { file: "model.lib", subckt: "T_AMP2", params: { HIGH: "$high", LOW: "$low" }, method: "gear" },
};
const ampDeck = (pins: Record<string, string>, live = false) => {
  const symbols = [sym("U1", "Amplifier_Operational:LM358", "LM358", pins), sym("R1", "Device:R", "10k", { "1": "OUT", "2": "GND" })];
  const netlist = readEditorNetlist({
    ok: true, messages: [], items: [{ device: "R", name: "R1", ref: "R1", type: "" }],
    lines: [{ text: ".title KiCad schematic" }, { kind: "item", ref: "R1", text: "R1 OUT GND 10k" }, { text: ".end" }],
  });
  const index = { parts: [{ id: AMP.id, version: 1, title: AMP.title, description: "", fits: AMP.fits, pins: AMP.pins, mayLack: AMP.mayLack, code: false, files: [] }] };
  const plan = matchSymbols(index, symbols);
  const model = `.subckt T_AMP2 ${AMP.pins.join(" ")} HIGH=0.05 LOW=0.05\nR1 OUT1 0 1k\n.ends T_AMP2\n`;
  return buildDeck({ symbols, netlist, plan, parts: new Map([[AMP.id, { id: AMP.id, manifest: AMP, analog: model, logic: null }]]), live });
};

describe("a chip and its power", () => {
  const WIRED = { "1": "OUT", "2": "OUT", "3": "IN", "5": "IN", "6": "OUT2", "7": "OUT2", "8": "+5V", "4": "GND" };

  it("runs with the settings its symbol has, and says nothing when its supply pins are wired", () => {
    const { deck, power, errors } = ampDeck(WIRED);
    expect(errors).toEqual([]);
    expect(deck).toContain("XU1 IN OUT OUT IN OUT2 OUT2 +5V GND T_AMP2 HIGH=1.5 LOW=0.02");
    expect(power.noPower).toEqual([]);
  });

  it("says which chip has no power: a supply pin with nothing on it", () => {
    // the way KiCad names the net of a pin that nothing is wired to
    const { power } = ampDeck({ ...WIRED, "8": "unconnected-_U1C-V+-Pad8_" });
    expect(power.noPower).toEqual([{ ref: "U1", pins: ["8"] }]);
  });

  it("says so too when the unit with the supply pins is not placed, and leaves those pins open", () => {
    const { "4": _4, "8": _8, ...halves } = WIRED;
    const { deck, power, errors } = ampDeck(halves);
    expect(errors).toEqual([]);
    expect(deck).toContain("XU1 IN OUT OUT IN OUT2 OUT2 unconnected-U1-8 unconnected-U1-4 T_AMP2 HIGH=1.5 LOW=0.02");
    expect(power.noPower).toEqual([{ ref: "U1", pins: ["4", "8"] }]);
  });

  it("leaves open the half that is not placed", () => {
    const { "5": _5, "6": _6, "7": _7, ...oneHalf } = WIRED;
    const { deck, power } = ampDeck(oneHalf);
    expect(deck).toContain("XU1 IN OUT OUT unconnected-U1-5 unconnected-U1-6 unconnected-U1-7 +5V GND T_AMP2 HIGH=1.5 LOW=0.02");
    expect(power.noPower).toEqual([]);
  });

  it("asks for Gear's method in a live run, in front of the analysis line", () => {
    expect(ampDeck(WIRED, true).deck.slice(-3)).toEqual([".options method=gear", ".tran 1m 100000 0 1m", ".end"]);
    // a plain circuit has neither line, and a run without such a part keeps the usual method
    expect(ampDeck(WIRED).deck.join("\n")).not.toContain(".options");
    expect(build([]).deck.join("\n")).not.toContain(".options");
  });
});

describe("which regulators have something to regulate", () => {
  const reg = (ref: string, from: string, to: string, pin = "3"): Passing => ({ ref, pins: [pin], from: [from], to: [to] });
  const feed = (nets: string[], driven: string[], links: string[][], passing: Passing[]) => {
    const { fed, unfed } = fedParts(nets, driven, links, passing);
    return { fed: [...fed].sort(), unfed };
  };

  it("the one with a source on its input wire, also behind a switch and a diode", () => {
    expect(feed(["+9V", "+5V", "GND"], ["+9V", "GND"], [], [reg("U1", "+9V", "+5V")])).toEqual({ fed: ["U1"], unfed: [] });
    // battery -> switch -> diode -> regulator; net names do not tell upper from lower case
    const links = [["Net-_BT1-+_", "Net-_SW1-B_"], ["net-_sw1-b_", "Net-_D1-K_"]];
    expect(feed(["Net-_BT1-+_", "Net-_SW1-B_", "Net-_D1-K_", "+5V"], ["Net-_BT1-+_", "GND"], links, [reg("U1", "Net-_D1-K_", "+5V")]))
      .toEqual({ fed: ["U1"], unfed: [] });
  });

  it("the one whose input wire is powered by its name", () => {
    expect(feed(["+12V", "+5V"], [], [], [reg("U1", "+12V", "+5V")])).toEqual({ fed: ["U1"], unfed: [] });
  });

  it("the one behind another regulator that has a source", () => {
    const chain = [reg("U2", "+5V", "+3V3"), reg("U1", "/VIN", "+5V")];
    expect(feed(["/VIN", "+5V", "+3V3"], ["/VIN"], [], chain)).toEqual({ fed: ["U1", "U2"], unfed: [] });
  });

  it("not the one whose input only ground reaches", () => {
    // a resistor from the battery to ground, and one from ground to the input: nothing comes through ground
    for (const ground of ["GND", "0", "GNDA", "/AGND"]) {
      const links = [["+9V", ground], [ground, "in"]];
      expect(feed(["+9V", ground, "in", "+5V"], ["+9V"], links, [reg("U1", "in", "+5V")])).toEqual({ fed: [], unfed: [{ ref: "U1", pins: ["3"] }] });
    }
  });

  it("not the one whose input has nothing on it, or a supply name without a voltage", () => {
    expect(feed(["unconnected-U1-3", "+5V"], [], [], [reg("U1", "unconnected-U1-3", "+5V")]).unfed).toEqual([{ ref: "U1", pins: ["3"] }]);
    expect(feed(["VBUS", "+3V3"], [], [], [reg("U1", "VBUS", "+3V3", "1")]).unfed).toEqual([{ ref: "U1", pins: ["1"] }]);
  });

  it("hands the first regulator's wire back to its name, and feeds the second from it", () => {
    // VIN (a connector nothing simulates) -> U1 -> +5V -> U2 -> +3V3
    const chain = [reg("U2", "+5V", "+3V3"), reg("U1", "VIN", "+5V")];
    expect(feed(["VIN", "+5V", "+3V3"], [], [], chain)).toEqual({ fed: ["U2"], unfed: [{ ref: "U1", pins: ["3"] }] });
    // the wire between them has no voltage in its name: both give nothing, +3V3 keeps its name
    const blind = [reg("U1", "VIN", "Net-_U1-OUT_"), reg("U2", "Net-_U1-OUT_", "+3V3")];
    expect(feed(["VIN", "Net-_U1-OUT_", "+3V3"], [], [], blind)).toEqual({ fed: [], unfed: [{ ref: "U1", pins: ["3"] }, { ref: "U2", pins: ["3"] }] });
  });

  it("ends for regulators drawn in a ring", () => {
    const ring = [reg("U1", "+3V3", "+5V"), reg("U2", "+5V", "+3V3")];
    expect(feed(["+5V", "+3V3"], [], [], ring)).toEqual({ fed: ["U2"], unfed: [{ ref: "U1", pins: ["3"] }] });
  });
});

// A regulator U1: 1 = input, 2 = ground, 3 = output on the wire +5V, and a load on that wire.
const REG: PartManifest = {
  schema: 1, id: "regulator", version: 1, title: "Voltage regulator",
  fits: [{ symbol: "Regulator_Linear:L7805", pins: { IN: "1", COM: "2", OUT: "3" }, set: { voltage: "5" } }],
  pins: ["IN", "OUT", "COM"], supplies: ["OUT"], suppliesFrom: ["IN"],
  settings: [{ name: "voltage", default: "5", accept: "^[0-9.]+$", fromValue: true }],
  analog: { file: "model.lib", subckt: "T_REG", params: { VOLTS: "$voltage" } },
};
const regDeck = (input: string, extra: { symbols?: SchematicSymbol[]; lines?: [string, string][] } = {}) => {
  const symbols = [
    sym("U1", "Regulator_Linear:L7805", "L7805", { "1": input, "2": "GND", "3": "+5V" }),
    sym("R1", "Device:R", "330", { "1": "+5V", "2": "GND" }),
    ...(extra.symbols ?? []),
  ];
  const lines: [string, string][] = [["R1", "R1 +5V GND 330"], ...(extra.lines ?? [])];
  const netlist = readEditorNetlist({
    ok: true, messages: [],
    items: lines.map(([ref, text]) => ({ device: text[0] ?? "R", name: text.split(" ")[0] ?? ref, ref, type: "" })),
    lines: [{ text: ".title KiCad schematic" }, ...lines.map(([ref, text]) => ({ kind: "item" as const, ref, text })), { text: ".end" }],
  });
  const index = { parts: [{ id: REG.id, version: 1, title: REG.title, description: "", fits: REG.fits, pins: REG.pins, code: false, files: [] }] };
  const plan = matchSymbols(index, symbols, { kicadModels: kicadModels(netlist, symbols) });
  const model = ".subckt T_REG IN OUT COM VOLTS=5\nR1 IN OUT 1\n.ends T_REG\n";
  return buildDeck({ symbols, netlist, plan, parts: new Map([[REG.id, { id: REG.id, manifest: REG, analog: model, logic: null }]]), live: false });
};

describe("a regulator and the wire on its output", () => {
  const battery = {
    symbols: [sym("BT1", "Device:Battery", "9V", { "1": "Net-_BT1-+_", "2": "GND" }), sym("D1", "Device:D", "1N4007", { "1": "/in", "2": "Net-_BT1-+_" })],
    lines: [["BT1", "VBT1 Net-_BT1-+_ GND DC 9 "], ["D1", "D1 Net-_BT1-+_ /in 1N4007"]] as [string, string][],
  };

  it("is the source of that wire when a battery reaches its input", () => {
    const { deck, power, errors } = regDeck("/in", battery);
    expect(errors).toEqual([]);
    expect(deck).toContain("XU1 /in +5V GND T_REG VOLTS=5");
    expect(deck.join("\n")).not.toContain("pj_supply");
    expect(power).toEqual({ byName: [], noVolts: [], assumed: [], noPower: [], unfed: [] });
  });

  it("leaves the wire to its name when no source reaches its input, and says so", () => {
    const { deck, power, errors } = regDeck("VBUS");
    expect(errors).toEqual([]);
    // the regulator stays in the circuit: without an input it does nothing
    expect(deck).toContain("XU1 VBUS +5V GND T_REG VOLTS=5");
    expect(deck.slice(-3)).toEqual(["Vpj_supply_1 pj_supply_1 0 DC 5", "Rpj_supply_1 pj_supply_1 +5V 10m", ".end"]);
    expect(power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: ["VBUS"], assumed: [], noPower: [], unfed: [{ ref: "U1", pins: ["1"] }] });
  });

  it("says so too when its input pin has nothing on it", () => {
    // the way KiCad names the net of a pin that nothing is wired to
    const { power } = regDeck("unconnected-_U1-IN-Pad1_");
    expect(power.unfed).toEqual([{ ref: "U1", pins: ["1"] }]);
    expect(power.byName).toEqual([{ net: "+5V", volts: 5 }]);
  });

  it("is fed by a wire that is powered by its name", () => {
    const { power } = regDeck("+12V");
    expect(power.byName).toEqual([{ net: "+12V", volts: 12 }]);
    expect(power.unfed).toEqual([]);
  });

  it("does not say that it runs with an assumed voltage", () => {
    expect(regDeck("VBUS").power.assumed).toEqual([]);
  });
});
