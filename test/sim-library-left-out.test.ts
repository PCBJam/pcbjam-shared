// What a live run leaves out, and why (src/sim-library/left-out.ts).
import { describe, expect, it } from "vitest";
import {
  NOTHING_TO_SIMULATE, buildDeck, hasNothingToSimulate, isPassiveRef, isProtectionDiode, kicadModels, leftOutBy, leftOutGroup, leftOutName, leftOutNotice, leftOutRemark, leftOutSentence,
  leftOutWords, matchSymbols, readEditorNetlist, symbolsNamed,
  type IndexPart, type LeftOut, type SchematicSymbol,
} from "../src/sim-library/index.js";

const two = (a: string, b: string) => ({ "1": { name: "", node: a }, "2": { name: "", node: b } });
const sym = (ref: string, libId: string, value: string, fields: Record<string, string> = {}, pins: SchematicSymbol["pins"] = two("+5V", "GND")): SchematicSymbol =>
  ({ ref, uuid: `uuid-${ref}`, libId, value, sheet: "/", fields: { Value: value, ...fields }, pins });

// A board as people draw one: a chip the library does not have, a resistor without its
// value, a LED the library offers by its value only, mounting holes, a pin header, a test
// point, a speaker and a varistor that KiCad takes for a coil and a resistor, a part
// switched off with our field (with and without a model of KiCad's behind it), a part whose
// model is switched off in KiCad, and a part excluded from simulation.
const SYMBOLS = [
  sym("R1", "Device:R", "330"),
  sym("R2", "Device:R", "R"),
  sym("C1", "Device:C", "C"),
  sym("L1", "Device:L", "L"),
  sym("R?", "Device:R_Small", "R_Small"),
  sym("U1", "MCU_Microchip_ATmega:ATmega328P-A", "ATmega328P-A", {}, { "7": { name: "VCC", node: "+5V" }, "8": { name: "GND", node: "GND" } }),
  sym("D1", "MyLib:LED_0603", "red"),
  sym("H1", "Mechanical:MountingHole", "MountingHole", {}, {}),
  sym("H2", "Mechanical:MountingHole_Pad", "MountingHole_Pad", {}, { "1": { name: "1", node: "GND" } }),
  sym("J1", "Connector_Generic:Conn_01x04", "Conn_01x04", {}, { "1": { name: "Pin_1", node: "+5V" }, "2": { name: "Pin_2", node: "GND" } }),
  sym("TP1", "Connector:TestPoint", "TestPoint", {}, { "1": { name: "1", node: "+5V" } }),
  sym("J2", "Connector:Barrel_Jack", "Barrel_Jack"),
  sym("LS1", "Device:Speaker", "Speaker"),
  sym("RV1", "Device:Varistor", "Varistor"),
  sym("R5", "Device:R", "1k", { "PCBJam.SimPart": "off" }),
  sym("Q1", "Device:Q_NPN", "BC547", { "PCBJam.SimPart": "off" }),
  sym("R6", "Device:R", "2k", { "Sim.Enable": "0" }),
];
const EXCLUDED = [sym("R9", "Device:R", "10k")];

const netlist = readEditorNetlist({
  ok: true, messages: [],
  items: [
    ...["R1", "R2", "R?", "RV1", "R5"].map((ref) => ({ device: "R", name: ref, ref, type: "" })),
    { device: "C", name: "C1", ref: "C1", type: "" },
    ...["L1", "LS1"].map((ref) => ({ device: "L", name: ref, ref, type: "" })),
    ...["U1", "D1", "H2", "J1", "TP1", "J2", "Q1"].map((ref) => ({ device: "", name: ref, ref, type: "" })),
    { device: "R", name: "R6", ref: "R6", type: "", off: true },
  ],
  lines: [
    { text: ".title KiCad schematic" },
    ...SYMBOLS.filter((s) => /^(R|C|L)/.test(s.ref) && s.ref !== "R6").map((s) => ({ kind: "item", ref: s.ref, text: `${s.ref} +5V GND ${s.value}` })),
    { text: ".end" },
  ],
});

// The library knows a LED by its value only: a suggestion, not used until it is confirmed.
const LED: IndexPart = { id: "led", version: 1, title: "LED", description: "", fits: [{ value: "red" }], pins: ["1", "2"], code: false, files: [] };

function leftOut(): LeftOut[] {
  const plan = matchSymbols({ parts: [LED] }, SYMBOLS, { kicadModels: kicadModels(netlist, SYMBOLS) });
  const run = buildDeck({ symbols: SYMBOLS, excluded: EXCLUDED, netlist, plan, parts: new Map(), live: false });
  expect(run.errors).toEqual([]);
  return run.leftOut;
}
const said = (list: LeftOut[]): string[] => list.map((s) => `${s.ref}: ${s.reason}${s.off ? ` (${s.off}${s.instead ? `, ${s.instead} instead` : ""})` : ""}`);

describe("the symbols a run leaves out", () => {
  it("have one reason each", () => {
    expect(said(leftOut())).toEqual([
      "C1: no-value",
      "D1: no-part",
      "H1: nothing",
      "H2: nothing",
      "J1: nothing",
      "J2: no-part",
      "L1: no-value",
      "LS1: no-part",
      "Q1: off (field)",
      "R?: no-value",
      "R2: no-value",
      "R5: off (field, kicad instead)",
      "R6: off (model)",
      "R9: off (excluded)",
      "RV1: no-part",
      "TP1: nothing",
      "U1: no-part",
    ]);
  });

  it("do not hold what runs: R1 runs with KiCad's model", () => {
    expect(leftOut().some((s) => s.ref === "R1")).toBe(false);
  });

  it("say no value for a resistor, a capacitor or a coil only", () => {
    // KiCad takes the speaker LS1 for a coil and the varistor RV1 for a resistor: a value would not mend them
    expect(["R1", "R12", "C3", "L1", "R?"].map(isPassiveRef)).toEqual([true, true, true, true, true]);
    expect(["RV1", "LS1", "CB1", "RN1", "U1", "D1", "FB1"].map(isPassiveRef)).toEqual([false, false, false, false, false, false, false]);
  });

  it("say no value for a resistor whose Value is empty: KiCad writes a placeholder for it, as for a chip", () => {
    const three = { ...two("+5V", "GND"), "3": { name: "", node: "/W" } };
    const symbols = [sym("R3", "Device:R_US", ""), sym("R4", "Device:R_Potentiometer", "", {}, three), sym("U2", "Timer:NE555", "")];
    const lines = readEditorNetlist({
      ok: true, messages: [],
      items: symbols.map((s) => ({ device: "", name: s.ref, ref: s.ref, type: "" })),
      lines: [{ text: ".title KiCad schematic" }, ...symbols.map((s) => ({ kind: "item" as const, ref: s.ref, text: `${s.ref} __${s.ref}` })), { text: ".end" }],
    });
    const plan = matchSymbols({ parts: [] }, symbols, { kicadModels: kicadModels(lines, symbols) });
    const run = buildDeck({ symbols, excluded: [], netlist: lines, plan, parts: new Map(), live: false });
    // a symbol with three pins is no resistor a value would mend
    expect(said(run.leftOut)).toEqual(["R3: no-value", "R4: no-part", "U2: no-part"]);
    expect(leftOutNotice(run.leftOut)).toBe("1 symbol has no value (R3): type its value and it runs. 2 symbols have no part in the library: R4 (R_Potentiometer), U2 (NE555). The rest of the circuit runs.");
  });

  it("carry what the library says about a symbol it cannot run as it is", () => {
    const d1 = leftOut().find((s) => s.ref === "D1");
    expect(d1?.library).toBe("the library offers LED for this value, not used until it is confirmed");
    expect(leftOut().find((s) => s.ref === "U1")?.library).toBeUndefined();
  });

  it("are the same symbols the run does not simulate, and more", () => {
    const plan = matchSymbols({ parts: [LED] }, SYMBOLS, { kicadModels: kicadModels(netlist, SYMBOLS) });
    const run = buildDeck({ symbols: SYMBOLS, excluded: EXCLUDED, netlist, plan, parts: new Map(), live: false });
    const refs = new Set(run.leftOut.map((s) => s.ref));
    for (const ref of run.notSimulated) expect(refs.has(ref), ref).toBe(true);
  });
});

describe("nothing to simulate", () => {
  it("is a short list of named symbols and families, never a whole library", () => {
    for (const pattern of NOTHING_TO_SIMULATE) {
      const [library, name] = pattern.split(":");
      expect(library, pattern).toMatch(/^[A-Za-z_]+$/);
      // a name, or the start of a family's name: never "anything of this library"
      expect((name ?? "").replace(/\*$/, "").length, pattern).toBeGreaterThanOrEqual(4);
      expect((name ?? "").indexOf("*"), pattern).not.toBe(0);
    }
  });

  it("holds mounting holes, pin headers and test points", () => {
    for (const id of [
      "Mechanical:MountingHole", "Mechanical:MountingHole_Pad", "Mechanical:Fiducial", "Connector:TestPoint", "Connector:TestPoint_Probe",
      "Connector_Generic:Conn_01x04", "Connector_Generic:Conn_02x20_Odd_Even", "Connector:Conn_01x02_Pin", "Graphic:Logo_Open_Hardware_Small",
    ]) expect(hasNothingToSimulate(id), id).toBe(true);
  });

  it("holds a board's own copy of one of them: the name decides, not the library", () => {
    for (const id of [
      "RobotProtos:MountingHole", "RobotProtos:Conn_01x04_MountingPin", "MyBoard:Conn_01x04_Male", "my-lib:Conn_02x05_Odd_Even", "MyBoard:TestPoint",
      "MyBoard:Fiducial", ":Logo_2", "Logo_Open_Hardware_Small", "Connector_Generic_Shielded:Conn_01x04_Shielded",
    ]) expect(hasNothingToSimulate(id), id).toBe(true);
    // only the exact names: what somebody named in their own way is not known here
    for (const id of ["MyBoard:Logo", "MyBoard:CONN_2", "MyBoard:Header_4", "MyBoard:Hole", "MyBoard:Conn", "MyBoard:conn_01x04", "MyBoard:Barrel_Jack", "MyBoard:LED", "MyBoard:USB_C_Receptacle",
      "MyBoard:Conn_01x04_LoadSwitch", "MyBoard:Conn_01x02_Power", "MyBoard:Conn_02x05_JTAG_Buffer"])
      expect(hasNothingToSimulate(id), id).toBe(false);
  });

  it("says so of such a copy that nothing runs, and counts it without naming it", () => {
    const symbols = [
      sym("R1", "Device:R", "330"),
      sym("H1", "MyBoard:MountingHole", "MountingHole", {}, {}),
      sym("J1", "MyBoard:Conn_01x04_MountingPin", "DEBUG", {}, { "1": { name: "Pin_1", node: "+5V" }, "2": { name: "Pin_2", node: "GND" } }),
      sym("J2", "MyBoard:CONN_2", "CONN_2"),
    ];
    const kicad = readEditorNetlist({
      ok: true, messages: [],
      items: [{ device: "R", name: "R1", ref: "R1", type: "" }, ...["J1", "J2"].map((ref) => ({ device: "", name: ref, ref, type: "" }))],
      lines: [{ text: ".title KiCad schematic" }, { kind: "item", ref: "R1", text: "R1 +5V GND 330" }, { kind: "item", ref: "J1", text: "J1 __J1" }, { kind: "item", ref: "J2", text: "J2 __J2" }, { text: ".end" }],
    });
    const plan = matchSymbols({ parts: [] }, symbols, { kicadModels: kicadModels(kicad, symbols) });
    const run = buildDeck({ symbols, netlist: kicad, plan, parts: new Map(), live: false });
    expect(said(run.leftOut)).toEqual(["H1: nothing", "J1: nothing", "J2: no-part"]);
    expect(leftOutNotice(run.leftOut)).toBe("1 symbol has no part in the library: J2 (CONN_2). 2 symbols have nothing to simulate. The rest of the circuit runs.");
  });

  it("does not hold what can do something on a board", () => {
    for (const id of [
      "Connector:Barrel_Jack", "Connector:USB_C_Receptacle", "Connector:Screw_Terminal_01x02", "Device:R", "Device:Crystal", "Jumper:SolderJumper_2_Bridged",
      "Switch:SW_Push", "MCU_Microchip_ATmega:ATmega328P-A", "Mechanical:DIN_Rail_Adapter",
    ]) expect(hasNothingToSimulate(id), id).toBe(false);
  });

  it("holds antennas and RF shields, and protection diodes", () => {
    for (const id of [
      "Device:Antenna", "Device:Antenna_Chip", "Device:Antenna_Dipole", "Device:Antenna_Loop", "Device:Antenna_Shield", "Device:RFShield_OnePiece", "Device:RFShield_TwoPieces",
      "Device:D_TVS", "Device:D_TVS_Filled", "Device:D_TVS_Small", "Device:D_TVS_Small_Filled", "Device:D_TVS_Dual_AAC", "Device:D_TVS_Dual_ACA", "Device:D_TVS_Dual_CAA",
      // a board's own copy
      "RobotProtos:D_TVS_Filled", "MyBoard:Antenna", "MyBoard:D_TVS",
    ]) expect(hasNothingToSimulate(id), id).toBe(true);
    // only the exact names, and no diode or protection chip that is something else
    for (const id of [
      "MyBoard:AntennaSwitch", "MyBoard:Antenna_Tuner", "MyBoard:D_TVS_Array_4", "MyBoard:D_TVS_5V", "Device:D", "Device:D_Zener", "Device:D_Schottky", "Device:LED",
      "Device:Varistor", "Device:SparkGap", "Power_Protection:USBLC6-2SC6", "Power_Protection:TPD3E001DRLR", "Diode:SMAJ5.0A",
    ]) expect(hasNothingToSimulate(id), id).toBe(false);
  });

  it("knows which of them are protection diodes, by the name in any library", () => {
    expect(["Device:D_TVS", "Device:D_TVS_Small_Filled", "Device:D_TVS_Dual_CAA", "RobotProtos:D_TVS_Filled", "D_TVS_Small"].map(isProtectionDiode)).toEqual([true, true, true, true, true]);
    expect(["Device:Antenna", "Mechanical:MountingHole", "Device:D_Zener", "MyBoard:D_TVS_Array_4", "Device:D_TVS_Dual"].map(isProtectionDiode)).toEqual([false, false, false, false, false]);
    // every one of them is on the list, so none is ever "no part"
    for (const id of NOTHING_TO_SIMULATE.filter(isProtectionDiode)) expect(hasNothingToSimulate(id), id).toBe(true);
    expect(NOTHING_TO_SIMULATE.filter(isProtectionDiode)).toHaveLength(7);
  });

  it("says of a protection diode what leaving it out means, and keeps it out of the notice", () => {
    const symbols = [
      sym("R1", "Device:R", "330"),
      sym("D1", "Device:D_TVS", "SMBJ12CA"),
      sym("D2", "RobotProtos:D_TVS_Filled", "D_TVS_Filled"),
      sym("AE1", "Device:Antenna", "Antenna", {}, { "1": { name: "A", node: "/RF" } }),
      sym("H1", "Mechanical:MountingHole", "MountingHole", {}, {}),
    ];
    const kicad = readEditorNetlist({
      ok: true, messages: [],
      items: [{ device: "R", name: "R1", ref: "R1", type: "" }, ...["D1", "D2", "AE1"].map((ref) => ({ device: "", name: ref, ref, type: "" }))],
      lines: [{ text: ".title KiCad schematic" }, { kind: "item", ref: "R1", text: "R1 +5V GND 330" }, ...["D1", "D2", "AE1"].map((ref) => ({ kind: "item", ref, text: `${ref} __${ref}` })), { text: ".end" }],
    });
    const plan = matchSymbols({ parts: [] }, symbols, { kicadModels: kicadModels(kicad, symbols) });
    const run = buildDeck({ symbols, netlist: kicad, plan, parts: new Map(), live: false });
    expect(run.errors).toEqual([]);
    expect(said(run.leftOut).sort()).toEqual(["AE1: nothing", "D1: nothing", "D2: nothing", "H1: nothing"]);
    // a board with protection diodes and an antenna runs as it should: nothing to tell
    expect(leftOutNotice(run.leftOut)).toBeNull();
    const of = (ref: string): LeftOut => run.leftOut.find((s) => s.ref === ref) as LeftOut;
    expect(leftOutSentence(of("D1"))).toBe("D1 (SMBJ12CA) is a protection diode. It acts only on a voltage spike, and it is not simulated: a spike it would cut off stays in the run.");
    expect(leftOutSentence(of("D2"))).toBe("D2 (D_TVS_Filled) is a protection diode. It acts only on a voltage spike, and it is not simulated: a spike it would cut off stays in the run.");
    expect(leftOutSentence(of("AE1"))).toBe("AE1 (Antenna) has nothing to simulate.");
    // the list's words for the group name the diodes only when there are some
    expect(leftOutGroup("nothing", run.leftOut).todo).toBe("Mounting holes, pin headers, test points: they do nothing in a circuit. Protection diodes (TVS) act only on a voltage spike and are not simulated. Nothing to do.");
    expect(leftOutGroup("nothing", [of("AE1"), of("H1")]).todo).toBe("Mounting holes, pin headers, test points: they do nothing in a circuit. Nothing to do.");
    expect(leftOutGroup("nothing").todo).toBe("Mounting holes, pin headers, test points: they do nothing in a circuit. Nothing to do.");
    // the diodes' wires are not left without a path: each net of a left-out symbol is tied
    expect(run.deck.filter((l) => l.startsWith("Rpj_left_")).length).toBeGreaterThan(0);
  });

  it("is not said of a symbol that runs: a header with a part of the library is that part", () => {
    const header: IndexPart = { id: "supply-header", version: 1, title: "Supply header", description: "", fits: [{ symbol: "Connector_Generic:Conn_01x04" }], pins: ["1", "2"], code: false, files: [] };
    const plan = matchSymbols({ parts: [header] }, SYMBOLS, { kicadModels: kicadModels(netlist, SYMBOLS) });
    expect(plan.find((m) => m.ref === "J1")?.status).toBe("matched");
  });
});

describe("the words", () => {
  const one = (ref: string): LeftOut => leftOut().find((s) => s.ref === ref) as LeftOut;

  it("are one sentence for a symbol, with what to do", () => {
    expect(leftOutSentence(one("R2"))).toBe("R2 has no value. Type one (10k) and it runs.");
    expect(leftOutSentence(one("C1"))).toBe("C1 has no value. Type one (100n) and it runs.");
    expect(leftOutSentence(one("L1"))).toBe("L1 has no value. Type one (10u) and it runs.");
    expect(leftOutSentence(one("U1"))).toBe("U1 (ATmega328P-A) is not simulated: the library has no part for it. The rest runs without it.");
    expect(leftOutSentence(one("D1"))).toBe("D1 (red) is not simulated: the library offers LED for this value, not used until it is confirmed.");
    expect(leftOutSentence(one("H1"))).toBe("H1 (MountingHole) has nothing to simulate.");
    expect(leftOutSentence(one("R5"))).toBe("R5 is switched off on its symbol (PCBJam.SimPart: off). KiCad's own model runs in its place.");
    expect(leftOutSentence(one("Q1"))).toBe("Q1 is switched off on its symbol (PCBJam.SimPart: off). Nothing runs in its place.");
    expect(leftOutSentence(one("R6"))).toBe("R6 is left out: its simulation model is switched off in KiCad.");
    expect(leftOutSentence(one("R9"))).toBe("R9 is excluded from simulation in KiCad, on the symbol or on its sheet.");
  });

  it("say the counts in the notice, the missing values first, and only count what has nothing to simulate", () => {
    expect(leftOutNotice(leftOut())).toBe(
      "4 symbols have no value (C1, L1, R?, R2): type their values and they run. "
      + "5 symbols have no part in the library: D1 (red), J2 (Barrel_Jack), LS1 (Speaker), RV1 (Varistor), U1 (ATmega328P-A). "
      + "4 symbols are switched off: Q1, R5, R6, R9. "
      + "4 symbols have nothing to simulate. "
      + "The rest of the circuit runs.",
    );
  });

  it("say one symbol as its own sentence, and nothing for a run that leaves nothing out", () => {
    expect(leftOutNotice([one("R2")])).toBe("R2 has no value. Type one (10k) and it runs.");
    expect(leftOutNotice([one("U1")])).toBe("U1 (ATmega328P-A) is not simulated: the library has no part for it. The rest runs without it.");
    expect(leftOutNotice([one("U1"), one("H1"), one("R2"), one("R9")])).toBe(
      "1 symbol has no value (R2): type its value and it runs. 1 symbol has no part in the library: U1 (ATmega328P-A). "
      + "1 symbol is switched off: R9. 1 symbol has nothing to simulate. The rest of the circuit runs.",
    );
    expect(leftOutNotice([])).toBeNull();
  });

  it("say nothing in the notice when all that is left out was switched off or has nothing to simulate", () => {
    // a board with mounting holes and a part somebody excluded runs as it should
    expect(leftOutNotice([one("H1"), one("H2"), one("J1"), one("R9"), one("R5")])).toBeNull();
    expect(leftOutNotice([one("H1")])).toBeNull();
    // with one symbol that matters, the others are counted with it
    expect(leftOutNotice([one("H1"), one("R2")])).toBe("1 symbol has no value (R2): type its value and it runs. 1 symbol has nothing to simulate. The rest of the circuit runs.");
  });

  it("name at most six symbols of a reason and count the rest", () => {
    const many = Array.from({ length: 9 }, (_, i): LeftOut => ({ ...one("R2"), ref: `R${i + 1}` }));
    expect(leftOutNotice(many)).toBe("9 symbols have no value (R1, R2, R3, R4, R5, R6 and 3 more): type their values and they run. The rest of the circuit runs.");
  });

  it("are two words on a mark of the sheet", () => {
    expect((["no-value", "no-part", "nothing", "off"] as const).map(leftOutWords)).toEqual(["no value", "no part", "nothing to simulate", "switched off"]);
  });

  it("have a title and what to do for every group of a list", () => {
    expect(leftOutBy(leftOut(), "nothing").map((s) => s.ref)).toEqual(["H1", "H2", "J1", "TP1"]);
    expect(leftOutGroup("no-value").title).toBe("No value");
    expect(leftOutGroup("no-part").title).toBe("No part");
    expect(leftOutGroup("nothing").title).toBe("Nothing to simulate");
    expect(leftOutGroup("off").title).toBe("Switched off");
    for (const reason of ["no-value", "no-part", "nothing", "off"] as const) expect(leftOutGroup(reason).todo.length, reason).toBeGreaterThan(20);
  });

  it("name a symbol in a list, with a remark where the group's words do not cover it", () => {
    expect(["R2", "U1", "H1", "R?", "R5", "R9"].map((ref) => leftOutName(one(ref)))).toEqual(["R2", "U1 (ATmega328P-A)", "H1 (MountingHole)", "R?", "R5", "R9"]);
    expect(["R2", "U1", "H1"].map((ref) => leftOutRemark(one(ref)))).toEqual([null, null, null]);
    expect(leftOutRemark(one("D1"))).toBe("the library offers LED for this value, not used until it is confirmed");
    expect(leftOutRemark(one("R5"))).toBe("switched off on its symbol (PCBJam.SimPart: off); KiCad's own model runs in its place");
    expect(leftOutRemark(one("Q1"))).toBe("switched off on its symbol (PCBJam.SimPart: off); nothing runs in its place");
    expect(leftOutRemark(one("R6"))).toBe("its simulation model is switched off in KiCad");
    expect(leftOutRemark(one("R9"))).toBe("excluded from simulation in KiCad, on the symbol or on its sheet");
  });
});

// A simulator says why it does not run a circuit by a line or an element of the netlist. The
// netlist step knows which symbol each line belongs to.
describe("the symbols a simulator's words are about", () => {
  const PART: IndexPart = { id: "regulator", version: 1, title: "Regulator", description: "", fits: [{ symbol: "Regulator_Linear:L7805" }], pins: ["1", "2", "3"], code: false, files: [] };
  const three = { "1": { name: "IN", node: "+9V" }, "2": { name: "GND", node: "GND" }, "3": { name: "OUT", node: "+5V" } };
  const symbols = [sym("R1", "Device:R", "330"), sym("Q1", "Device:Q_NPN", "BC547", { "Sim.Device": "NPN" }), sym("U2", "Regulator_Linear:L7805", "L7805", {}, three)];
  const kicad = readEditorNetlist({
    ok: true, messages: [],
    items: [{ device: "R", name: "R1", ref: "R1", type: "" }, { device: "NPN", name: "Q1", ref: "Q1", type: "" }, { device: "SUBCKT", name: "XU2", ref: "U2", type: "" }],
    lines: [
      { text: ".title KiCad schematic" },
      { kind: "item", ref: "R1", text: "R1 +5V GND 330" },
      { kind: "item", ref: "Q1", text: "Q1 +5V GND GND BC547" },
      { kind: "item", ref: "U2", text: "XU2 +9V GND +5V L7805" },
      { text: ".end" },
    ],
  });
  const manifest = {
    format: 1, id: "regulator", version: 1, title: "Regulator", description: "", fits: PART.fits, pins: ["1", "2", "3"],
    analog: { file: "model.lib", subckt: "REG", method: "trap" },
  } as const;
  const run = () => {
    const plan = matchSymbols({ parts: [PART] }, symbols, { kicadModels: kicadModels(kicad, symbols) });
    return buildDeck({
      symbols, netlist: kicad, plan, live: false,
      parts: new Map([["regulator", { id: "regulator", manifest: manifest as never, analog: ".subckt REG 1 2 3\nR1 1 3 1\n.ends REG\n", logic: null }]]),
    });
  };

  it("are known by the names of their lines: KiCad's own and the ones written for the library's parts", () => {
    const { marks, errors, placed } = run();
    expect(errors).toEqual([]);
    expect(placed.map((p) => p.name)).toEqual(["XU2"]);
    expect([...marks].sort()).toEqual([["q1", "Q1"], ["r1", "R1"], ["xu2", "U2"]]);
  });

  it("are found in the line ngspice repeats, in an element and in a node inside a part", () => {
    const { marks } = run();
    expect(symbolsNamed("ngspice did not run the circuit: Error on line 4 or its substitute: / q1 +5v gnd gnd bc547 / could not find a valid modelname", marks)).toEqual(["Q1"]);
    expect(symbolsNamed("ngspice did not run the circuit: Error: unknown subckt: xu2 +9v gnd +5v reg / in line no. 3 from file circbyline", marks)).toEqual(["U2"]);
    expect(symbolsNamed("Warning: singular matrix:  check node xu2.n3", marks)).toEqual(["U2"]);
    expect(symbolsNamed('doAnalyses: TRAN:  Timestep too small; time = 1e-09, timestep = 1e-21: trouble with xu2.d1-instance d.xu2.d1', marks)).toEqual(["U2"]);
    expect(symbolsNamed("vector v.xu2.vsense#branch and r1: both", marks)).toEqual(["U2", "R1"]);
  });

  it("are none when the words name no line: a net is not a symbol", () => {
    const { marks } = run();
    expect(symbolsNamed("ngspice did not run the circuit (see the log)", marks)).toEqual([]);
    expect(symbolsNamed('Timestep too small: trouble with node "net-_r1-pad2_"', marks)).toEqual([]);
    expect(symbolsNamed("the circuit did not reach its first time point in 45 s", marks)).toEqual([]);
  });
});
