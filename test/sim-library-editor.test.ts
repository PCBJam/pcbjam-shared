import { describe, expect, it } from "vitest";
import { matchSymbols, readEditorSymbols } from "../src/sim-library/index.js";
import { makeSnapshot } from "./sim-library-fixtures.js";

// What the editor's binding kicadSimSymbols really returned (KiCad 10.0.7 as WebAssembly,
// 2026-11-13) for the two-file project of pcbjam's tests/kicad/sim-symbols-eeschema.spec.ts:
//
//   root:  +5V - R1 - [~{CS}] - R2 - (no name) - R3 - open     U1 (two units), nothing wired
//   cell:  [MID] - RK - GND                                     the sheet is used twice
//
// R1 carries PCBJam.SimPart = off, R2's Value is ${Rating}, R3 is excluded from simulation.
const ANSWER = JSON.stringify({
  symbols: [
    { fields: { Value: "DUAL" }, libId: "Test:DUAL", pins: { "1": { name: "A", node: "unconnected-_U1A-A-Pad1_" }, "2": { name: "B", node: "unconnected-_U1A-B-Pad2_" }, "3": { name: "C", node: "unconnected-_U1B-C-Pad3_" }, "4": { name: "D", node: "unconnected-_U1B-D-Pad4_" } }, ref: "U1", sheet: "/", sheetPath: "/", uuid: "aaaaaaaa-0000-0000-0000-000000000004", value: "DUAL" },
    { fields: { "PCBJam.SimPart": "off", Value: "10k" }, libId: "Device:R", pins: { "1": { name: "", node: "+5V" }, "2": { name: "", node: "/_CS" } }, ref: "R1", sheet: "/", sheetPath: "/", uuid: "aaaaaaaa-0000-0000-0000-000000000001", value: "10k" },
    { fields: { Rating: "39", Value: "39" }, libId: "Device:R", pins: { "1": { name: "", node: "/_CS" }, "2": { name: "", node: "Net-_R2-Pad2_" } }, ref: "R2", sheet: "/", sheetPath: "/", uuid: "aaaaaaaa-0000-0000-0000-000000000002", value: "39" },
    { excluded: true, fields: { Value: "1k" }, libId: "Device:R", pins: { "1": { name: "", node: "Net-_R2-Pad2_" }, "2": { name: "", node: "unconnected-_R3-Pad2_" } }, ref: "R3", sheet: "/", sheetPath: "/", uuid: "aaaaaaaa-0000-0000-0000-000000000003", value: "1k" },
    { fields: { Value: "330" }, libId: "Device:R", pins: { "1": { name: "", node: "/Key_1/MID" }, "2": { name: "", node: "GND" } }, ref: "R11", sheet: "/Key 1/", sheetPath: "/33333333-0000-0000-0000-000000000001/", uuid: "aaaaaaaa-0000-0000-0000-000000000006", value: "330" },
    { fields: { Value: "330" }, libId: "Device:R", pins: { "1": { name: "", node: "/Key_2/MID" }, "2": { name: "", node: "GND" } }, ref: "R12", sheet: "/Key 2/", sheetPath: "/33333333-0000-0000-0000-000000000002/", uuid: "aaaaaaaa-0000-0000-0000-000000000006", value: "330" },
  ],
});

describe("reading the editor's answer", () => {
  it("gives the symbols that are simulated, and the excluded ones apart", () => {
    const { symbols, excluded } = readEditorSymbols(ANSWER);
    expect(symbols.map((s) => s.ref)).toEqual(["U1", "R1", "R2", "R11", "R12"]);
    expect(excluded.map((s) => s.ref)).toEqual(["R3"]);
    expect(symbols.find((s) => s.ref === "R2")).toEqual({
      ref: "R2", uuid: "aaaaaaaa-0000-0000-0000-000000000002", sheet: "/", sheetPath: "/", libId: "Device:R", value: "39",
      fields: { Rating: "39", Value: "39" },
      pins: { "1": { name: "", node: "/_CS" }, "2": { name: "", node: "Net-_R2-Pad2_" } },
    });
  });

  it("keeps the two uses of one sheet apart", () => {
    const { symbols } = readEditorSymbols(ANSWER);
    const [a, b] = symbols.filter((s) => s.uuid === "aaaaaaaa-0000-0000-0000-000000000006");
    expect([a?.ref, a?.sheet, a?.pins["1"]?.node]).toEqual(["R11", "/Key 1/", "/Key_1/MID"]);
    expect([b?.ref, b?.sheet, b?.pins["1"]?.node]).toEqual(["R12", "/Key 2/", "/Key_2/MID"]);
    expect(a?.sheetPath).not.toBe(b?.sheetPath);
  });

  it("takes the parsed value as well as the text", () => {
    expect(readEditorSymbols(JSON.parse(ANSWER))).toEqual(readEditorSymbols(ANSWER));
  });

  it("a pin without a net has no node", () => {
    const { symbols } = readEditorSymbols({ symbols: [{ ref: "J1", uuid: "u", sheet: "/", sheetPath: "/", libId: "X:J", value: "J", fields: {}, pins: { "1": { name: "A" }, "2": { name: "B", node: "" } } }] });
    expect(symbols[0]?.pins).toEqual({ "1": { name: "A" }, "2": { name: "B" } });
  });

  it("is what the matcher takes", () => {
    const { symbols } = readEditorSymbols(ANSWER);
    const matches = matchSymbols(makeSnapshot().index, symbols);
    expect(matches.find((m) => m.ref === "R1")).toMatchObject({ status: "off", rule: 1 });
    expect(matches.find((m) => m.ref === "R11")).toMatchObject({ status: "none", sheet: "/Key 1/" });
    expect(matches).toHaveLength(5);
  });

  it("says in plain words what is wrong with an answer", () => {
    expect(() => readEditorSymbols("{\"error\":\"no schematic frame\"}")).toThrow("the schematic could not be read: no schematic frame");
    expect(() => readEditorSymbols("[]")).toThrow("it is not an object");
    expect(() => readEditorSymbols("not json")).toThrow("it is not JSON");
    expect(() => readEditorSymbols({})).toThrow("it has no list of symbols");
    expect(() => readEditorSymbols({ symbols: [{ ref: "R1" }] })).toThrow("symbol 0 has no fields");
    expect(() => readEditorSymbols({ symbols: [{ ref: "R1", fields: {}, pins: { "1": {} } }] })).toThrow("symbol 0 has a pin 1 without a name");
    expect(() => readEditorSymbols({ symbols: [{ ref: "R1", fields: {}, pins: {} }] })).toThrow("symbol 0 has no \"uuid\"");
  });
});
