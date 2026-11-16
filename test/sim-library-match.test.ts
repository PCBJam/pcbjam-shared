import { describe, expect, it } from "vitest";
import { FIELD_PART, matchSymbols, type IndexPart, type SchematicSymbol } from "../src/sim-library/index.js";
import { makeSnapshot } from "./sim-library-fixtures.js";

const { index } = makeSnapshot();

let n = 0;
const sym = (libId: string, value: string, pins: Record<string, string>, fields: Record<string, string> = {}): SchematicSymbol => ({
  ref: `X${++n}`, uuid: `uuid-${n}`, sheet: "/", libId, value, fields,
  pins: Object.fromEntries(Object.entries(pins).map(([number, name]) => [number, { name }])),
});
const one = (s: SchematicSymbol, opts?: Parameters<typeof matchSymbols>[2], idx: { parts: IndexPart[] } = index) => matchSymbols(idx, [s], opts)[0];
const part = (id: string, fits: IndexPart["fits"], pins = ["1", "2"]): IndexPart => ({ id, version: 1, title: id, description: "", fits, pins, code: false, files: [] });

// KiCad's stock symbols: the LED has pin 1 = K and pin 2 = A.
const LED = { "1": "K", "2": "A" };
const POT = { "1": "1", "2": "2", "3": "3" };

describe("rule 1: a field on the symbol names the part", () => {
  it("uses that part, also on a symbol the library does not know", () => {
    expect(one(sym("My:Knob", "whatever", POT, { [FIELD_PART]: "potentiometer" }))).toMatchObject({ status: "matched", rule: 1, partId: "potentiometer", pinMap: ["1", "2", "3"] });
  });
  it("beats the user's own model and the library's line", () => {
    expect(one(sym("Device:LED", "red", LED, { [FIELD_PART]: "push-button", "Sim.Library": "vendor.lib" }))).toMatchObject({ status: "matched", rule: 1, partId: "push-button" });
  });
  it("\"off\" switches the symbol's simulation off", () => {
    expect(one(sym("Device:LED", "red", LED, { [FIELD_PART]: "off" }))).toMatchObject({ status: "off", rule: 1 });
  });
  it("says so when the part does not exist or does not fit", () => {
    expect(one(sym("Device:LED", "red", LED, { [FIELD_PART]: "laser" }))).toMatchObject({ status: "error", reason: "the library has no part \"laser\"" });
    expect(one(sym("Device:LED", "red", LED, { [FIELD_PART]: "potentiometer" }))).toMatchObject({ status: "error", partId: "potentiometer", reason: "\"potentiometer\" does not fit this symbol: the symbol has no pin for 3" });
  });
});

describe("rule 2: the user's own SPICE model is kept", () => {
  it("wins over the library's line for the same symbol", () => {
    expect(one(sym("Device:LED", "red", LED, { "Sim.Library": "vendor.lib", "Sim.Name": "LTST" }))).toMatchObject({ status: "kicad", rule: 2, own: true });
  });
});

describe("rule 3: the library has a line for exactly this symbol", () => {
  it("matches by symbol, pins by number", () => {
    expect(one(sym("Device:R_Potentiometer", "10k", POT))).toMatchObject({ status: "matched", rule: 3, partId: "potentiometer", pinMap: ["1", "2", "3"], unusedPins: [] });
  });
  it("matches by symbol, pins by name", () => {
    expect(one(sym("Device:LED", "green", LED))).toMatchObject({ status: "matched", rule: 3, partId: "led", pinMap: ["2", "1"] });
  });
  it("passes on where the part's overlay sits on this symbol, when the line says so", () => {
    // two symbols draw the same digit at different heights: each line names its place
    const digit = part("digit", [{ symbol: "Display:Low", origin: [-0.25, -2.9] }, { symbol: "Display:High", origin: [-0.25, 0.25] }, { symbol: "Display:Plain" }]);
    const at = (libId: string, fields?: Record<string, string>) => one(sym(libId, "", { "1": "", "2": "" }, fields), undefined, { parts: [digit] });
    expect(at("Display:Low")).toMatchObject({ status: "matched", rule: 3, origin: [-0.25, -2.9] });
    expect(at("Display:High")).toMatchObject({ status: "matched", origin: [-0.25, 0.25] });
    expect(at("Display:Plain")).not.toHaveProperty("origin");
    // the same when the user named the part on the symbol
    expect(at("Display:High", { [FIELD_PART]: "digit" })).toMatchObject({ status: "matched", rule: 1, origin: [-0.25, 0.25] });
  });
  it("beats the line KiCad writes for a stock symbol", () => {
    const led = sym("Device:LED", "red", LED);
    expect(one(led, { kicadModels: new Set([led.ref]) })).toMatchObject({ status: "matched", partId: "led" });
  });
  it("prefers the more specific line: symbol plus value over symbol alone, exact over pattern", () => {
    const idx = { parts: [part("any-npn", [{ symbol: "Transistor_BJT:*" }]), part("q-npn", [{ symbol: "Transistor_BJT:Q_NPN_BCE" }]), part("bc547", [{ symbol: "Transistor_BJT:Q_NPN_*", value: "bc547*" }])] };
    const pins = { "1": "B", "2": "C" };
    expect(one(sym("Transistor_BJT:Q_NPN_BCE", "BC547B", pins), undefined, idx)).toMatchObject({ status: "matched", partId: "bc547" });
    expect(one(sym("Transistor_BJT:Q_NPN_BCE", "2N2222", pins), undefined, idx)).toMatchObject({ status: "matched", partId: "q-npn" });
    expect(one(sym("Transistor_BJT:Q_PNP_BCE", "2N2907", pins), undefined, idx)).toMatchObject({ status: "matched", partId: "any-npn" });
  });
  it("asks the user when two parts fit equally well", () => {
    const idx = { parts: [part("a", [{ symbol: "Device:Lamp" }]), part("b", [{ symbol: "Device:Lamp" }])] };
    expect(one(sym("Device:Lamp", "", { "1": "1", "2": "2" }), undefined, idx)).toMatchObject({ status: "choice", candidates: [{ partId: "a" }, { partId: "b" }] });
  });
  it("refuses a symbol whose pins do not line up", () => {
    expect(one(sym("Device:R_Potentiometer", "10k", { "1": "1", "2": "2" }))).toMatchObject({ status: "error", rule: 3, reason: "\"potentiometer\" does not fit this symbol: the symbol has no pin for 3" });
  });
});

describe("rule 4: only the value is known", () => {
  const idx = { parts: [part("demo-adc", [{ value: "ADC_Demo", pins: "name" }], ["VCC", "GND"])] };
  const custom = (): SchematicSymbol => sym("MyLib:Chip", "adc_demo", { "1": "VCC", "2": "GND" });
  it("suggests the part and does not use it", () => {
    expect(one(custom(), undefined, idx)).toMatchObject({ status: "suggested", rule: 4, candidates: [{ partId: "demo-adc", fits: true }] });
  });
  it("uses it once the user said yes", () => {
    const s = custom();
    expect(one(s, { overrides: { [s.uuid]: "demo-adc" } }, idx)).toMatchObject({ status: "matched", rule: 1, partId: "demo-adc", pinMap: ["1", "2"] });
  });
  it("says when the suggested part would not fit", () => {
    expect(one(sym("MyLib:Chip", "ADC_Demo", { "1": "VDD", "2": "GND" }), undefined, idx)).toMatchObject({ status: "suggested", candidates: [{ partId: "demo-adc", fits: false, reason: "the symbol has no pin for VCC" }] });
  });
});

describe("rule 5: nothing fits", () => {
  it("leaves the symbol to KiCad when KiCad has a model for it", () => {
    const r = sym("Device:R", "10k", { "1": "~", "2": "~" });
    expect(one(r, { kicadModels: new Set([r.ref]) })).toMatchObject({ status: "kicad", rule: 5, own: false });
  });
  it("does not simulate it otherwise", () => {
    expect(one(sym("Connector:Conn_01x02", "J", { "1": "Pin_1", "2": "Pin_2" }))).toMatchObject({ status: "none", rule: 5 });
  });
});
