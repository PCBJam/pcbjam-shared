import { describe, expect, it } from "vitest";
import {
  CODE_MODEL_LINE_MAX, LEFT_OUT_TIE, LIVE_TRAN, buildDeck, kicadModels, matchSymbols, openLibrary, prepareRun, readEditorNetlist, readEditorSymbols,
  unusableLines,
  type EditorNetlist, type LoadedPart, type PartManifest, type SchematicSymbol,
} from "../src/sim-library/index.js";
import { BUTTON, BUTTON_MODEL, LED, LED_MODEL, POT, POT_MODEL, makeSnapshot, serve } from "./sim-library-fixtures.js";

// What the editor's two reads really returned (KiCad 10.0.7 as WebAssembly, 2026-11-13) for
// the netlist project of pcbjam's tests/kicad/sim-symbols-eeschema.spec.ts:
//
//   root:  +5V - R1 - [~{CS}] - R2 - (net A) - R3 (excluded)     U1 (two units), nothing wired
//          net A - D1 (own parameters) - GND
//          net A - D2 (Value "red", no model) - GND
//          net A - D3 (a model from models.lib) - GND
//          texts: ".param gain=2", ".tran 1m 10m", "only a note"
//   cell:  [MID] - RK - GND                                       the sheet is used twice
//
// The lines are, statement for statement, what the desktop kicad-cli 10.0.6 writes for the
// same files, without the ".tran" line.
const NETLIST = JSON.stringify({
  items: [
    { device: "R", name: "R1", ref: "R1", type: "" },
    { device: "R", name: "R2", ref: "R2", type: "" },
    { device: "", name: "U1", ref: "U1", type: "" },
    { device: "D", name: "D1", ref: "D1", type: "" },
    { device: "D", name: "D3", ref: "D3", type: "" },
    { device: "SPICE", name: "D2", ref: "D2", type: "" },
    { device: "R", name: "R11", ref: "R11", type: "" },
    { device: "R", name: "R12", ref: "R12", type: "" },
  ],
  lines: [
    { text: ".title KiCad schematic" },
    { text: ".include \"/home/kicad/documents/simprobe/models.lib\"" },
    { kind: "model", ref: "D1", text: ".model __D1 D\n+           is=20f\n+           n=1.9" },
    { text: ".param gain=2" },
    { kind: "item", ref: "R1", text: "R1 +5V /_CS 10k" },
    { kind: "item", ref: "R2", text: "R2 /_CS Net-_D1-A_ 39" },
    { kind: "item", ref: "U1", text: "U1 __U1" },
    { kind: "item", ref: "D1", text: "D1 Net-_D1-A_ GND __D1" },
    { kind: "item", ref: "D3", text: "D3 Net-_D1-A_ GND MYD" },
    { kind: "item", ref: "D2", text: "D2 GND Net-_D1-A_ red" },
    { kind: "item", ref: "R11", text: "R11 /Key_1/MID GND 330" },
    { kind: "item", ref: "R12", text: "R12 /Key_2/MID GND 330" },
    { text: ".end" },
  ],
  messages: [],
  ok: true,
});
const SYMBOLS = JSON.stringify({
  symbols: [
    { ref: "R1", uuid: "aaaaaaaa-0000-0000-0000-000000000001", libId: "Device:R", value: "10k", sheet: "/", sheetPath: "/", fields: {"Value": "10k"}, pins: {"1": {"name": "", "node": "+5V"}, "2": {"name": "", "node": "/_CS"}} },
    { ref: "R2", uuid: "aaaaaaaa-0000-0000-0000-000000000002", libId: "Device:R", value: "39", sheet: "/", sheetPath: "/", fields: {"Value": "39"}, pins: {"1": {"name": "", "node": "/_CS"}, "2": {"name": "", "node": "Net-_D1-A_"}} },
    { ref: "U1", uuid: "aaaaaaaa-0000-0000-0000-000000000005", libId: "Test:DUAL", value: "DUAL", sheet: "/", sheetPath: "/", fields: {"Value": "DUAL"}, pins: {"1": {"name": "A", "node": "unconnected-_U1A-A-Pad1_"}, "2": {"name": "B", "node": "unconnected-_U1A-B-Pad2_"}, "3": {"name": "C", "node": "unconnected-_U1B-C-Pad3_"}, "4": {"name": "D", "node": "unconnected-_U1B-D-Pad4_"}} },
    { ref: "D1", uuid: "cccccccc-0000-0000-0000-000000000001", libId: "Device:D", value: "D", sheet: "/", sheetPath: "/", fields: {"Sim.Device": "D", "Sim.Params": "is=2e-14 n=1.9", "Sim.Pins": "1=K 2=A", "Value": "D"}, pins: {"1": {"name": "K", "node": "GND"}, "2": {"name": "A", "node": "Net-_D1-A_"}} },
    { ref: "R3", uuid: "aaaaaaaa-0000-0000-0000-000000000003", libId: "Device:R", value: "1k", sheet: "/", sheetPath: "/", excluded: true, fields: {"Value": "1k"}, pins: {"1": {"name": "", "node": "Net-_D1-A_"}, "2": {"name": "", "node": "unconnected-_R3-Pad2_"}} },
    { ref: "D3", uuid: "cccccccc-0000-0000-0000-000000000003", libId: "Device:D", value: "MYD", sheet: "/", sheetPath: "/", fields: {"Sim.Device": "D", "Sim.Library": "models.lib", "Sim.Name": "MYD", "Sim.Pins": "1=K 2=A", "Value": "MYD"}, pins: {"1": {"name": "K", "node": "GND"}, "2": {"name": "A", "node": "Net-_D1-A_"}} },
    { ref: "D2", uuid: "cccccccc-0000-0000-0000-000000000002", libId: "Device:D", value: "red", sheet: "/", sheetPath: "/", fields: {"Sim.Pins": "1=K 2=A", "Value": "red"}, pins: {"1": {"name": "K", "node": "GND"}, "2": {"name": "A", "node": "Net-_D1-A_"}} },
    { ref: "R11", uuid: "aaaaaaaa-0000-0000-0000-000000000006", libId: "Device:R", value: "330", sheet: "/Key 1/", sheetPath: "/33333333-0000-0000-0000-000000000001/", fields: {"Value": "330"}, pins: {"1": {"name": "", "node": "/Key_1/MID"}, "2": {"name": "", "node": "GND"}} },
    { ref: "R12", uuid: "aaaaaaaa-0000-0000-0000-000000000006", libId: "Device:R", value: "330", sheet: "/Key 2/", sheetPath: "/33333333-0000-0000-0000-000000000002/", fields: {"Value": "330"}, pins: {"1": {"name": "", "node": "/Key_2/MID"}, "2": {"name": "", "node": "GND"}} },
  ],
});

// The parts of the tests. The LED part also fits the test project's diode symbol when its
// Value is a colour. The chip and the gate are parts with code; the chip fits no symbol of
// the project by itself, so U1 only becomes one by a pick.
const DIODE_LED: PartManifest = { ...LED, fits: [{ symbol: "Device:D", value: "red", pins: "name" }, ...LED.fits] };
const CHIP: PartManifest = {
  schema: 1, id: "demo-chip", version: 3, title: "Demo chip",
  fits: [{ symbol: "Test:CHIP", pins: "name" }],
  pins: ["A", "B", "C", "D"],
  analog: { file: "model.lib", subckt: "T_CHIP" },
  digital: { kind: "part-wasm", file: "logic.wasm", abi: 1, source: "logic.c", language: "c", orderParam: "ORDER" },
};
const CHIP_MODEL = `.subckt T_CHIP A B C D ORDER=0
Achip [A B] [C D] chipmodel
.model chipmodel d_cosim(simulation="demo-chip" sim_args=["{ORDER}"])
.ends T_CHIP
`;
const GATE: PartManifest = {
  schema: 1, id: "demo-gate", version: 1, title: "Demo gate",
  fits: [{ symbol: "Test:GATE" }],
  pins: ["1", "2"],
  analog: { file: "model.lib", subckt: "T_GATE" },
  digital: { kind: "part-wasm", file: "logic.wasm", abi: 1, source: "logic.c", language: "c", orderParam: "ORDER" },
};
const WASM = new Uint8Array([0, 97, 115, 109]);
const loaded = (manifest: PartManifest, analog: string, logic: Uint8Array | null = null): LoadedPart => ({ id: manifest.id, manifest, analog, logic });
const PARTS = new Map([
  loaded(DIODE_LED, LED_MODEL), loaded(BUTTON, BUTTON_MODEL), loaded(POT, POT_MODEL),
  loaded(CHIP, CHIP_MODEL, WASM), loaded(GATE, ".subckt T_GATE 1 2 ORDER=0\n.ends T_GATE\n", WASM),
].map((p) => [p.id, p]));
const INDEX = { parts: [...PARTS.values()].map((p) => ({ id: p.id, version: p.manifest.version, title: p.manifest.title, description: "", fits: p.manifest.fits, pins: p.manifest.pins, code: !!p.manifest.digital, files: [] })) };

const read = () => ({ symbols: readEditorSymbols(SYMBOLS).symbols, netlist: readEditorNetlist(NETLIST) });
const UUID = (ref: string): string => read().symbols.find((s) => s.ref === ref)?.uuid ?? "";

/** Match and build on the test project, with picks by reference. */
function build(picks: Record<string, string> = {}, more: { live?: boolean; netlist?: EditorNetlist } = {}) {
  const { symbols, netlist } = read();
  const overrides = Object.fromEntries(Object.entries(picks).map(([ref, part]) => [UUID(ref), part]));
  const used = more.netlist ?? netlist;
  const plan = matchSymbols(INDEX, symbols, { overrides, kicadModels: kicadModels(used) });
  return { plan, ...buildDeck({ symbols, netlist: used, plan, parts: PARTS, live: more.live }) };
}

describe("reading the editor's netlist", () => {
  it("gives the statements, the items and the messages", () => {
    const n = readEditorNetlist(NETLIST);
    expect(n.ok).toBe(true);
    expect(n.lines).toHaveLength(13);
    expect(n.lines[0]).toEqual({ text: ".title KiCad schematic" });
    expect(n.lines[2]).toEqual({ text: ".model __D1 D\n+           is=20f\n+           n=1.9", ref: "D1", kind: "model" });
    expect(n.items.find((i) => i.ref === "U1")).toEqual({ ref: "U1", name: "U1", device: "", type: "", off: false });
    expect(readEditorNetlist(JSON.parse(NETLIST))).toEqual(n);
  });

  it("says which symbols KiCad writes a real line for", () => {
    // not U1: KiCad has no model for it, its line is a placeholder
    expect([...kicadModels(readEditorNetlist(NETLIST))].sort()).toEqual(["D1", "D2", "D3", "R1", "R11", "R12", "R2"]);
    expect([...kicadModels({ lines: [], items: [{ ref: "R1", name: "R1", device: "R", type: "", off: true }] })]).toEqual([]);
  });

  it("reads the messages, and an unknown severity as an error", () => {
    const n = readEditorNetlist({ lines: [], items: [], ok: false, messages: [{ severity: "warning", text: "w" }, { severity: "odd", text: "e" }, { text: "bare" }, 7] });
    expect(n.messages).toEqual([{ severity: "warning", text: "w" }, { severity: "error", text: "e" }, { severity: "error", text: "bare" }]);
    expect(n.ok).toBe(false);
    expect(readEditorNetlist({ lines: [], items: [{ ref: "R1", name: "R1", device: "R", off: true }] }).items).toEqual([{ ref: "R1", name: "R1", device: "R", type: "", off: true }]);
  });

  it("says in plain words what is wrong with an answer", () => {
    expect(() => readEditorNetlist("{\"error\":\"no schematic frame\"}")).toThrow("the netlist could not be written: no schematic frame");
    expect(() => readEditorNetlist("not json")).toThrow("the editor's netlist is not understood: it is not JSON");
    expect(() => readEditorNetlist("[]")).toThrow("it is not an object");
    expect(() => readEditorNetlist({})).toThrow("it has no list of lines");
    expect(() => readEditorNetlist({ lines: [] })).toThrow("it has no list of items");
    expect(() => readEditorNetlist({ lines: [{ ref: "R1" }], items: [] })).toThrow("line 0 has no text");
    expect(() => readEditorNetlist({ lines: [{ text: "R1 a b 1k", ref: "R1", kind: "odd" }], items: [] })).toThrow("line 0 is of an unknown kind");
    expect(() => readEditorNetlist({ lines: [], items: [{ ref: "R1" }] })).toThrow("item 0 has no reference, name or device");
  });
});

describe("the circuit that runs", () => {
  it("is KiCad's netlist without the placeholders when no library part is used", () => {
    const { deck, files, placed, notSimulated, errors, notes } = build({ D2: "off" });
    expect(deck).toEqual([
      ".title KiCad schematic",
      ".include \"/home/kicad/documents/simprobe/models.lib\"",
      ".model __D1 D",
      "+           is=20f",
      "+           n=1.9",
      ".param gain=2",
      "R1 +5V /_CS 10k",
      "R2 /_CS Net-_D1-A_ 39",
      "D1 Net-_D1-A_ GND __D1",
      "D3 Net-_D1-A_ GND MYD",
      "D2 GND Net-_D1-A_ red",
      "R11 /Key_1/MID GND 330",
      "R12 /Key_2/MID GND 330",
      // nothing in the schematic powers the wire +5V: its name does
      "Vpj_supply_1 pj_supply_1 0 DC 5",
      "Rpj_supply_1 pj_supply_1 +5V 10m",
      LIVE_TRAN,
      ".end",
    ]);
    expect(notSimulated).toEqual(["U1"]);
    expect([files, placed, errors, notes]).toEqual([[], [], [], []]);
  });

  it("puts the library parts in the place of the matched symbols", () => {
    // D2 finds the LED part by itself (the library knows the symbol with that Value), R2 is
    // made a push button by a pick, U1 becomes the chip with code.
    const { plan, deck, files, inputs, signals, codeParts, placed, notSimulated, errors, notes } = build({ R2: "push-button", U1: "demo-chip" });
    expect(plan.map((m) => [m.ref, m.status])).toEqual([
      ["R1", "kicad"], ["R2", "matched"], ["U1", "matched"], ["D1", "kicad"], ["D3", "kicad"], ["D2", "matched"], ["R11", "kicad"], ["R12", "kicad"],
    ]);
    expect(deck).toEqual([
      ".title KiCad schematic",
      ".include \"/sim-library/led/model.lib\"",
      ".include \"/sim-library/push-button/model.lib\"",
      ".include \"/sim-library/demo-chip/model.lib\"",
      ".include \"/home/kicad/documents/simprobe/models.lib\"",
      ".model __D1 D",
      "+           is=20f",
      "+           n=1.9",
      ".param gain=2",
      "R1 +5V /_CS 10k",
      "D1 Net-_D1-A_ GND __D1",
      "D3 Net-_D1-A_ GND MYD",
      "R11 /Key_1/MID GND 330",
      "R12 /Key_2/MID GND 330",
      "XD2 Net-_D1-A_ GND T_LED",
      "XR2 /_CS Net-_D1-A_ T_BUTTON",
      "XU1 unconnected-_U1A-A-Pad1_ unconnected-_U1A-B-Pad2_ unconnected-_U1B-C-Pad3_ unconnected-_U1B-D-Pad4_ T_CHIP ORDER=1",
      "Vpj_supply_1 pj_supply_1 0 DC 5",
      "Rpj_supply_1 pj_supply_1 +5V 10m",
      LIVE_TRAN,
      ".end",
    ]);
    expect([notSimulated, errors, notes]).toEqual([[], [], []]);

    // the model files, in the order of the includes; live: the button's source is set by the app
    expect(files.map((f) => f.path)).toEqual(["/sim-library/led/model.lib", "/sim-library/push-button/model.lib", "/sim-library/demo-chip/model.lib"]);
    expect(files[0]?.text).toBe(LED_MODEL);
    expect(files[1]?.text).toContain("Vctl ctl 0 dc 0 external");

    expect(inputs).toEqual([{ ref: "R2", partId: "push-button", input: BUTTON.inputs?.[0], vector: "v.xr2.vctl", initial: 0 }]);
    expect(signals).toEqual([{ ref: "D2", partId: "led", name: "current", vector: "v.xd2.vsense#branch" }]);
    expect(codeParts).toEqual([{ partId: "demo-chip", kind: "part-wasm", name: "demo-chip", logic: WASM }]);

    expect(placed.map((p) => [p.ref, p.partId, p.version, p.rule, p.name, p.number])).toEqual([
      ["D2", "led", 1, 3, "XD2", 0],
      ["R2", "push-button", 1, 1, "XR2", 0],
      ["U1", "demo-chip", 3, 1, "XU1", 1],
    ]);
    // the LED's colour comes from the symbol's Value
    expect(placed[0]?.settings).toEqual({ color: { value: "red", from: "value" } });
    expect(placed[0]?.nodes).toEqual(["Net-_D1-A_", "GND"]);
    // which pins have something else on them: both of the LED, none of the chip
    expect(placed.map((p) => p.connected)).toEqual([["A", "K"], ["1", "2"], []]);
    expect(placed[0]).toMatchObject({ uuid: UUID("D2"), sheet: "/" });
  });

  it("writes the plain circuit when it is not a live run", () => {
    const { deck, files } = build({ R2: "push-button" }, { live: false });
    expect(deck).not.toContain(LIVE_TRAN);
    expect(deck[deck.length - 1]).toBe(".end");
    expect(files.find((f) => f.path.includes("push-button"))?.text).toBe(BUTTON_MODEL);
  });

  it("writes a part's settings as subcircuit parameters, and says what it dropped", () => {
    const { symbols, netlist } = read();
    const r1 = symbols.find((s) => s.ref === "R1");
    if (!r1) throw new Error("no R1");
    r1.fields["PCBJam.SimPart"] = "potentiometer";
    r1.fields["PCBJam.SimSettings"] = "resistance=47k colour=blue";
    r1.pins["3"] = { name: "", node: "/WIPER" };
    const plan = matchSymbols(INDEX, symbols, { kicadModels: kicadModels(netlist) });
    const { deck, inputs, notes, placed } = buildDeck({ symbols, netlist, plan, parts: PARTS });
    expect(deck).toContain("XR1 +5V /_CS /WIPER T_POT RTOT=47k");
    expect(deck).not.toContain("R1 +5V /_CS 10k");
    expect(notes).toEqual(["R1: the part has no setting \"colour\""]);
    expect(inputs.find((i) => i.ref === "R1")).toMatchObject({ vector: "v.xr1.vpos", initial: 0.5 });
    expect(placed.find((p) => p.ref === "R1")?.settings).toEqual({ resistance: { value: "47k", from: "field" } });
  });

  it("numbers every placed part with code, and lists its code once", () => {
    const { symbols, netlist } = read();
    for (const s of symbols) if (s.ref === "R11" || s.ref === "R12") s.libId = "Test:GATE";
    const plan = matchSymbols(INDEX, symbols, { overrides: { [UUID("U1")]: "demo-chip" }, kicadModels: kicadModels(netlist) });
    const { deck, codeParts, placed } = buildDeck({ symbols, netlist, plan, parts: PARTS });
    expect(deck.filter((l) => l.startsWith("X") && l.includes("ORDER="))).toEqual([
      "XR11 /Key_1/MID GND T_GATE ORDER=1",
      "XR12 /Key_2/MID GND T_GATE ORDER=2",
      "XU1 unconnected-_U1A-A-Pad1_ unconnected-_U1A-B-Pad2_ unconnected-_U1B-C-Pad3_ unconnected-_U1B-D-Pad4_ T_CHIP ORDER=3",
    ]);
    expect(placed.filter((p) => p.number).map((p) => [p.ref, p.number])).toEqual([["R11", 1], ["R12", 2], ["U1", 3]]);
    expect(codeParts.map((c) => c.partId)).toEqual(["demo-gate", "demo-chip"]);
    expect(deck.filter((l) => l.includes("demo-gate/model.lib"))).toHaveLength(1);
  });

  it("gives every placed chip that runs firmware a model and code of its own", () => {
    const mcu: PartManifest = {
      schema: 1, id: "demo-mcu", version: 1, title: "Demo microcontroller",
      fits: [{ symbol: "Test:MCU" }],
      pins: ["1", "2"],
      analog: { file: "model.lib", subckt: "T_MCU" },
      digital: { kind: "emulator", emulator: "demo-emu", chip: "demo", pads: { "1": 0, "2": 1 }, orderParam: "ORDER" },
    };
    const model = `* a chip\n.subckt T_MCU 1 2 ORDER=0\nAemu [1] [2] mcumodel\n.model mcumodel d_cosim(simulation="demo-mcu" irreversible={ORDER})\n.ends T_MCU\n`;
    const parts = new Map([...PARTS, ["demo-mcu", loaded(mcu, model)]]);
    const index = { parts: [...INDEX.parts, { id: mcu.id, version: 1, title: mcu.title, description: "", fits: mcu.fits, pins: mcu.pins, code: true, files: [] }] };
    const { symbols, netlist } = read();
    for (const s of symbols) if (s.ref === "R11" || s.ref === "R12") s.libId = "Test:MCU";
    const plan = matchSymbols(index, symbols, { overrides: { [UUID("U1")]: "demo-chip" }, kicadModels: kicadModels(netlist) });
    const { deck, files, codeParts, placed, errors } = buildDeck({ symbols, netlist, plan, parts });
    expect(errors).toEqual([]);
    // each chip's line names its own subcircuit; the part with compiled code keeps the one it has
    expect(deck.filter((l) => l.startsWith("X") && l.includes("ORDER="))).toEqual([
      "XR11 /Key_1/MID GND T_MCU_1 ORDER=1",
      "XR12 /Key_2/MID GND T_MCU_2 ORDER=2",
      "XU1 unconnected-_U1A-A-Pad1_ unconnected-_U1A-B-Pad2_ unconnected-_U1B-C-Pad3_ unconnected-_U1B-D-Pad4_ T_CHIP ORDER=3",
    ]);
    const own = files.filter((f) => f.path.includes("demo-mcu"));
    expect(own.map((f) => f.path)).toEqual(["/sim-library/demo-mcu/model.1.lib", "/sim-library/demo-mcu/model.2.lib"]);
    expect(own[0]?.text).toBe(`* a chip\n.subckt T_MCU_1 1 2 ORDER=0\nAemu [1] [2] mcumodel\n.model mcumodel d_cosim(simulation="demo-mcu_1" irreversible={ORDER})\n.ends T_MCU_1\n`);
    expect(own[1]?.text).toContain('simulation="demo-mcu_2"');
    expect(deck.filter((l) => l.includes("demo-mcu/"))).toEqual(['.include "/sim-library/demo-mcu/model.1.lib"', '.include "/sim-library/demo-mcu/model.2.lib"']);
    expect(codeParts).toEqual([
      { partId: "demo-mcu", kind: "emulator", name: "demo-mcu_1", ref: "R11", logic: null },
      { partId: "demo-mcu", kind: "emulator", name: "demo-mcu_2", ref: "R12", logic: null },
      { partId: "demo-chip", kind: "part-wasm", name: "demo-chip", logic: WASM },
    ]);
    expect(placed.filter((p) => p.number).map((p) => [p.ref, p.number])).toEqual([["R11", 1], ["R12", 2], ["U1", 3]]);

    // a model the step cannot give to each chip stops the run with the chip's name
    const loose = new Map([...PARTS, ["demo-mcu", loaded(mcu, model + ".model LOOSE D(IS=1e-14)\n")]]);
    expect(buildDeck({ symbols, netlist, plan, parts: loose }).errors).toEqual([
      "R11: T_MCU: the model file of a chip may hold only its one subcircuit",
      "R12: T_MCU: the model file of a chip may hold only its one subcircuit",
    ]);
  });

  it("gives a pin without a net a node of its own", () => {
    const { symbols, netlist } = read();
    const d2 = symbols.find((s) => s.ref === "D2");
    if (!d2) throw new Error("no D2");
    d2.pins["1"] = { name: "K" };
    const plan = matchSymbols(INDEX, symbols, { kicadModels: kicadModels(netlist) });
    const { deck, placed } = buildDeck({ symbols, netlist, plan, parts: PARTS });
    expect(deck).toContain("XD2 Net-_D1-A_ unconnected-D2-1 T_LED");
    expect(placed.find((p) => p.ref === "D2")?.connected).toEqual(["A"]);
  });

  it("leaves out a matched symbol whose model is switched off in KiCad", () => {
    const netlist = readEditorNetlist(NETLIST);
    const off: EditorNetlist = {
      ...netlist,
      lines: netlist.lines.filter((l) => l.ref !== "D2"),
      items: netlist.items.map((i) => (i.ref === "D2" ? { ...i, off: true } : i)),
    };
    const { deck, placed, notes } = build({}, { netlist: off });
    expect(deck.some((l) => l.includes("D2"))).toBe(false);
    expect(placed).toEqual([]);
    expect(notes).toEqual(["D2: its model is switched off in KiCad, so it is left out"]);
  });

  it("does not let a run start on a netlist KiCad could not write in full", () => {
    const netlist = readEditorNetlist(NETLIST);
    const lost: EditorNetlist = { ...netlist, ok: false, messages: [{ severity: "error", text: "Simulation model library not found at '/p/lost.lib'" }, { severity: "warning", text: "odd value" }] };
    const a = build({}, { netlist: lost });
    expect(a.errors).toEqual(["KiCad: Simulation model library not found at '/p/lost.lib'"]);
    expect(a.notes).toEqual(["KiCad: odd value"]);
    expect(build({}, { netlist: { ...netlist, ok: false } }).errors).toEqual(["KiCad could not write the netlist of this schematic"]);
  });

  it("refuses a code-model line that is too long for the simulator", () => {
    const { symbols, netlist } = read();
    const pieces = Array.from({ length: CODE_MODEL_LINE_MAX }, (_, i) => `n${i}`).join(" ");
    const long = loaded(CHIP, `.subckt T_CHIP A B C D ORDER=0\nAchip [${pieces}] chipmodel\n.ends T_CHIP\n`, WASM);
    const plan = matchSymbols(INDEX, symbols, { overrides: { [UUID("U1")]: "demo-chip" }, kicadModels: kicadModels(netlist) });
    const { errors } = buildDeck({ symbols, netlist, plan, parts: new Map([...PARTS, ["demo-chip", long]]) });
    expect(errors).toEqual([`/sim-library/demo-chip/model.lib: the line of Achip is too long for the simulator (${CODE_MODEL_LINE_MAX + 4} pieces, at most ${CODE_MODEL_LINE_MAX})`]);
  });

  it("says so when a part is not loaded, or an input's source is not in the model", () => {
    const { symbols, netlist } = read();
    const plan = matchSymbols(INDEX, symbols, { overrides: { [UUID("R2")]: "push-button" }, kicadModels: kicadModels(netlist) });
    const noLed = new Map(PARTS);
    noLed.delete("led");
    noLed.set("push-button", loaded(BUTTON, ".subckt T_BUTTON 1 2\nR1 1 2 1k\n.ends T_BUTTON\n"));
    const { errors, deck } = buildDeck({ symbols, netlist, plan, parts: noLed });
    expect(errors).toEqual([
      "D2: the library part \"led\" is not loaded",
      "push-button: T_BUTTON: not every input source was found (Vctl)",
    ]);
    // D2 keeps KiCad's line then; nothing is half replaced
    expect(deck).toContain("D2 GND Net-_D1-A_ red");
    expect(() => buildDeck({ symbols: symbols.slice(1), netlist, plan, parts: PARTS })).toThrow("the plan is not about these symbols");
  });
});

describe("from the library and the schematic to the circuit", () => {
  it("matches, loads only the parts that are used, and builds", async () => {
    const snapshot = makeSnapshot([[DIODE_LED, LED_MODEL], [POT, POT_MODEL], [BUTTON, BUTTON_MODEL]]);
    const cdn = serve(snapshot);
    const library = await openLibrary("https://library.test/sim", { fetch: cdn.fetch });
    const { symbols, netlist } = read();
    const run = await prepareRun({ library, symbols, netlist });

    expect(run.plan.find((m) => m.ref === "D2")).toMatchObject({ status: "matched", partId: "led" });
    expect(run.plan.find((m) => m.ref === "R1")).toMatchObject({ status: "kicad" });
    expect(run.plan.find((m) => m.ref === "U1")).toMatchObject({ status: "none" });
    expect([...run.parts.keys()]).toEqual(["led"]);
    expect(cdn.asked.filter((a) => a.includes("/parts/")).sort()).toEqual([`${snapshot.version}/parts/led/model.lib`, `${snapshot.version}/parts/led/part.json`]);
    expect(run.deck).toContain("XD2 Net-_D1-A_ GND T_LED");
    expect(run.deck).not.toContain("D2 GND Net-_D1-A_ red");
    expect(run.notSimulated).toEqual(["U1"]);
    expect(run.errors).toEqual([]);

    const picked = await prepareRun({ library, symbols, netlist, overrides: { [UUID("D2")]: "off", [UUID("R2")]: "push-button" }, live: false, modelPath: (id, file) => `parts/${id}/${file}` });
    expect(picked.deck.slice(0, 2)).toEqual([".title KiCad schematic", ".include \"parts/push-button/model.lib\""]);
    expect(picked.deck).toContain("D2 GND Net-_D1-A_ red");
    expect(picked.deck).toContain("XR2 /_CS Net-_D1-A_ T_BUTTON");
  });
});

// A symbol with two pins whose reference starts with R, C or L is a resistor, a capacitor or
// a coil to KiCad, whatever it is. Its line has the symbol's Value where the number belongs.
describe("a resistor, capacitor or coil that KiCad made out of the reference alone", () => {
  const two = (a: string, b: string) => ({ "1": { name: "", node: a }, "2": { name: "", node: b } });
  const sym = (ref: string, libId: string, value: string, fields: Record<string, string> = {}): SchematicSymbol =>
    ({ ref, uuid: `uuid-${ref}`, libId, value, sheet: "/", fields: { Value: value, ...fields }, pins: two("+5V", "GND") });
  const SYMBOLS = [
    sym("R1", "Device:R", "330"), sym("R2", "Device:R", "R"), sym("C1", "Device:C", "100nF"), sym("L1", "Device:L", ".5m"),
    sym("LS1", "Device:Speaker_Ultrasound", "Speaker_Ultrasound"), sym("RV1", "Device:Varistor", "Varistor"), sym("CB1", "Device:CircuitBreaker_1P", "CircuitBreaker_1P"),
    sym("R3", "Device:R", "{2*k}"), sym("R4", "Device:R", "DNP", { "Sim.Device": "R", "Sim.Params": "r=DNP" }),
  ];
  const netlist = readEditorNetlist({
    ok: true, messages: [],
    items: [
      ...["R1", "R2", "R3", "R4", "RV1"].map((ref) => ({ device: "R", name: ref, ref, type: "" })),
      ...["C1", "CB1"].map((ref) => ({ device: "C", name: ref, ref, type: "" })),
      ...["L1", "LS1"].map((ref) => ({ device: "L", name: ref, ref, type: "" })),
    ],
    lines: [
      { text: ".title KiCad schematic" },
      ...SYMBOLS.map((s) => ({ kind: "item", ref: s.ref, text: `${s.ref} +5V GND ${s.value}` })),
      { text: ".end" },
    ],
  });

  it("is found when its Value is no number", () => {
    expect([...unusableLines(netlist, SYMBOLS)].sort()).toEqual([["CB1", "no-value"], ["LS1", "no-value"], ["R2", "no-value"], ["RV1", "no-value"]]);
    // a number with its unit, a number that starts with its point, a formula: all run;
    // and so does the line of a model the user chose on the symbol, whatever it says
    expect([...kicadModels(netlist, SYMBOLS)].sort()).toEqual(["C1", "L1", "R1", "R3", "R4"]);
  });

  it("is not looked for without the symbols", () => {
    expect([...unusableLines(netlist)]).toEqual([]);
  });

  it("is left out of the circuit, and the rest runs", () => {
    const plan = matchSymbols({ parts: [] }, SYMBOLS, { kicadModels: kicadModels(netlist, SYMBOLS) });
    expect(plan.filter((m) => m.status === "none").map((m) => m.ref).sort()).toEqual(["CB1", "LS1", "R2", "RV1"]);
    const run = buildDeck({ symbols: SYMBOLS, netlist, plan, parts: new Map(), live: false });
    expect(run.errors).toEqual([]);
    expect(run.notSimulated).toEqual(["CB1", "LS1", "R2", "RV1"]);
    expect(run.deck.filter((l) => /^(R|C|L)[A-Z]*\d/.test(l))).toEqual(["R1 +5V GND 330", "C1 +5V GND 100nF", "L1 +5V GND .5m", "R3 +5V GND {2*k}", "R4 +5V GND DNP"]);
  });
});

// A stock LED or transistor: KiCad has no model for it and writes a line that names the
// symbol's Value as the model. Nothing defines "red", and ngspice refuses the whole circuit
// because of that one line.
describe("a line that names a model nothing defines", () => {
  /** The test project without D3 and its model file: nothing is included. */
  const plain = (change: (n: { lines: { text: string; ref?: string; kind?: string }[]; items: { ref: string }[] }) => void = () => {}): EditorNetlist => {
    const raw = JSON.parse(NETLIST);
    raw.lines = raw.lines.filter((l: { text: string; ref?: string }) => !l.text.startsWith(".include") && l.ref !== "D3");
    raw.items = raw.items.filter((i: { ref: string }) => i.ref !== "D3");
    change(raw);
    return readEditorNetlist(raw);
  };
  const symbols = () => read().symbols.filter((s) => s.ref !== "D3");

  it("is found, next to the placeholders", () => {
    expect([...unusableLines(plain(), symbols())].sort()).toEqual([["D2", "undefined-model"], ["U1", "no-model"]]);
    // D1 has a model KiCad wrote itself; the resistors need none
    expect([...kicadModels(plain(), symbols())].sort()).toEqual(["D1", "R1", "R11", "R12", "R2"]);
  });

  it("is not looked for without the symbols: only the placeholders are sure then", () => {
    expect([...unusableLines(plain())]).toEqual([["U1", "no-model"]]);
    expect([...kicadModels(plain())].sort()).toEqual(["D1", "D2", "R1", "R11", "R12", "R2"]);
  });

  it("stays when a text on the sheet defines the model", () => {
    const withModel = plain((n) => n.lines.splice(1, 0, { text: ".param k=1\n.model RED D(is=1e-18\n+ n=2)" }));
    expect([...unusableLines(withModel, symbols())]).toEqual([["U1", "no-model"]]);
    const withSubckt = plain((n) => n.lines.splice(1, 0, { text: ".subckt red k a\nR1 k a 1k\n.ends" }));
    expect([...unusableLines(withSubckt, symbols())]).toEqual([["U1", "no-model"]]);
  });

  it("stays when the netlist includes a file: the model can be in there", () => {
    const n = plain((raw) => raw.lines.splice(1, 0, { text: ".include \"/home/kicad/documents/p/models.lib\"" }));
    expect([...unusableLines(n, symbols())]).toEqual([["U1", "no-model"]]);
    // the whole test project: D3's model file is included
    expect([...unusableLines(readEditorNetlist(NETLIST), read().symbols)]).toEqual([["U1", "no-model"]]);
  });

  it("stays when the user asked for a raw SPICE line on the symbol", () => {
    const asked = symbols().map((s) => (s.ref === "D2" ? { ...s, fields: { ...s.fields, "Sim.Device": "SPICE", "Sim.Params": "type=\"D\" model=\"red\"" } } : s));
    expect([...unusableLines(plain(), asked)]).toEqual([["U1", "no-model"]]);
  });

  it("is left out of the circuit, and the rest runs", () => {
    const syms = symbols();
    const netlist = plain();
    const plan = matchSymbols(INDEX, syms, { overrides: { [UUID("D2")]: "off" }, kicadModels: kicadModels(netlist, syms) });
    const { deck, notSimulated, errors } = buildDeck({ symbols: syms, netlist, plan, parts: PARTS });
    expect(notSimulated).toEqual(["D2", "U1"]);
    expect(errors).toEqual([]);
    expect(deck.some((l) => /^D2 /.test(l))).toBe(false);
    expect(deck.some((l) => /^U1 /.test(l))).toBe(false);
    expect(deck).toContain("D1 Net-_D1-A_ GND __D1");
    expect(deck).toContain("R2 /_CS Net-_D1-A_ 39");
  });

  it("is not left out when a library part takes the symbol", async () => {
    // D2 is "Device:D" with the Value "red": the tests' LED part fits it
    const run = await prepareRun({ library: { index: INDEX as never, loadPart: async (id) => PARTS.get(id)! }, symbols: symbols(), netlist: plain() });
    expect(run.notSimulated).toEqual(["U1"]);
    expect(run.placed.map((p) => p.ref)).toEqual(["D2"]);
    expect(run.deck.some((l) => /^XD2 /.test(l))).toBe(true);
  });
});

describe("the nets of a symbol that has no line", () => {
  const ties = (deck: string[]) => deck.filter((l) => /^Rpj_left_/.test(l));
  /** The test project with a chip U2 that nothing models, between the nets /A, /B and ground. */
  const withChip = () => {
    const { symbols, netlist } = read();
    const chip = { ...symbols.find((s) => s.ref === "U1")!, ref: "U2", uuid: "aaaaaaaa-0000-0000-0000-00000000000a",
      pins: { "1": { name: "A", node: "/B" }, "2": { name: "B", node: "/A" }, "3": { name: "G", node: "GND" }, "4": { name: "N", node: "unconnected-_U2-N-Pad4_" } } };
    const raw = JSON.parse(NETLIST);
    raw.lines.splice(raw.lines.length - 1, 0, { kind: "item", ref: "U2", text: "U2 __U2" }, { kind: "item", ref: "R20", text: "R20 /A /B 1k" });
    raw.items.push({ device: "", name: "U2", ref: "U2", type: "" }, { device: "R", name: "R20", ref: "R20", type: "" });
    const resistor = { ...symbols.find((s) => s.ref === "R1")!, ref: "R20", uuid: "aaaaaaaa-0000-0000-0000-00000000000b",
      pins: { "1": { name: "", node: "/A" }, "2": { name: "", node: "/B" } } };
    return { symbols: [...symbols, chip, resistor], netlist: readEditorNetlist(raw) };
  };
  const deckOf = (symbols: ReturnType<typeof read>["symbols"], netlist: EditorNetlist, more: Partial<Parameters<typeof buildDeck>[0]> = {}) => {
    const plan = matchSymbols(INDEX, symbols, { overrides: { [UUID("D2")]: "off" }, kicadModels: kicadModels(netlist, symbols) });
    return buildDeck({ symbols, netlist, plan, parts: PARTS, ...more });
  };

  it("get a path to ground each, so the simulator finds a voltage for them", () => {
    const { symbols, netlist } = withChip();
    const { deck, notSimulated } = deckOf(symbols, netlist);
    expect(notSimulated).toEqual(["U1", "U2"]);
    // not the ground net, not a net with this pin alone; the lines stand before the analysis
    expect(ties(deck)).toEqual([`Rpj_left_1 /A 0 ${LEFT_OUT_TIE}`, `Rpj_left_2 /B 0 ${LEFT_OUT_TIE}`]);
    expect(deck.slice(-6)).toEqual([
      `Rpj_left_1 /A 0 1g`, `Rpj_left_2 /B 0 1g`, "Vpj_supply_1 pj_supply_1 0 DC 5", "Rpj_supply_1 pj_supply_1 +5V 10m", LIVE_TRAN, ".end",
    ]);
  });

  it("are left alone when every symbol with a net has its line", () => {
    // U1 is left out, but each of its pins is alone on its net
    expect(ties(build({ D2: "off" }).deck)).toEqual([]);
  });

  it("are tied as well for a symbol excluded from simulation or switched off in KiCad", () => {
    const { symbols, netlist } = read();
    const excluded = readEditorSymbols(SYMBOLS).excluded;
    expect(excluded.map((s) => s.ref)).toEqual(["R3"]);
    expect(ties(deckOf(symbols, netlist, { excluded }).deck)).toEqual([`Rpj_left_1 Net-_D1-A_ 0 ${LEFT_OUT_TIE}`]);

    const off: EditorNetlist = { ...netlist, lines: netlist.lines.filter((l) => l.ref !== "R11"), items: netlist.items.map((i) => (i.ref === "R11" ? { ...i, off: true } : i)) };
    expect(ties(deckOf(symbols, off).deck)).toEqual([`Rpj_left_1 /Key_1/MID 0 ${LEFT_OUT_TIE}`]);
  });
});
