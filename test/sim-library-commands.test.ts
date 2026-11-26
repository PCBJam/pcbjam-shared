// Simulator commands a schematic carries in its texts, and what the netlist step does with
// them (withoutCommands in src/sim-library/netlist.ts): the circuit runs, the commands do not.
import { describe, expect, it } from "vitest";
import { buildDeck, kicadModels, matchSymbols, readEditorNetlist, withoutCommands, type SchematicSymbol } from "../src/sim-library/index.js";

/** A text of the sheet: KiCad hands it on as one statement of several lines. */
const text = (...lines: string[]) => ({ text: lines.join("\n") });
const item = (...lines: string[]) => ({ text: lines.join("\n"), kind: "item" as const });
/** True when a line would be taken for a command by the simulator. */
const isCommand = (line: string): boolean => /^\s*\.control/i.test(line) || /^\s*\*#/.test(line);
const linesOf = (texts: string[]): string[] => texts.flatMap((t) => t.split("\n"));

describe("simulator commands in a schematic's texts", () => {
  it("takes a block out and keeps what defines the circuit", () => {
    expect(withoutCommands([text(".param gain=2", ".control", "run", "quit", ".endc", ".ic v(out)=0")])).toEqual({
      texts: [".param gain=2\n.ic v(out)=0"], commands: 1,
    });
    // a text that is nothing but a block is gone
    expect(withoutCommands([text(".title KiCad schematic"), text(".control", "quit", ".endc"), item("R1 a 0 1k"), text(".end")])).toEqual({
      texts: [".title KiCad schematic", "R1 a 0 1k", ".end"], commands: 1,
    });
    // each block is one
    expect(withoutCommands([text(".control", "run", ".endc", ".param a=1", ".control", "quit", ".endc")])).toEqual({ texts: [".param a=1"], commands: 2 });
  });

  it("knows the start of a block as the simulator does: by how the line begins", () => {
    for (const start of [".control", ".CONTROL", ".Control", " .control", "\t.control", ".controlx", ".control ; note", ".controls 1"])
      expect(withoutCommands([text(".param a=1", start, "quit", ".endc")]), start).toEqual({ texts: [".param a=1"], commands: 1 });
    for (const end of [".endc", ".ENDC", "  .endc", ".endcx"])
      expect(withoutCommands([text(".control", "quit", end, ".param a=1")]), end).toEqual({ texts: [".param a=1"], commands: 1 });
    // not a block: the word is not at the start of the line
    expect(withoutCommands([text(".param control=1", "* .control", "R9 a 0 1k ; .control")])).toEqual({
      texts: [".param control=1\n* .control\nR9 a 0 1k ; .control"], commands: 0,
    });
  });

  it("takes out a line the simulator carries out wherever it stands", () => {
    expect(withoutCommands([text(".param a=1", "*#quit", ".ic v(x)=0")])).toEqual({ texts: [".param a=1\n.ic v(x)=0"], commands: 1 });
    expect(withoutCommands([text(".param a=1", "  *# echo hello")])).toEqual({ texts: [".param a=1"], commands: 1 });
    // a remark is no command
    expect(withoutCommands([text(".param a=1", "* a remark", "*", "** #quit")])).toEqual({ texts: [".param a=1\n* a remark\n*\n** #quit"], commands: 0 });
  });

  it("ends a block that has no end where the texts of the sheet end", () => {
    // KiCad writes the texts in front of the symbols' lines
    const out = withoutCommands([text(".title KiCad schematic"), text(".control", "quit"), text(".param a=1"), item("R1 a 0 1k"), item("V1 a 0 DC 5"), text(".end")]);
    expect(out).toEqual({ texts: [".title KiCad schematic", "R1 a 0 1k", "V1 a 0 DC 5", ".end"], commands: 1 });
    // a block that ends in another text
    expect(withoutCommands([text(".control", "run"), text("quit", ".endc", ".param a=1"), item("R1 a 0 1k")])).toEqual({ texts: [".param a=1", "R1 a 0 1k"], commands: 1 });
  });

  it("ends a block in a symbol's own line with that line", () => {
    // a field with a line break in it
    const out = withoutCommands([item("R1 a 0 1k", ".control", "quit"), item("R2 a 0 2k"), { text: ".model d1 d", kind: "model" as const }, text(".end")]);
    expect(out).toEqual({ texts: ["R1 a 0 1k", "R2 a 0 2k", ".model d1 d", ".end"], commands: 1 });
    // a symbol's line ends a block of the texts, and is never in one
    expect(withoutCommands([text(".control"), item("R1 a 0 1k"), text(".endc"), text(".param a=1")])).toEqual({ texts: ["R1 a 0 1k", ".param a=1"], commands: 1 });
  });

  it("takes out an end without a block, and the lines that continue a line that is gone", () => {
    expect(withoutCommands([text(".param a=1", ".endc", ".ic v(x)=0")])).toEqual({ texts: [".param a=1\n.ic v(x)=0"], commands: 0 });
    expect(withoutCommands([text(".param a=1", "*#echo one", "+ two", "+ three", ".param b=2")])).toEqual({ texts: [".param a=1\n.param b=2"], commands: 1 });
    expect(withoutCommands([text(".control", "quit", ".endc", "+ left", ".param b=2")])).toEqual({ texts: [".param b=2"], commands: 1 });
    // the lines that continue a line that stays, stay
    expect(withoutCommands([text(".model d1 d", "+ is=1e-14", "+ n=1.2")])).toEqual({ texts: [".model d1 d\n+ is=1e-14\n+ n=1.2"], commands: 0 });
  });

  it("reads every kind of line end", () => {
    expect(withoutCommands([{ text: ".param a=1\r\n.control\r\nquit\r\n.endc\r\n.ic v(x)=0" }])).toEqual({ texts: [".param a=1\n.ic v(x)=0"], commands: 1 });
    expect(withoutCommands([{ text: ".param a=1\r*#quit\r.ic v(x)=0" }])).toEqual({ texts: [".param a=1\n.ic v(x)=0"], commands: 1 });
  });

  it("leaves a circuit without commands as it is", () => {
    const lines = [text(".title KiCad schematic"), text(".include \"models.lib\""), text(".param a=1", "", ".ic v(x)=0"), item("R1 a 0 1k"), text(""), text(".end")];
    expect(withoutCommands(lines)).toEqual({ texts: lines.map((l) => l.text), commands: 0 });
  });

  it("hands on no line the simulator takes for a command, however they are mixed", () => {
    const pieces = [".control", ".CONTROLX", " .control", "*#quit", " *#quit", ".endc", "quit", "+ more", ".param a=1", "R1 a 0 1k", "* remark", ""];
    // every text of three pieces, as a text of the sheet and as a symbol's own line
    for (const a of pieces) for (const b of pieces) for (const c of pieces) {
      for (const kind of [undefined, "item"] as const) {
        const out = withoutCommands([{ text: [a, b, c].join("\n"), kind }, item("R2 a 0 2k")]);
        expect(linesOf(out.texts).filter(isCommand), [a, b, c].join(" | ")).toEqual([]);
        expect(out.texts[out.texts.length - 1]).toBe("R2 a 0 2k");
      }
    }
  });
});

describe("the circuit of a schematic that carries commands", () => {
  const two = (a: string, b: string) => ({ "1": { name: "~", node: a }, "2": { name: "~", node: b } });
  const sym = (ref: string, value: string): SchematicSymbol =>
    ({ ref, uuid: `uuid-${ref}`, libId: `Device:${ref[0]}`, value, sheet: "/", fields: { Value: value }, pins: two("+5V", "GND") });
  const symbols = [sym("R1", "1k"), sym("R2", "2k")];
  const netlistOf = (...texts: { text: string }[]) => readEditorNetlist({
    ok: true, messages: [],
    items: symbols.map((s) => ({ device: "R", name: s.ref, ref: s.ref, type: "" })),
    lines: [{ text: ".title KiCad schematic" }, ...texts, ...symbols.map((s) => ({ kind: "item", ref: s.ref, text: `${s.ref} +5V GND ${s.value}` })), { text: ".end" }],
  });
  const deckOf = (...texts: { text: string }[]) => {
    const netlist = netlistOf(...texts);
    const plan = matchSymbols({ parts: [] }, symbols, { kicadModels: kicadModels(netlist, symbols) });
    return buildDeck({ symbols, netlist, plan, parts: new Map(), live: true });
  };

  it("runs without them, and says how many there were", () => {
    const deck = deckOf(text(".param gain=2", ".control", "quit", ".endc"), text(".ic v(+5V)=0", "*#quit"));
    expect(deck.commandsLeftOut).toBe(2);
    expect(deck.errors).toEqual([]);
    expect(deck.deck.filter(isCommand)).toEqual([]);
    expect(deck.deck).not.toContain("quit");
    expect(deck.deck).not.toContain(".endc");
    // what defines the circuit is there, and so are the symbols' lines
    for (const line of [".title KiCad schematic", ".param gain=2", ".ic v(+5V)=0", "R1 +5V GND 1k", "R2 +5V GND 2k"]) expect(deck.deck, line).toContain(line);
    expect(deck.deck[deck.deck.length - 1]).toBe(".end");
  });

  it("is the same circuit as that of the schematic without them", () => {
    const clean = deckOf(text(".param gain=2"));
    const carried = deckOf(text(".param gain=2", ".control", "run", "quit"));
    expect(carried.deck).toEqual(clean.deck);
    expect(clean.commandsLeftOut).toBe(0);
    expect(carried.commandsLeftOut).toBe(1);
  });
});
