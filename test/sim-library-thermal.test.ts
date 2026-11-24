// Heat as a circuit the user draws (src/sim-library/thermal.ts). A heater, a fan and a
// temperature sensor written out by hand, on a board whose lines are made up the way the
// editor would report them: the air outside is a voltage source, the walls a resistor,
// the air in the box a capacitor.
import { describe, expect, it } from "vitest";
import {
  FIELD_THERMAL, LIVE_TRAN, buildDeck, findWire, kicadModels, matchSymbols, overlayOf, thermalFile, thermalModel, thermalPins, thermalRoles,
  wireProblemText, wiresOf,
  type EditorNetlist, type LibraryIndex, type LoadedPart, type PartManifest, type SchematicSymbol,
} from "../src/sim-library/index.js";

const SENSOR: PartManifest = {
  schema: 1, id: "sensor", version: 1, title: "Sensor",
  fits: [{ symbol: "Device:Thermistor_NTC" }],
  pins: ["1", "2"],
  analog: { file: "model.lib", subckt: "T_NTC" },
  inputs: [
    { name: "temperature", type: "range", source: "Vtemp", min: -40, max: 125, default: 25 },
    { name: "trim", type: "range", source: "Vtrim", min: 0, max: 1, default: 0 },
  ],
  overlay: [
    { widget: "slider", place: { below: "bbox" }, input: "temperature", unit: "°C" },
    { widget: "slider", place: { below: "bbox" }, input: "trim" },
  ],
  thermal: { temperature: "temperature", overlay: [{ widget: "meter", place: { below: "bbox" }, signal: "wire", unit: "°C", prefix: false, decimals: 1 }] },
};
const SENSOR_MODEL = `* a sensor
.subckt T_NTC 1 2
+ OHMS=10k
Vtemp temp 0 dc 25
Vtrim trim 0 dc 0
R1 1 2 r = '{OHMS} * (1 + V(trim)) * exp(3950 * (1 / (V(temp) + 273.15) - 1 / 298.15))'
.ends T_NTC
`;
const FAN: PartManifest = {
  schema: 1, id: "fan", version: 1, title: "Fan",
  fits: [{ symbol: "Motor:Fan" }],
  pins: ["1", "2"],
  settings: [{ name: "cooling", default: "1", accept: "^[0-9]+(\\.[0-9]+)?$" }],
  analog: { file: "model.lib", subckt: "T_FAN" },
  signals: [{ name: "speed", current: "Vspeed" }],
  thermal: { air: { signal: "speed", full: "$cooling" } },
};
const FAN_MODEL = `.subckt T_FAN 1 2
R1 1 2 80
Bspeed sv 0 V = V(1, 2) / 12
Rspeed sv si 1
Vspeed si 0 dc 0
.ends T_FAN
`;
const HEATER: PartManifest = {
  schema: 1, id: "heater", version: 1, title: "Heater",
  fits: [{ symbol: "Device:Heater" }],
  pins: ["1", "2"],
  analog: { file: "model.lib", subckt: "T_HEATER" },
  signals: [{ name: "power", current: "Vpower" }],
  thermal: { heat: "power" },
};
const HEATER_MODEL = `.subckt T_HEATER 1 2
R1 1 2 28.8
Bpower pw 0 V = V(1, 2) * V(1, 2) / 28.8
Rpower pw pwi 1
Vpower pwi 0 dc 0
.ends T_HEATER
`;
const LAMP: PartManifest = {
  schema: 1, id: "lamp", version: 1, title: "Lamp",
  fits: [{ symbol: "Device:Lamp" }],
  pins: ["1", "2"],
  analog: { file: "model.lib", subckt: "T_LAMP" },
};

const MADE: [PartManifest, string][] = [[SENSOR, SENSOR_MODEL], [FAN, FAN_MODEL], [HEATER, HEATER_MODEL], [LAMP, ".subckt T_LAMP 1 2\nR1 1 2 120\n.ends T_LAMP\n"]];
const PARTS = new Map<string, LoadedPart>(MADE.map(([manifest, analog]) => [manifest.id, { id: manifest.id, manifest, analog, logic: null }]));
const INDEX: Pick<LibraryIndex, "parts"> = {
  parts: MADE.map(([m]) => ({
    id: m.id, version: m.version, title: m.title, description: "", fits: m.fits, pins: m.pins, code: false, files: [],
    ...(m.thermal ? { thermal: thermalRoles(m.thermal) } : {}),
  })),
};

const sym = (ref: string, libId: string, nodes: [string, string], wires?: string, sheet = "/"): SchematicSymbol => ({
  ref, uuid: ref, sheet, libId, value: "", fields: wires === undefined ? {} : { [FIELD_THERMAL]: wires },
  pins: { "1": { name: "", node: nodes[0] }, "2": { name: "", node: nodes[1] } },
});
const item = (ref: string, text: string) => ({ kind: "item" as const, ref, text });
// What the user draws for the box: the air outside (25 degrees), the walls (4 degrees for
// every watt), the air inside (5 joules for every degree).
const DRAWN = [sym("V1", "Simulation_SPICE:VDC", ["/OUTSIDE", "GND"]), sym("R9", "Device:R", ["/OUTSIDE", "/BOX"]), sym("C1", "Device:C", ["/BOX", "GND"])];
const DRAWN_LINES = [item("V1", "V1 /OUTSIDE GND DC 25"), item("R9", "R9 /OUTSIDE /BOX 4"), item("C1", "C1 /BOX GND 5")];
const netlistOf = (lines: { kind: "item"; ref: string; text: string }[]): EditorNetlist => ({
  ok: true, messages: [],
  items: lines.map((l) => ({ ref: l.ref, name: l.ref, device: l.ref[0] ?? "", type: "", off: false })),
  lines: [{ text: ".title heat" }, ...lines, { text: ".end" }],
});

function build(symbols: SchematicSymbol[], lines = DRAWN_LINES, live = false) {
  const netlist = netlistOf(lines);
  const plan = matchSymbols(INDEX, symbols, { kicadModels: kicadModels(netlist, symbols) });
  return buildDeck({ symbols, netlist, plan, parts: PARTS, live });
}

describe("thermal pins", () => {
  it("are one for a part's own temperature and two for the air it moves", () => {
    expect(thermalPins(["heat"])).toEqual([{ pin: "PJTH", does: "heats" }]);
    expect(thermalPins(["temperature"])).toEqual([{ pin: "PJTH", does: "feels" }]);
    expect(thermalPins(["heat", "temperature"])).toEqual([{ pin: "PJTH", does: "heats-feels" }]);
    expect(thermalPins(["air"])).toEqual([{ pin: "PJTA", does: "air" }, { pin: "PJTB", does: "air" }]);
    expect(thermalPins(["heat", "air"]).map((p) => p.pin)).toEqual(["PJTH", "PJTA", "PJTB"]);
    expect(thermalRoles({ air: { signal: "speed", full: "1" }, heat: "power" })).toEqual(["heat", "air"]);
  });
});

describe("a wire's name", () => {
  const nets = ["/BOX", "GND", "+5V", "/Key_1/MID", "/Key_2/MID", "/Key_1/HOT", "AMBIENT", "Net-_R1-Pad1_", "/T_case_"];
  it("means the wire with that label on the symbol's own sheet, whatever the case", () => {
    expect(findWire("BOX", nets)).toEqual({ node: "/BOX" });
    expect(findWire("box", nets)).toEqual({ node: "/BOX" });
    expect(findWire("MID", nets, "/Key 2/")).toEqual({ node: "/Key_2/MID" });
    // KiCad writes a bracket as "_" into a net's name
    expect(findWire("T(case)", nets)).toEqual({ node: "/T_case_" });
  });
  it("means a wire named for every sheet, and a wire of another sheet when only one has the label", () => {
    expect(findWire("AMBIENT", nets, "/Key 1/")).toEqual({ node: "AMBIENT" });
    expect(findWire("+5V", nets)).toEqual({ node: "+5V" });
    expect(findWire("HOT", nets)).toEqual({ node: "/Key_1/HOT" });
    expect(findWire("/Key_1/MID", nets)).toEqual({ node: "/Key_1/MID" });
  });
  it("says why it means none", () => {
    expect(findWire("MID", nets)).toEqual({ problem: { why: "several", name: "MID" } });
    expect(findWire("OVEN", nets)).toEqual({ problem: { why: "no-wire", name: "OVEN" } });
    expect(findWire("", nets)).toEqual({ problem: { why: "name", name: "" } });
  });
  it("is asked for once for every thermal pin", () => {
    const at = (said: string) => ({ fields: { [FIELD_THERMAL]: said }, sheet: "/" });
    expect(wiresOf({ fields: {} }, 1, nets)).toBeNull();
    expect(wiresOf(at("  "), 1, nets)).toBeNull();
    expect(wiresOf(at("BOX"), 1, nets)).toEqual({ nodes: ["/BOX"] });
    expect(wiresOf(at("BOX  AMBIENT"), 2, nets)).toEqual({ nodes: ["/BOX", "AMBIENT"] });
    expect(wiresOf(at("BOX"), 2, nets)).toEqual({ problem: { why: "count", needs: 2 } });
    expect(wiresOf(at("BOX OVEN"), 2, nets)).toEqual({ problem: { why: "no-wire", name: "OVEN" } });
    expect(wireProblemText("M1", "Fan", { why: "count", needs: 2 })).toBe("M1 is on no heat wires: Fan has 2 thermal pins, so it takes the names of 2 wires.");
    expect(wireProblemText("R1", "Heater", { why: "no-wire", name: "OVEN" })).toContain('no wire of the schematic is called "OVEN"');
  });
});

describe("a part's model with its thermal pins", () => {
  it("is as warm as its pin: the temperature's source stands on the pin", () => {
    expect(thermalModel(SENSOR_MODEL, "T_NTC", { temperature: "Vtemp" }).split("\n")).toEqual([
      ".subckt T_NTC_TH 1 2 PJTH OHMS=10k",
      "Vtemp temp PJTH dc 0",
      "Vtrim trim 0 dc 0",
      "R1 1 2 r = '{OHMS} * (1 + V(trim)) * exp(3950 * (1 / (V(temp) + 273.15) - 1 / 298.15))'",
      "Bpjwire pjwv 0 V = V(PJTH)",
      "Rpjwire pjwv pjwi 1",
      "Vpjwire pjwi 0 dc 0",
      ".ends T_NTC_TH",
    ]);
  });
  it("gives its heat to its pin as a current, from the moment the circuit starts", () => {
    expect(thermalModel(HEATER_MODEL, "T_HEATER", { heat: "Vpower" }).split("\n")).toEqual([
      ".subckt T_HEATER_TH 1 2 PJTH",
      "R1 1 2 28.8",
      "Bpower pw 0 V = V(1, 2) * V(1, 2) / 28.8",
      "Rpower pw pwi 1",
      "Vpower pwi 0 dc 0",
      "Bpjheat 0 PJTH I = I(Vpower) * min(1, time * 1meg)",
      "Bpjwire pjwv 0 V = V(PJTH)",
      "Rpjwire pjwv pjwi 1",
      "Vpjwire pjwi 0 dc 0",
      ".ends T_HEATER_TH",
    ]);
  });
  it("carries heat between its two air pins, more the faster it turns", () => {
    expect(thermalModel(FAN_MODEL, "T_FAN", { air: "Vspeed" }).split("\n")).toEqual([
      ".subckt T_FAN_TH 1 2 PJTA PJTB PJFULL=1",
      "R1 1 2 80",
      "Bspeed sv 0 V = V(1, 2) / 12",
      "Rspeed sv si 1",
      "Vspeed si 0 dc 0",
      "Bpjair PJTA PJTB I = I(Vspeed) * {PJFULL} * V(PJTA, PJTB)",
      ".ends T_FAN_TH",
    ]);
  });
  it("is refused when the model cannot have the pins", () => {
    expect(() => thermalModel(SENSOR_MODEL.replace("Vtemp temp 0 dc 25", "Vtemp temp 2 dc 25"), "T_NTC", { temperature: "Vtemp" })).toThrow(/must stand on ground/);
    expect(() => thermalModel(SENSOR_MODEL, "T_NTC", { temperature: "Vnone" })).toThrow(/"Vnone" was not found/);
    expect(() => thermalModel(HEATER_MODEL, "T_HEATER", { heat: "Vheat" })).toThrow(/"vheat" was not found/);
    expect(() => thermalModel(FAN_MODEL.replace("T_FAN 1 2", "T_FAN 1 PJTA"), "T_FAN", { air: "Vspeed" })).toThrow(/has a pin "PJTA" of its own/);
    expect(() => thermalModel(HEATER_MODEL + "", "T_OTHER", { heat: "Vpower" })).toThrow(/no subcircuit "T_OTHER"/);
    expect(() => thermalModel(HEATER_MODEL, "T_HEATER", {})).toThrow(/no thermal pin/);
    expect(thermalFile("model.lib")).toBe("model.thermal.lib");
  });
});

describe("a circuit with heat", () => {
  const board = (): SchematicSymbol[] => [
    ...DRAWN,
    sym("R1", "Device:Heater", ["+12V", "GND"], "BOX"),
    sym("M1", "Motor:Fan", ["+12V", "fn"], "BOX OUTSIDE"),
    sym("TH1", "Device:Thermistor_NTC", ["+5V", "a0"], "box"),
    sym("TH2", "Device:Thermistor_NTC", ["+5V", "a1"]),
  ];

  it("has every thermal pin on the wire its symbol names, and nothing of ours for the box", () => {
    const run = build(board());
    expect(run.errors).toEqual([]);
    expect(run.deck).toEqual([
      ".title heat",
      '.include "/sim-library/fan/model.lib"',
      '.include "/sim-library/fan/model.thermal.lib"',
      '.include "/sim-library/heater/model.lib"',
      '.include "/sim-library/heater/model.thermal.lib"',
      '.include "/sim-library/sensor/model.lib"',
      '.include "/sim-library/sensor/model.thermal.lib"',
      "V1 /OUTSIDE GND DC 25",
      "R9 /OUTSIDE /BOX 4",
      "C1 /BOX GND 5",
      "XM1 +12V fn /BOX /OUTSIDE T_FAN_TH PJFULL=1",
      "XR1 +12V GND /BOX T_HEATER_TH",
      "XTH1 +5V a0 /BOX T_NTC_TH",
      "XTH2 +5V a1 T_NTC",
      "Vpj_supply_1 pj_supply_1 0 DC 5",
      "Rpj_supply_1 pj_supply_1 +5V 10m",
      "Vpj_supply_2 pj_supply_2 0 DC 12",
      "Rpj_supply_2 pj_supply_2 +12V 10m",
      ".end",
    ]);
    expect(run.wires).toEqual([
      { name: "BOX", node: "/BOX", heat: ["R1"], feel: ["TH1"], air: ["M1"] },
      { name: "OUTSIDE", node: "/OUTSIDE", heat: [], feel: [], air: ["M1"] },
    ]);
    expect(run.notOnWire).toEqual([]);
    expect(run.placed.map((p) => [p.ref, p.thermal])).toEqual([["M1", ["/BOX", "/OUTSIDE"]], ["R1", ["/BOX"]], ["TH1", ["/BOX"]], ["TH2", undefined]]);
  });

  it("takes the temperature of a sensor on a wire out of the user's hands, and shows the wire's", () => {
    const run = build(board(), DRAWN_LINES, true);
    expect(run.deck[run.deck.length - 2]).toBe(LIVE_TRAN);
    // TH1 has no temperature to set, TH2 keeps its own
    expect(run.inputs.map((i) => `${i.ref}.${i.input.name}`)).toEqual(["TH1.trim", "TH2.temperature", "TH2.trim"]);
    expect(run.signals.filter((s) => s.name === "wire")).toEqual([
      { ref: "R1", partId: "heater", name: "wire", vector: "v.xr1.vpjwire#branch" },
      { ref: "TH1", partId: "sensor", name: "wire", vector: "v.xth1.vpjwire#branch" },
    ]);
    const model = run.files.find((f) => f.path === "/sim-library/sensor/model.thermal.lib")?.text ?? "";
    expect(model).toContain("Vtemp temp PJTH dc 0");
    expect(model).toContain("Vtrim trim 0 dc 0 external");
    expect(run.files.find((f) => f.path === "/sim-library/sensor/model.lib")?.text).toContain("Vtemp temp 0 dc 0 external");
    expect(overlayOf(SENSOR, true)).toEqual([
      { widget: "slider", place: { below: "bbox" }, input: "trim" },
      { widget: "meter", place: { below: "bbox" }, signal: "wire", unit: "°C", prefix: false, decimals: 1 },
    ]);
    expect(overlayOf(SENSOR, false)).toEqual(SENSOR.overlay);
    expect(overlayOf(LAMP, true)).toEqual([]);
  });

  it("says a fan's cooling on its line, as its symbol sets it", () => {
    const fan = sym("M1", "Motor:Fan", ["+12V", "fn"], "OUTSIDE BOX");
    fan.fields["PCBJam.SimSettings"] = "cooling=2.5";
    const run = build([...DRAWN, fan]);
    expect(run.errors).toEqual([]);
    expect(run.deck).toContain("XM1 +12V fn /OUTSIDE /BOX T_FAN_TH PJFULL=2.5");
  });

  it("leaves a part as it is without wires, and says which symbols name wires for nothing", () => {
    const run = build([
      ...DRAWN.filter((s) => s.ref !== "R9"),
      sym("R1", "Device:Heater", ["+12V", "GND"], "OVEN"),
      sym("M1", "Motor:Fan", ["+12V", "fn"], "BOX"),
      sym("TH1", "Device:Thermistor_NTC", ["+5V", "a0"], "BOX OUTSIDE"),
      sym("LA1", "Device:Lamp", ["+12V", "GND"], "BOX"),
      sym("R9", "Device:R", ["/OUTSIDE", "/BOX"], "BOX"),
    ]);
    expect(run.errors).toEqual([]);
    expect(run.deck.filter((l) => /^X/.test(l))).toEqual(["XLA1 +12V GND T_LAMP", "XM1 +12V fn T_FAN", "XR1 +12V GND T_HEATER", "XTH1 +5V a0 T_NTC"]);
    expect(run.files.map((f) => f.path).filter((p) => p.includes("thermal"))).toEqual([]);
    expect(run.wires).toEqual([]);
    expect(run.inputs.map((i) => `${i.ref}.${i.input.name}`)).toEqual(["TH1.temperature", "TH1.trim"]);
    expect(run.notOnWire).toEqual([
      { ref: "LA1", said: "BOX", why: "part", title: "Lamp" },
      { ref: "M1", said: "BOX", why: "wires", title: "Fan", problem: { why: "count", needs: 2 } },
      { ref: "R1", said: "OVEN", why: "wires", title: "Heater", problem: { why: "no-wire", name: "OVEN" } },
      { ref: "R9", said: "BOX", why: "no-part" },
      { ref: "TH1", said: "BOX OUTSIDE", why: "wires", title: "Sensor", problem: { why: "count", needs: 1 } },
    ]);
  });
});
