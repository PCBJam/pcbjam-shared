// A Value that says more than the value (src/sim-library/values.ts), and what the netlist
// step does with it.
import { describe, expect, it } from "vitest";
import {
  buildDeck, isRating, kicadModels, leftOutGroup, leftOutNotice, leftOutSentence, matchSymbols, plainValue, ratedValue, readEditorNetlist, unusableLines, valuesRead,
  type SchematicSymbol,
} from "../src/sim-library/index.js";

describe("a plain value", () => {
  it("is read in the notations KiCad reads, into what the simulator takes", () => {
    const read = (list: string[]): (string | null)[] => list.map(plainValue);
    expect(read(["100", "10k", "22uF", "100nF", "0.1uF", "4.7k", "100R", "0R", "10kΩ", "330ohm", "10uH"])).toEqual(["100", "10k", "22u", "100n", "0.1u", "4.7k", "100", "0", "10k", "330", "10u"]);
    // the letter in the decimal point's place
    expect(read(["4k7", "2R2", "0R1", "4u7F", "1n5", "4M7"])).toEqual(["4.7k", "2.2", "0.1", "4.7u", "1.5n", "4.7Meg"]);
    // a capital M is mega, a small one milli; both micro signs are "u"
    expect(read(["1M", "1Meg", "1MEG", "50m", "10µF", "10μF"])).toEqual(["1Meg", "1Meg", "1Meg", "50m", "10u", "10u"]);
    // a comma is the decimal point, unless exactly three digits follow it
    expect(read(["5,1K", "6,3", "3,300uF", "0,300", "1.500"])).toEqual(["5.1K", "6.3", "3300u", "0.300", "1.500"]);
  });

  it("is nothing else", () => {
    for (const text of ["", "R", "DNP", "25V", "1%", "10k/2", "1e3", ".5", "-1k", "{2*k}", "4.7k7", "1.2.3", "10kFF", "X7R", "k10", "10 k"]) expect([text, plainValue(text)]).toEqual([text, null]);
  });
});

describe("a rating", () => {
  it("is a voltage, a tolerance, a power, a current, a drift, a housing or a material", () => {
    for (const text of ["25V", "6.3V", "6,3V", "6V3", "1kV", "250VAC", "50v", "1%", "0.1%", "±5%", "+/-10%", "+-1%", "1W", "0.25W", "250mW", "1/4W", "2A", "500mA", "25ppm", "100ppm/K", "0603", "1206", "X7R", "x5r", "C0G", "NP0"])
      expect([text, isRating(text)]).toEqual([text, true]);
  });

  it("is not a value, a word or a number of its own", () => {
    for (const text of ["10k", "22uF", "100", "0603x", "DNP", "ceramic", "1000", "4", "W", "V", "%", "7R"]) expect([text, isRating(text)]).toEqual([text, false]);
  });
});

describe("a Value that says more than the value", () => {
  const read = (text: string): string => {
    const got = ratedValue(text);
    return got === null ? "not ours" : got === "unreadable" ? "unreadable" : `${got.value} [${got.shown}] ${got.ratings.join(" ")}`.trim();
  };

  it("is read when its first piece is a plain value and every other piece a known rating", () => {
    expect(read("22uF/25V")).toBe("22u [22uF] 25V");
    expect(read("10k 1%")).toBe("10k [10k] 1%");
    expect(read("100n 50V X7R")).toBe("100n [100n] 50V X7R");
    expect(read("4.7k 0603")).toBe("4.7k [4.7k] 0603");
    expect(read("0.1uF 100V")).toBe("0.1u [0.1uF] 100V");
    expect(read("330u/6,3V")).toBe("330u [330u] 6,3V");
    expect(read("4k7 1% 1/4W 0805")).toBe("4.7k [4k7] 1% 1/4W 0805");
    expect(read("1M/1%")).toBe("1Meg [1M] 1%");
    expect(read("10k, 1%, 0.25W")).toBe("10k [10k] 1% 0.25W");
    expect(read("10uH 2A")).toBe("10u [10uH] 2A");
    expect(read("100 1W")).toBe("100 [100] 1W");
    expect(read("10k +/-5%")).toBe("10k [10k] ±5%");
    expect(read("10k +/- 5%")).toBe("10k [10k] ±5%");
    expect(read("  22uF / 25V ")).toBe("22u [22uF] 25V");
  });

  it("reads a rating in brackets, which the simulator would take for the value", () => {
    expect(read("10k (1%)")).toBe("10k [10k] 1%");
    expect(read("100n (X7R, 50V)")).toBe("100n [100n] X7R 50V");
    expect(read("22uF [25V]")).toBe("22u [22uF] 25V");
    expect(read("10k (DNP)")).toBe("unreadable");
  });

  it("takes the fraction of a power as one rating, and never for the value", () => {
    expect(read("10k 1/4W")).toBe("10k [10k] 1/4W");
    expect(read("10k/1/4W")).toBe("10k [10k] 1/4W");
    expect(read("10k 1/4 W 5%")).toBe("10k [10k] 1/4W 5%");
    for (const text of ["1/4 W", "1/4W/5%", "1/4W 5%", "1/2W", "1/4"]) expect([text, read(text)]).toEqual([text, "unreadable"]);
  });

  it("does not read a value that can be meant in two ways on that kind of part", () => {
    const kind = (text: string, k: "R" | "C" | "L"): string => { const got = ratedValue(text, k); return got === null ? "not ours" : got === "unreadable" ? "unreadable" : got.value; };
    // a capacitor or a coil needs its multiplier or its unit: "47/63V" is 47 farad to the simulator
    expect(kind("47/63V", "C")).toBe("unreadable");
    expect(kind("100 50V", "C")).toBe("unreadable");
    expect(kind("10 2A", "L")).toBe("unreadable");
    expect(kind("10H 2A", "L")).toBe("10");
    expect(kind("100 1W", "R")).toBe("100");
    // an F behind the number is femto to KiCad and to the simulator
    expect(kind("1F/5.5V", "C")).toBe("unreadable");
    expect(kind("0.47F 5.5V", "C")).toBe("unreadable");
    expect(kind("1fF 50V", "C")).toBe("1f");
    expect(kind("47uF/63V", "C")).toBe("47u");
    // a capital P: peta to KiCad, pico to the simulator
    expect(kind("10PF 50V", "C")).toBe("unreadable");
    expect(kind("10pF 50V", "C")).toBe("10p");
    expect(plainValue("10PF")).toBeNull();
  });

  it("joins a unit that stands alone to its number", () => {
    expect(read("22 uF 25 V")).toBe("22u [22uF] 25V");
    expect(read("10 k 1 %")).toBe("10k [10k] 1%");
  });

  it("is not guessed at when a piece is not understood", () => {
    // two values, a rating alone, a rating first, a word, a part that is not fitted
    for (const text of ["10k/22k", "1/4W", "1/4W 10k", "25V 22uF", "100n ceramic", "10k DNP", "10k NTC", "22uF/25V/low ESR", "0603 10k", "10k 1% foo"]) expect([text, read(text)]).toEqual([text, "unreadable"]);
  });

  it("is not ours when it is one piece, or reads as a formula or as the simulator's parameters", () => {
    for (const text of ["", "22uF", "10k", "R", "DNP", "1e3", "22uF/", "{R1*2}", "'2*k'", "1u ic=0", "10k tc1=0.001", "1k*(1+V(ctl))", "(22uF)", "22 uF", "1 M"]) expect([text, read(text)]).toEqual([text, "not ours"]);
  });
});

// The netlist step. KiCad says of each line whether it read the Value as a plain value (its
// type is "") or hands it to the simulator as it is, as a formula (its type is "=").
describe("the circuit of a board whose values say their ratings", () => {
  const two = (a: string, b: string) => ({ "1": { name: "", node: a }, "2": { name: "", node: b } });
  const sym = (ref: string, value: string, fields: Record<string, string> = {}): SchematicSymbol =>
    ({ ref, uuid: `uuid-${ref}`, libId: `Device:${ref[0]}`, value, sheet: "/", fields: { Value: value, ...fields }, pins: two("+5V", "GND") });
  /** [the symbol, what KiCad wrote behind the two nodes, KiCad's type of the line] */
  const BOARD: [SchematicSymbol, string, string][] = [
    [sym("R1", "330"), "330", ""],
    [sym("C1", "22uF/25V"), "22uF/25V", "="],
    [sym("R2", "10k 1%"), "10k 1%", "="],
    [sym("C2", "0.1uF 50V"), "0.1uF 50V", "="],
    [sym("R3", "4k7 1%"), "4k7 1%", "="],
    // KiCad reads digits with a blank between them as one number
    [sym("R4", "100 0603"), "1000603", ""],
    [sym("R5", "1 000"), "1000", ""],
    // not understood, and not read by KiCad either
    [sym("R6", "10k/22k"), "10k/22k", "="],
    [sym("C3", "100n ceramic"), "100n ceramic", "="],
    [sym("R7", "10k DNP"), "10k DNP", "="],
    // the user's: a formula, the simulator's parameters, a model chosen on the symbol
    [sym("R8", "{2*k}"), "{2*k}", "="],
    [sym("C4", "1u ic=0"), "1u ic=0", "="],
    [sym("R9", "10k 1%", { "Sim.Device": "R" }), "10k 1%", "="],
    // a value the symbol gives in its field: KiCad takes it in place of the Value
    [sym("R10", "10k 1%", { "Sim.Params": 'r="220"' }), "220", ""],
    // a capacitor without multiplier and unit: 47 farad, or the 47 uF it was meant as
    [sym("C5", "47/63V"), "47/63V", "="],
  ];
  const symbols = BOARD.map(([s]) => s);
  const netlist = readEditorNetlist({
    ok: true, messages: [],
    items: BOARD.map(([s, , type]) => ({ device: s.ref[0], name: s.ref, ref: s.ref, type })),
    lines: [{ text: ".title KiCad schematic" }, ...BOARD.map(([s, tail]) => ({ kind: "item", ref: s.ref, text: `${s.ref} +5V GND ${tail}` })), { text: ".end" }],
  });
  const run = () => {
    const plan = matchSymbols({ parts: [] }, symbols, { kicadModels: kicadModels(netlist, symbols) });
    return buildDeck({ symbols, netlist, plan, parts: new Map(), live: false });
  };

  it("runs the value alone", () => {
    expect([...valuesRead(netlist, symbols).values()].map((v) => `${v.ref}: ${v.typed} -> ${v.value}`)).toEqual([
      "C1: 22uF/25V -> 22u", "R2: 10k 1% -> 10k", "C2: 0.1uF 50V -> 0.1u", "R3: 4k7 1% -> 4.7k", "R4: 100 0603 -> 100",
    ]);
    const deck = run();
    expect(deck.errors).toEqual([]);
    expect(deck.deck.filter((l) => /^[RCL]\d/.test(l))).toEqual([
      "R1 +5V GND 330", "C1 +5V GND 22u", "R2 +5V GND 10k", "C2 +5V GND 0.1u", "R3 +5V GND 4.7k", "R4 +5V GND 100", "R5 +5V GND 1000",
      "R8 +5V GND {2*k}", "C4 +5V GND 1u ic=0", "R9 +5V GND 10k 1%", "R10 +5V GND 220",
    ]);
    expect(deck.valuesRead.map((v) => `${v.ref} as ${v.shown} without ${v.ratings.join(" ")}`)).toEqual([
      "C1 as 22uF without 25V", "C2 as 0.1uF without 50V", "R2 as 10k without 1%", "R3 as 4k7 without 1%", "R4 as 100 without 0603",
    ]);
  });

  it("leaves out what it cannot read, as a symbol without a value, and says which", () => {
    expect([...unusableLines(netlist, symbols)].sort()).toEqual([["C3", "no-value"], ["C5", "no-value"], ["R6", "no-value"], ["R7", "no-value"]]);
    const deck = run();
    expect(deck.leftOut.map((s) => `${s.ref}: ${s.reason}`)).toEqual(["C3: no-value", "C5: no-value", "R6: no-value", "R7: no-value"]);
    expect(leftOutSentence(deck.leftOut[2]!)).toBe('R6: its Value "10k/22k" is not read as one value. Type the value alone (10k) and it runs.');
    expect(leftOutSentence(deck.leftOut[0]!)).toBe('C3: its Value "100n ceramic" is not read as one value. Type the value alone (100n) and it runs.');
    expect(leftOutSentence(deck.leftOut[1]!)).toBe('C5: its Value "47/63V" is not read as one value. Type the value alone (100n) and it runs.');
    expect(leftOutNotice(deck.leftOut)).toBe("4 symbols have no value (C3, C5, R6, R7): type their values and they run. The rest of the circuit runs.");
  });

  // KiCad wrote no line for any symbol: all of them are missing, and that is said
  it("says so when the only symbol with a model has no line", () => {
    const own = { "Sim.Device": "C", "Sim.Params": 'c=""', "Sim.Pins": "1=+ 2=-" };
    const board = [sym("C1", "22uF 10V", own)];
    const kicad = readEditorNetlist({ ok: true, messages: [], items: [{ device: "C", name: "C1", ref: "C1", type: "" }], lines: [{ text: ".title KiCad schematic" }, { text: ".end" }] });
    expect([...unusableLines(kicad, board)]).toEqual([["C1", "no-line"]]);
    const plan = matchSymbols({ parts: [] }, board, { kicadModels: kicadModels(kicad, board) });
    const deck = buildDeck({ symbols: board, netlist: kicad, plan, parts: new Map(), live: false });
    expect(deck.leftOut.map((s) => `${s.ref}: ${s.reason}${s.ownModel ? " (own model)" : ""}`)).toEqual(["C1: no-value (own model)"]);
  });

  // A library symbol that names its model itself and gives it no value: KiCad writes no line
  // for the symbol and says nothing, whatever its Value says.
  it("leaves out a capacitor whose own model has no value, and says that its Value is not used", () => {
    const own = { "Sim.Device": "C", "Sim.Params": 'c=""', "Sim.Pins": "1=+ 2=-" };
    const board = [sym("R1", "330"), sym("C1", "22uF 10V", own), sym("C2", "100n", own), sym("C3", "100n")];
    const kicad = readEditorNetlist({
      ok: true, messages: [],
      items: board.map((s) => ({ device: s.ref[0], name: s.ref, ref: s.ref, type: "" })),
      lines: [{ text: ".title KiCad schematic" }, { kind: "item", ref: "R1", text: "R1 +5V GND 330" }, { kind: "item", ref: "C3", text: "C3 +5V GND 100n" }, { text: ".end" }],
    });
    expect([...unusableLines(kicad, board)]).toEqual([["C1", "no-line"], ["C2", "no-line"]]);
    expect([...kicadModels(kicad, board)].sort()).toEqual(["C3", "R1"]);
    // a model the symbol names itself is not ours to read a rated Value for
    expect([...valuesRead(kicad, board)]).toEqual([]);
    const plan = matchSymbols({ parts: [] }, board, { kicadModels: kicadModels(kicad, board) });
    const deck = buildDeck({ symbols: board, netlist: kicad, plan, parts: new Map(), live: false });
    expect(deck.errors).toEqual([]);
    expect(deck.leftOut.map((s) => [s.ref, s.reason, s.ownModel])).toEqual([["C1", "no-value", true], ["C2", "no-value", true]]);
    expect(leftOutSentence(deck.leftOut[0]!)).toBe(
      'C1 is left out: its symbol names a simulation model of its own with no value in it (the fields Sim.Device and Sim.Params), and its Value "22uF 10V" is not used. Delete the two fields, and the Value runs.',
    );
    // a value typed on the symbol does not mend these: the notice and the group say so
    expect(leftOutNotice(deck.leftOut)).toBe("2 symbols name a simulation model of their own with no value in it (C1, C2): they are left out, and their Values are not used. The rest of the circuit runs.");
    expect(leftOutGroup("no-value", deck.leftOut).todo).toBe(
      "They name a simulation model of their own with no value in it (the fields Sim.Device and Sim.Params on the symbol): KiCad leaves them out, and the Value is not used. Delete the two fields, and the Value runs.",
    );
    const mixed = [...deck.leftOut, { ...deck.leftOut[0]!, ref: "R9", value: "R", ownModel: undefined }];
    expect(leftOutGroup("no-value", mixed).todo).toBe(
      "Type the value on the symbol (10k, 100n), then it runs. C1, C2 name a simulation model of their own with no value in it (the fields Sim.Device and Sim.Params on the symbol): KiCad leaves them out, and the Value is not used. Delete the two fields, and the Value runs.",
    );
    expect(leftOutNotice(mixed)).toBe(
      "1 symbol has no value (R9): type its value and it runs. 2 symbols name a simulation model of their own with no value in it (C1, C2): they are left out, and their Values are not used. The rest of the circuit runs.",
    );
    expect(leftOutGroup("no-value").todo).toBe("Type the value on the symbol (10k, 100n), then it runs.");
    // a caller that has the items and no lines says nothing about them
    expect([...unusableLines({ items: kicad.items, lines: [] }, board)]).toEqual([]);
  });

  it("says nothing without the symbols' values: an older caller reads as before", () => {
    const bare = symbols.map(({ ref, fields }) => ({ ref, fields }));
    expect([...valuesRead(netlist, bare)]).toEqual([]);
    expect([...unusableLines(netlist, bare)]).toEqual([]);
  });
});
