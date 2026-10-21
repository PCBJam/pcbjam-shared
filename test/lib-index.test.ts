import { describe, expect, it } from "vitest";
import {
  buildLibIndex,
  countStackedPinNotation,
  countUniquePads,
  decodeLibIndexTsv,
  encodeLibIndexTsv,
  indexFootprintItem,
  indexSymbolItem,
  indexSymbolLibrary,
  resolveSymbolRows,
  type SymbolIndexRow,
} from "../src/lib-index.js";

const prop = (name: string, value: string) =>
  `(property "${name}" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))`;
const pin = (num: string) =>
  `(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "${num}" (effects (font (size 1.27 1.27)))))`;
const lib = (...symbols: string[]) =>
  `(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")\n${symbols.join("\n")}\n)`;

const R = `(symbol "R" (pin_numbers (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  ${prop("Reference", "R")} ${prop("Value", "R")} ${prop("Footprint", "")} ${prop("Datasheet", "~")}
  ${prop("Description", "Resistor")} ${prop("ki_keywords", "R res resistor")} ${prop("ki_fp_filters", "R_*")}
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
  (symbol "R_1_1" ${pin("1")} ${pin("2")})
  (embedded_fonts no))`;

describe("indexSymbolItem", () => {
  it("Device:R", () => {
    expect(indexSymbolItem("R", lib(R))).toEqual({
      n: "R",
      r: "R",
      ds: "~",
      d: "Resistor",
      k: "R res resistor",
      f: "R_*",
      gp: 2,
      pc: 2,
    });
  });

  it("multi-unit symbol with unit names and a De Morgan body style", () => {
    const sym = `(symbol "7400" ${prop("Reference", "U")} ${prop("Value", "7400")}
      (symbol "7400_1_1" (unit_name "Gate A") ${pin("1")} ${pin("2")} ${pin("3")})
      (symbol "7400_1_2" ${pin("1")} ${pin("2")} ${pin("3")})
      (symbol "7400_2_1" ${pin("4")} ${pin("5")} ${pin("6")})
      (symbol "7400_5_0" ${pin("7")} ${pin("14")}))`;
    const row = indexSymbolItem("7400", lib(sym))!;
    expect(row.u).toBe(5);
    expect(row.un).toEqual({ "1": "Gate A" });
    // body style 2 is left out, body style 0 counts
    expect(row.gp).toBe(8);
  });

  it("global and local power", () => {
    const g = `(symbol "GND" (power) ${prop("Value", "GND")} (symbol "GND_0_1" ${pin("1")}))`;
    const l = `(symbol "LGND" (power local) ${prop("Value", "LGND")})`;
    expect(indexSymbolItem("GND", lib(g))!.pw).toBe(1);
    expect(indexSymbolItem("LGND", lib(l))!.pw).toBe(2);
    expect(indexSymbolItem("R", lib(R))!.pw).toBeUndefined();
  });

  it("derived symbol: own row from a body that bundles the parent", () => {
    const child = `(symbol "R_Small" (extends "R") ${prop("Value", "R_Small")} ${prop("Description", "")})`;
    const row = indexSymbolItem("R_Small", lib(R, child))!;
    expect(row).toEqual({ n: "R_Small", x: "R" });
  });

  it("flags text variables", () => {
    const sym = `(symbol "V" ${prop("Value", "$" + "{SIM.PARAMS}")} ${prop("Sim.Library", "x")})`;
    expect(indexSymbolItem("V", lib(sym))!.tv).toBe(1);
    expect(indexSymbolItem("R", lib(R))!.tv).toBeUndefined();
  });

  it("stacked pin numbers", () => {
    const sym = `(symbol "S" ${prop("Value", "S")} (symbol "S_1_1" ${pin("[1-4]")} ${pin("[A1,A3-A5]")} ${pin("9")}))`;
    const row = indexSymbolItem("S", lib(sym))!;
    expect(row.gp).toBe(3);
    expect(row.pc).toBe(4 + 4 + 1);
  });

  it("user fields, duplicates, private and escapes", () => {
    const sym = `(symbol "U1" ${prop("Value", "LM358")} ${prop("LCSC", "C123456")} ${prop("LCSC", "C9")}
      (property private "Note" "a \\"quoted\\"\\nline" (at 0 0 0))
      ${prop("ki_locked", "")})`;
    const row = indexSymbolItem("U1", lib(sym))!;
    expect(row.v).toBe("LM358");
    expect(row.fl).toEqual({ LCSC: "C123456", LCSC_1: "C9", Note: 'a "quoted"\nline' });
  });

  it("missing and empty Value", () => {
    expect(indexSymbolItem("A", lib(`(symbol "A")`))!.v).toBe("");
    expect(indexSymbolItem("A", lib(`(symbol "A" ${prop("Value", "")})`))!.v).toBe("");
    expect(indexSymbolItem("A", lib(`(symbol "A" ${prop("Value", "A")})`))!.v).toBeUndefined();
  });

  it("legacy ~ value and ki_description", () => {
    const body = `(kicad_symbol_lib (version 20231120) (symbol "B" ${prop("Value", "B")} ${prop("Datasheet", "~")} ${prop("ki_description", "old")}))`;
    const row = indexSymbolItem("B", body)!;
    expect(row.ds).toBeUndefined();
    expect(row.d).toBe("old");
  });

  it("{slash} in names", () => {
    const sym = `(symbol "A{slash}B" ${prop("Value", "A/B")} (symbol "A{slash}B_1_1" ${pin("1")}))`;
    expect(indexSymbolItem("A/B", lib(sym))).toEqual({ n: "A/B", gp: 1, pc: 1 });
  });

  it("a body that won't parse or doesn't hold the symbol", () => {
    expect(indexSymbolItem("R", "(kicad_symbol_lib (symbol")).toBeNull();
    expect(indexSymbolItem("X", lib(R, `(symbol "Y")`))).toBeNull();
  });

  it("whole library", () => {
    expect(indexSymbolLibrary(lib(R, `(symbol "C")`)).map((r) => r.n)).toEqual(["R", "C"]);
  });
});

describe("countStackedPinNotation", () => {
  it("matches KiCad", () => {
    expect(countStackedPinNotation("1")).toBe(1);
    expect(countStackedPinNotation("[1,2,3]")).toBe(3);
    expect(countStackedPinNotation("[1-10]")).toBe(10);
    expect(countStackedPinNotation("[A1-B2]")).toBe(1); // prefix mismatch
    expect(countStackedPinNotation("[5-1]")).toBe(1);
    expect(countStackedPinNotation("[,]")).toBe(1);
    expect(countStackedPinNotation("[1, 3 - 4]")).toBe(3);
  });
});

describe("resolveSymbolRows", () => {
  it("units, pins and power come from the root; text stays own", () => {
    const rows: SymbolIndexRow[] = [
      { n: "Root", d: "root d", k: "rk", u: 2, un: { "1": "A" }, gp: 4, pc: 4, pw: 1 },
      { n: "Mid", x: "Root", gp: 9 },
      { n: "Leaf", x: "Mid", d: "" },
      { n: "Orphan", x: "Missing", gp: 1 },
    ];
    const out = resolveSymbolRows(rows);
    expect(out[1]).toEqual({ n: "Mid", x: "Root", u: 2, un: { "1": "A" }, gp: 4, pc: 4, pw: 1 });
    expect(out[2]).toEqual({ n: "Leaf", x: "Mid", d: "", u: 2, un: { "1": "A" }, gp: 4, pc: 4, pw: 1 });
    expect(out[3]).toBe(rows[3]);
    expect(out[0]).toBe(rows[0]);
  });

  it("survives a cycle", () => {
    const out = resolveSymbolRows([{ n: "A", x: "B" }, { n: "B", x: "A" }]);
    expect(out).toEqual([{ n: "A", x: "B" }, { n: "B", x: "A" }]);
  });
});

const fp = (pads: string, extra = "") =>
  `(footprint "X" (version 20241229) (generator "pcbnew") (layer "F.Cu") (descr "A part") (tags "res smd")
    (property "Reference" "REF**" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "X" (at 0 0 0) (layer "F.Fab"))
    ${extra}
    ${pads})`;
const pad = (num: string, type: string, layers: string) =>
  `(pad "${num}" ${type} rect (at 0 0) (size 1 1) (layers ${layers}))`;

describe("footprints", () => {
  it("pad counts follow KiCad", () => {
    const body = fp(
      [
        pad("1", "smd", `"F.Cu" "F.Paste" "F.Mask"`),
        pad("2", "smd", `"F.Cu" "F.Paste" "F.Mask"`),
        pad("2", "smd", `"F.Cu"`), // duplicate number
        pad("", "smd", `"F.Cu"`), // unnumbered
        pad("3", "smd", `"F.Paste"`), // not on copper
        pad("", "np_thru_hole", `"*.Cu" "*.Mask"`), // NPTH
        pad("4", "thru_hole", `"*.Cu" "*.Mask"`),
      ].join("\n"),
    );
    expect(countUniquePads(body)).toBe(3);
    expect(indexFootprintItem("X", body)).toEqual({ n: "X", d: "A part", t: "res smd", pc: 6, up: 3 });
  });

  it("properties except Reference and Value", () => {
    const body = fp(pad("1", "smd", `"F.Cu"`), `(property "LCSC" "C25744" (at 0 0 0) (layer "F.Fab"))`);
    expect(indexFootprintItem("X", body)!.fl).toEqual({ LCSC: "C25744" });
  });

  it("legacy module and bare pad numbers", () => {
    const body = `(module R_0402 (layer F.Cu) (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Paste)) (pad 2 smd rect (at 1 0) (size 1 1) (layers F.Cu)))`;
    expect(indexFootprintItem("R_0402", body)).toEqual({ n: "R_0402", pc: 2, up: 2 });
  });

  it("a body that won't parse", () => {
    expect(indexFootprintItem("X", "(footprint")).toBeNull();
    expect(indexFootprintItem("X", "(kicad_pcb)")).toBeNull();
    expect(() => countUniquePads("(kicad_pcb)")).toThrow();
  });
});

describe("buildLibIndex", () => {
  it("keeps its kind, sorts, and lists bad bodies", () => {
    const { rows, bad } = buildLibIndex("symbol", [
      ["symbol/R", lib(R)],
      ["symbol/Broken", "(("],
      ["footprint/X", fp("")],
      ["symbol/C", lib(`(symbol "C" ${prop("Value", "C")})`)],
    ]);
    expect(rows.map((r) => r.p)).toEqual(["symbol/C", "symbol/R"]);
    expect(bad).toEqual(["symbol/Broken"]);
  });

  it("footprints", () => {
    const { rows, bad } = buildLibIndex("footprint", [["footprint/X", fp(pad("1", "smd", `"F.Cu"`))]]);
    expect(rows).toEqual([{ p: "footprint/X", n: "X", d: "A part", t: "res smd", pc: 1, up: 1 }]);
    expect(bad).toEqual([]);
  });
});

describe("TSV codec", () => {
  it("round-trips every column and awkward text", () => {
    const rows: SymbolIndexRow[] = [
      { n: "R", d: "Resistor", k: "R res", f: "R_*", gp: 2, pc: 2, r: "R", ds: "~" },
      { n: "A\tB", x: "R", v: "", tv: 1, pw: 2 },
      {
        n: "U",
        v: "LM358",
        u: 3,
        un: { "1": "A=B", "2": "x\x1fy" },
        fl: { "L=CSC": "C1\\2\n3", Empty: "" },
        fp: "Pkg:SO-8",
      },
    ];
    const tsv = encodeLibIndexTsv("tok\t1", rows);
    expect(tsv.split("\n")[0]).toBe("v=tok\\t1\tschema=1\tkind=symbol");
    expect(tsv.split("\n")).toHaveLength(rows.length + 2);
    const back = decodeLibIndexTsv(tsv);
    expect(back.token).toBe("tok\t1");
    expect(back.rows).toEqual(rows);
  });

  it("pages", () => {
    const rows: SymbolIndexRow[] = ["A", "B", "C", "D", "E"].map((n) => ({ n }));
    const tsv = encodeLibIndexTsv("t", rows, { from: 2, size: 2 });
    expect(tsv.split("\n")[0]).toBe("v=t\tschema=1\tkind=symbol\tfrom=2\ttotal=5");
    expect(decodeLibIndexTsv(tsv)).toEqual({ token: "t", rows: [{ n: "C" }, { n: "D" }], page: { from: 2, total: 5 } });
    expect(decodeLibIndexTsv(encodeLibIndexTsv("t", rows, { from: 4, size: 2 })).rows).toEqual([{ n: "E" }]);
  });

  it("an empty library", () => {
    expect(decodeLibIndexTsv(encodeLibIndexTsv("t", []))).toEqual({ token: "t", rows: [] });
  });
});
