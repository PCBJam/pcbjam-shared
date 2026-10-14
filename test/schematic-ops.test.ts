import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docToFile, fileToDoc, sexprToItems, type KicadDoc } from "../src/kicad-doc.js";
import { parseSexpr } from "../src/sexpr.js";
import { fmt } from "../src/schematic-geometry.js";
import {
  applySchematicEdit,
  connectEdit,
  listParts,
  movePartEdit,
  netJoinTargets,
  parseNetlist,
  placementBlob,
  placePartEdit,
  readSheet,
  removePartEdit,
  resolveNetJoins,
  SchematicOpError,
  setFieldEdit,
  type NetlistNet,
  type SchematicEdit,
} from "../src/schematic-ops.js";
import { isForm, resolveSymbolDefinition, unquote, type Form } from "../src/symbol-lib.js";
import { FIXTURES } from "./helpers.js";

// Synthetic sheets written for these tests (no KiCad library or demo content).
const F = "(effects (font (size 1.27 1.27)))";
const HIDE = "(effects (font (size 1.27 1.27)) (hide yes))";
const ROOT = "11111111-1111-4111-8111-111111111111";

const DEF_R = `(symbol "Test:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) ${F}) (property "Value" "R" (at 0 0 90) ${F})
  (property "Footprint" "" (at -1.778 0 90) ${HIDE}) (property "Datasheet" "~" (at 0 0 0) ${HIDE})
  (property "ki_keywords" "resistor" (at 0 0 0) ${HIDE})
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${F}) (number "1" ${F}))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${F}) (number "2" ${F}))))`;

const DEF_Q = `(symbol "Test:Q" (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "Q" (at 0 3.81 0) ${F}) (property "Value" "Q" (at 0 -3.81 0) ${F})
  (property "Footprint" "" (at 0 0 0) ${HIDE}) (property "Datasheet" "" (at 0 0 0) ${HIDE})
  (symbol "Q_0_1" (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "Q_1_1"
    (pin passive line (at -5.08 0 0) (length 2.54) (name "A" ${F}) (number "1" ${F}))
    (pin passive line (at 2.54 5.08 270) (length 2.54) (name "B" ${F}) (number "2" ${F}))
    (pin passive line (at 5.08 -2.54 180) (length 2.54) (name "C" ${F}) (number "3" ${F}))))`;

const powerDef = (libId: string, value: string, pinAngle: number) => `(symbol "${libId}" (power) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -3.81 0) ${HIDE}) (property "Value" "${value}" (at 0 3.556 0) ${F})
  (property "Footprint" "" (at 0 0 0) ${HIDE}) (property "Datasheet" "" (at 0 0 0) ${HIDE})
  (symbol "${value}_0_1" (polyline (pts (xy 0 0) (xy 0 ${pinAngle === 90 ? "2.54" : "-2.54"})) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "${value}_1_1" (pin power_in line (at 0 0 ${pinAngle}) (length 0) (hide yes) (name "${value}" ${F}) (number "1" ${F}))))`;
const DEF_3V3 = powerDef("power:+3V3", "+3V3", 90);
const DEF_GND = powerDef("power:GND", "GND", 270);

let seq = 0;
const id = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function placed(libId: string, ref: string, x: number, y: number, opts: { angle?: number; value?: string; pins: string[] }): { uuid: string; text: string } {
  const uuid = id();
  return {
    uuid,
    text: `(symbol (lib_id "${libId}") (at ${fmt(x)} ${fmt(y)} ${opts.angle ?? 0}) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}")
      (property "Reference" "${ref}" (at ${fmt(x + 2.54)} ${fmt(y)} 0) ${ref.startsWith("#") ? HIDE : F}) (property "Value" "${opts.value ?? ref}" (at ${fmt(x + 5.08)} ${fmt(y)} 0) ${F})
      (property "Footprint" "" (at ${fmt(x)} ${fmt(y)} 0) ${HIDE}) (property "Datasheet" "~" (at ${fmt(x)} ${fmt(y)} 0) ${HIDE})
      ${opts.pins.map((n) => `(pin "${n}" (uuid "${id()}"))`).join(" ")}
      (instances (project "fixture" (path "/${ROOT}" (reference "${ref}") (unit 1)))))`,
  };
}
const wire = (a: [number, number], b: [number, number]) => {
  const uuid = id();
  return { uuid, text: `(wire (pts (xy ${fmt(a[0])} ${fmt(a[1])}) (xy ${fmt(b[0])} ${fmt(b[1])})) (stroke (width 0) (type default)) (uuid "${uuid}"))` };
};
const label = (name: string, at: [number, number], angle = 0) => {
  const uuid = id();
  return { uuid, text: `(label "${name}" (at ${fmt(at[0])} ${fmt(at[1])} ${angle}) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${uuid}"))` };
};
const junction = (at: [number, number]) => {
  const uuid = id();
  return { uuid, text: `(junction (at ${fmt(at[0])} ${fmt(at[1])}) (diameter 0) (color 0 0 0 0) (uuid "${uuid}"))` };
};
const sheetText = (items: string[], defs = [DEF_R, DEF_Q, DEF_3V3, DEF_GND]) =>
  `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "${ROOT}") (paper "A4") (lib_symbols ${defs.join(" ")}) ${items.join(" ")} (sheet_instances (path "/" (page "1"))))`;

/**
 * R1 (0°) at 50.8,50.8: +3V3 power symbol on pin 1 (50.8,46.99), label SDA on
 * pin 2 (50.8,54.61). R2 (90°) at 76.2,50.8: pin 1 (72.39,50.8) runs to label
 * MID; pin 2 (80.01,50.8) runs right, bends down to a junction that branches
 * to labels OUT and OUT2. Q1 at 101.6,50.8. R3/R4 joined pin to pin by one
 * wire; R5's pin 1 wire ends on the middle of another wire.
 */
function fixture() {
  const r1 = placed("Test:R", "R1", 50.8, 50.8, { pins: ["1", "2"], value: "10k" });
  const pwr = placed("power:+3V3", "#PWR01", 50.8, 46.99, { pins: ["1"], value: "+3V3" });
  const sda = label("SDA", [50.8, 54.61], 270);
  const r2 = placed("Test:R", "R2", 76.2, 50.8, { angle: 90, pins: ["1", "2"] });
  const w5 = wire([72.39, 50.8], [66.04, 50.8]);
  const mid = label("MID", [66.04, 50.8], 180);
  const w1 = wire([80.01, 50.8], [88.9, 50.8]);
  const w2 = wire([88.9, 50.8], [88.9, 60.96]);
  const j1 = junction([88.9, 60.96]);
  const w3 = wire([88.9, 60.96], [83.82, 60.96]);
  const out = label("OUT", [83.82, 60.96], 180);
  const w4 = wire([88.9, 60.96], [96.52, 60.96]);
  const out2 = label("OUT2", [96.52, 60.96]);
  const q1 = placed("Test:Q", "Q1", 101.6, 50.8, { pins: ["1", "2", "3"] });
  const r3 = placed("Test:R", "R3", 50.8, 88.9, { pins: ["1", "2"] });
  const r4 = placed("Test:R", "R4", 63.5, 88.9, { pins: ["1", "2"] });
  const w7 = wire([50.8, 92.71], [63.5, 92.71]);
  const w8 = wire([63.5, 99.06], [76.2, 99.06]);
  const r5 = placed("Test:R", "R5", 69.85, 107.95, { pins: ["1", "2"] });
  const w9 = wire([69.85, 104.14], [69.85, 99.06]);
  const all = { r1, pwr, sda, r2, w5, mid, w1, w2, j1, w3, out, w4, out2, q1, r3, r4, w7, w8, r5, w9 };
  return { doc: fileToDoc(sheetText(Object.values(all).map((x) => x.text))), ...all };
}

/** The forms an edit upserts, parsed (every one must parse as a KiCad item). */
function upserted(edit: SchematicEdit): Form[] {
  return edit.upsert.map(({ sexpr }) => {
    expect(() => sexprToItems(sexpr)).not.toThrow();
    return parseSexpr(sexpr)[0] as Form;
  });
}
const ofType = (forms: Form[], type: string) => forms.filter((f) => f[0] === type);
const atOfForm = (f: Form) => (f.find((n) => isForm(n, "at")) as string[]).slice(1).map(Number);
const prop = (f: Form, name: string) => unquote((f.find((n) => isForm(n, "property") && unquote(n[1]) === name) as Form | undefined)?.[2]);

/** Apply, write the file, read it back: the round trip a room or the editor does. */
function roundTrip(doc: KicadDoc, edit: SchematicEdit): KicadDoc {
  return fileToDoc(docToFile(applySchematicEdit(doc, edit)));
}

function errorOf(fn: () => unknown): SchematicOpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SchematicOpError);
    return error as SchematicOpError;
  }
  throw new Error("expected a SchematicOpError");
}

describe("listParts", () => {
  it("lists parts with pins in sheet coordinates, power symbols left out", () => {
    const { doc } = fixture();
    const parts = listParts(doc);
    expect(parts.map((p) => p.ref)).toEqual(["Q1", "R1", "R2", "R3", "R4", "R5"]);
    const r2 = parts.find((p) => p.ref === "R2")!;
    expect(r2).toMatchObject({ libId: "Test:R", angle: 90, at: [76.2, 50.8] });
    expect(r2.pins).toEqual([
      { number: "1", name: "~", at: [72.39, 50.8] },
      { number: "2", name: "~", at: [80.01, 50.8] },
    ]);
    expect(listParts(doc, { includePower: true }).find((p) => p.ref === "#PWR01")?.power).toBe(true);
  });

  it("filters by reference, value or library", () => {
    const { doc } = fixture();
    expect(listParts(doc, { filter: "10k" }).map((p) => p.ref)).toEqual(["R1"]);
    expect(listParts(doc, { filter: "test:q" }).map((p) => p.ref)).toEqual(["Q1"]);
  });

  it("reads a real KiCad sheet", () => {
    const doc = fileToDoc(readFileSync(path.join(FIXTURES, "rectifier.kicad_sch"), "utf8"));
    const parts = listParts(doc);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.pins.length > 0)).toBe(true);
  });

  it("refuses a board", () => {
    expect(errorOf(() => listParts(fileToDoc("(kicad_pcb (version 1))"))).code).toBe("INVALID");
  });
});

describe("placePartEdit", () => {
  it("places with the next reference in a free spot and connects nets in the same edit", () => {
    const { doc } = fixture();
    const { edit, placed: [r] } = placePartEdit({ doc, parts: [{ libId: "Test:R", value: "4.7k", footprint: "R_0603", nets: { "1": "+3V3", "2": "SCL" } }] });
    expect(r!.ref).toBe("R6");
    expect(r!.connected).toEqual([
      { pin: "R6.1", net: "+3V3", how: "power" },
      { pin: "R6.2", net: "SCL", how: "label" },
    ]);
    expect(edit.libSymbols).toEqual({}); // Test:R and power:+3V3 are embedded already
    const forms = upserted(edit);
    const [part, power] = ofType(forms, "symbol");
    expect(prop(part!, "Value")).toBe("4.7k");
    expect(prop(part!, "Footprint")).toBe("R_0603");
    expect(prop(part!, "ki_keywords")).toBeUndefined();
    expect(prop(power!, "Reference")).toBe("#PWR02");
    // The power symbol sits on pin 1's end; the label on pin 2's, pointing down (away from the body).
    expect(atOfForm(power!)).toEqual([...r!.pins[0]!.at, 0]);
    const [lbl] = ofType(forms, "label");
    expect(atOfForm(lbl!)).toEqual([...r!.pins[1]!.at, 270]);

    const after = roundTrip(doc, edit);
    const sheet = readSheet(after);
    const placedR = sheet.symbols.find((s) => s.ref === "R6")!;
    expect(placedR.value).toBe("4.7k");
    expect(sheet.labels.some((l) => l.name === "SCL" && l.at[0] === placedR.pins[1]!.at[0] && l.at[1] === placedR.pins[1]!.at[1])).toBe(true);
  });

  it("never lands on existing content, and keeps several parts of one request apart", () => {
    const { doc } = fixture();
    const { placed: parts } = placePartEdit({ doc, parts: [{ libId: "Test:R" }, { libId: "Test:R" }, { libId: "Test:Q", near: "Q1" }] });
    expect(parts.map((p) => p.ref)).toEqual(["R6", "R7", "Q2"]);
    const existing = listParts(doc, { includePower: true });
    const points = [...existing.flatMap((p) => p.pins.map((q) => q.at)), ...existing.map((p) => p.at)];
    for (const p of parts) {
      for (const q of p.pins) expect(points.some((e) => e[0] === q.at[0] && e[1] === q.at[1])).toBe(false);
    }
    expect(new Set(parts.map((p) => `${p.at}`)).size).toBe(3);
    const q2 = parts[2]!;
    expect(Math.hypot(q2.at[0] - 101.6, q2.at[1] - 50.8)).toBeLessThan(30);
  });

  it("snaps an asked position to the grid", () => {
    const { doc } = fixture();
    expect(placePartEdit({ doc, parts: [{ libId: "Test:R", at: [130.1, 70.2] }] }).placed[0]!.at).toEqual([129.54, 69.85]);
  });

  it("embeds a library definition the sheet lacks", () => {
    const { doc } = fixture();
    const lib = readFileSync("plugin-platform/examples/sample-symbols.kicad_sym", "utf8");
    const def = resolveSymbolDefinition(lib, "PluginResistor_10k");
    const { edit } = placePartEdit({ doc, parts: [{ libId: "Plugin:PluginResistor_10k", def }] });
    expect(Object.keys(edit.libSymbols)).toEqual(["Plugin:PluginResistor_10k"]);
    expect(edit.libSymbols["Plugin:PluginResistor_10k"]).toMatch(/^\(symbol "Plugin:PluginResistor_10k" /);
    const after = roundTrip(doc, edit);
    expect(readSheet(after).defs.has("Plugin:PluginResistor_10k")).toBe(true);
    expect(listParts(after, { filter: "Plugin:" })[0]?.pins).toHaveLength(2);
  });

  it("asks for the definition when the sheet does not have it", () => {
    const { doc } = fixture();
    expect(errorOf(() => placePartEdit({ doc, parts: [{ libId: "Device:C" }] })).code).toBe("NO_DEFINITION");
    expect(errorOf(() => placePartEdit({ doc, parts: [{ libId: "R" }] })).code).toBe("INVALID");
  });
});

describe("placementBlob", () => {
  it("is the click-placement text with the asked value and footprint", () => {
    const def = parseSexpr(DEF_R.replace('"Test:R"', '"R"'))[0] as Form;
    const { sexpr } = placementBlob({ def, libId: "Test:R", value: '10"k', footprint: "R_0603", uuid: id() });
    expect(sexpr).toContain('(property "Reference" "R?"');
    expect(sexpr).toContain('(property "Value" "10\\"k"');
    expect(sexpr).toContain('(property "Footprint" "R_0603"');
  });
});

describe("connectEdit", () => {
  it("puts a label on the pin end, pointing away from the body", () => {
    const { doc } = fixture();
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: "SDA" }, { ref: "q1", pin: "C", net: "SCL" }] });
    expect(connected).toEqual([
      { pin: "Q1.1", net: "SDA", how: "label" },
      { pin: "Q1.3", net: "SCL", how: "label" },
    ]);
    const labels = ofType(upserted(edit), "label");
    expect(atOfForm(labels[0]!)).toEqual([96.52, 50.8, 180]); // left pin: text runs left
    expect(labels[0]!.find((n) => isForm(n, "effects"))).toContainEqual(["justify", "right", "bottom"]);
    expect(atOfForm(labels[1]!)).toEqual([106.68, 53.34, 0]);
  });

  it("uses a power symbol for power nets, embedding a given definition", () => {
    const { doc } = fixture();
    const def5v = parseSexpr(powerDef("power:+5V", "+5V", 90).replace('"power:+5V"', '"+5V"'))[0] as Form;
    const { edit, connected } = connectEdit({
      doc,
      pins: [{ ref: "Q1", pin: "2", net: "GND" }, { ref: "R4", pin: "1", net: "+5V" }],
      powerDefs: { "+5V": { libId: "power:+5V", def: def5v } },
    });
    expect(connected.map((c) => c.how)).toEqual(["power", "power"]);
    expect(Object.keys(edit.libSymbols)).toEqual(["power:+5V"]);
    const [gnd] = ofType(upserted(edit), "symbol");
    // Q1.2 is a top pin: GND's body (drawn below its pin) turns to point up, away from Q1.
    expect(atOfForm(gnd!)).toEqual([104.14, 45.72, 180]);
  });

  it("falls back to a global label for a power net it has no symbol for", () => {
    const { doc } = fixture();
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: "+12V" }] });
    expect(connected[0]!.how).toBe("global_label");
    expect(ofType(upserted(edit), "global_label")).toHaveLength(1);
  });

  it("sets no-connect flags, sees what is there already, and disconnects", () => {
    const { doc, sda } = fixture();
    const nc = connectEdit({ doc, pins: [{ ref: "Q1", pin: "3", noConnect: true }] });
    expect(atOfForm(ofType(upserted(nc.edit), "no_connect")[0]!)).toEqual([106.68, 53.34]);
    const again = connectEdit({ doc, pins: [{ ref: "R1", pin: "2", net: "SDA" }] });
    expect(again.connected[0]!.how).toBe("already");
    expect(again.edit.upsert).toEqual([]);
    const off = connectEdit({ doc, pins: [{ ref: "R1", pin: "2", net: null }] });
    expect(off.edit.remove).toEqual([sda.uuid]);
  });

  it("keeps outside text an atom: quotes and backslashes escaped, control characters dropped", () => {
    const { doc } = fixture();
    const { edit } = connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: 'A"B\\C\n) (junction' }] });
    const [lbl] = ofType(upserted(edit), "label");
    expect(unquote(lbl![1])).toBe('A"B\\C) (junction');
    expect(edit.upsert[0]!.sexpr).not.toContain("\n");
    expect(errorOf(() => connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: "\n " }] })).code).toBe("INVALID");
  });

  it("says which parts and pins exist when asked for a wrong one", () => {
    const { doc } = fixture();
    const missing = errorOf(() => connectEdit({ doc, pins: [{ ref: "R99", pin: "1", net: "X" }] }));
    expect(missing.code).toBe("NOT_FOUND");
    expect(missing.message).toContain("R1, R2");
    const pin = errorOf(() => connectEdit({ doc, pins: [{ ref: "Q1", pin: "9", net: "X" }] }));
    expect(pin.code).toBe("NO_PIN");
    expect(pin.message).toContain("1 (A), 2 (B), 3 (C)");
  });
});

describe("resolveNetJoins", () => {
  // KiCad's netlist of fixture(): R3.2 and R4.2 share a wire no label names.
  const nets: NetlistNet[] = [
    { net: "+3V3", pins: [{ ref: "R1", pin: "1" }] },
    { net: "/SDA", pins: [{ ref: "R1", pin: "2" }] },
    { net: "Net-(R3-Pad2)", pins: [{ ref: "R3", pin: "2" }, { ref: "R4", pin: "2" }] },
    { net: "unconnected-(Q1-A-Pad1)", pins: [{ ref: "Q1", pin: "1", name: "A" }] },
  ];

  it("needs the netlist only for pins and KiCad's automatic names", () => {
    const { doc } = fixture();
    expect(netJoinTargets(doc, ["SDA", "+3V3", "R3.2", " Net-(R3-Pad2) ", "X9.1", null, undefined])).toEqual(["R3.2", "Net-(R3-Pad2)"]);
    expect(netJoinTargets(doc, ["SDA", "GND"])).toEqual([]);
  });

  it("joins a named net by its name and names an unnamed one after a pin, labelling that pin too", () => {
    const { doc } = fixture();
    const joins = resolveNetJoins(doc, ["R1.2", "Net-(R3-Pad2)", "R4.2", "Q1.A", "/SDA", "GND"], nets);
    expect(["R1.2", "Net-(R3-Pad2)", "R4.2", "Q1.A", "/SDA", "GND"].map((s) => joins.name(s))).toEqual(["SDA", "R3_2", "R3_2", "Q1_1", "SDA", "GND"]);
    expect(joins.anchors).toEqual([
      { ref: "R3", pin: "2", net: "R3_2" },
      { ref: "Q1", pin: "1", net: "Q1_1" },
    ]);
    expect(joins.joined).toEqual([
      { asked: "R1.2", net: "SDA" },
      { asked: "Net-(R3-Pad2)", net: "R3_2", labelled: "R3.2" },
      { asked: "R4.2", net: "R3_2" },
      { asked: "Q1.A", net: "Q1_1", labelled: "Q1.1" },
    ]);

    // Connecting R2.1 there puts one label on each end of the join, in one edit.
    const { edit } = connectEdit({ doc, pins: [{ ref: "R2", pin: "1", net: joins.name("R4.2") }, ...joins.anchors.slice(0, 1)] });
    expect(ofType(upserted(edit), "label").map((l) => unquote(l[1]))).toEqual(["R3_2", "R3_2"]);
  });

  it("never reuses a name the sheet has, and says when the net is not there", () => {
    const { doc } = fixture();
    const joins = resolveNetJoins(doc, ["R3.2"], [...nets, { net: "/R3_2", pins: [{ ref: "Q1", pin: "3" }] }]);
    expect(joins.name("R3.2")).toBe("R3_2_2");
    expect(errorOf(() => resolveNetJoins(doc, ["Net-(R9-Pad1)"], nets)).code).toBe("NOT_FOUND");
    expect(errorOf(() => resolveNetJoins(doc, ["Q1.3"], nets)).message).toMatch(/no pin Q1.3/);
  });
});

describe("removePartEdit", () => {
  it("removes the part with its wires up to the junction, and what is left on nothing", () => {
    const f = fixture();
    const { edit, alsoRemoved } = removePartEdit({ doc: f.doc, refs: ["R2"] });
    expect(new Set(edit.remove)).toEqual(new Set([f.r2.uuid, f.w5.uuid, f.w1.uuid, f.w2.uuid, f.mid.uuid, f.j1.uuid]));
    expect(alsoRemoved).toEqual({ wires: 3, labels: 1, powerSymbols: 0, other: 1 });
  });

  it("takes the power symbol and label sitting on its pins", () => {
    const f = fixture();
    const { edit, alsoRemoved } = removePartEdit({ doc: f.doc, refs: ["r1"] });
    expect(new Set(edit.remove)).toEqual(new Set([f.r1.uuid, f.pwr.uuid, f.sda.uuid]));
    expect(alsoRemoved).toMatchObject({ labels: 1, powerSymbols: 1 });
  });

  it("stops at another part's pin and at the middle of another wire", () => {
    const f = fixture();
    expect(new Set(removePartEdit({ doc: f.doc, refs: ["R3"] }).edit.remove)).toEqual(new Set([f.r3.uuid, f.w7.uuid]));
    expect(new Set(removePartEdit({ doc: f.doc, refs: ["R5"] }).edit.remove)).toEqual(new Set([f.r5.uuid, f.w9.uuid]));
  });

  it("removes only the symbol without withWires, and the result reads back", () => {
    const f = fixture();
    const { edit } = removePartEdit({ doc: f.doc, refs: ["R2"], withWires: false });
    expect(edit.remove).toEqual([f.r2.uuid]);
    const after = roundTrip(f.doc, removePartEdit({ doc: f.doc, refs: ["R2"] }).edit);
    expect(listParts(after).map((p) => p.ref)).not.toContain("R2");
    expect(readSheet(after).labels.map((l) => l.name).sort()).toEqual(["OUT", "OUT2", "SDA"]);
  });
});

describe("setFieldEdit", () => {
  it("sets values, adds custom fields hidden, renames with the sheet instance", () => {
    const f = fixture();
    const { edit } = setFieldEdit({
      doc: f.doc,
      changes: [
        { ref: "R1", field: "value", value: "4.7k" },
        { ref: "R1", field: "MPN", value: 'RC0603"FR' },
        { ref: "R1", field: "Reference", value: "R10" },
      ],
    });
    const [sym] = upserted(edit);
    expect(prop(sym!, "Value")).toBe("4.7k");
    expect(prop(sym!, "MPN")).toBe('RC0603"FR');
    expect(prop(sym!, "Reference")).toBe("R10");
    expect(edit.upsert[0]!.sexpr).toContain('(reference "R10")');
    expect(edit.upsert[0]!.sexpr).toMatch(/\(property "MPN" [^)]*\) \(effects \(font \(size 1\.27 1\.27\)\) \(hide yes\)\)/);
    const after = roundTrip(f.doc, edit);
    expect(listParts(after).find((p) => p.uuid === f.r1.uuid)?.ref).toBe("R10");
    expect(listParts(after).find((p) => p.uuid === f.r1.uuid)?.pins).toHaveLength(2); // pins kept
  });

  it("refuses a reference already in use", () => {
    const { doc } = fixture();
    expect(errorOf(() => setFieldEdit({ doc, changes: [{ ref: "R1", field: "Reference", value: "R2" }] })).code).toBe("INVALID");
  });
});

describe("movePartEdit", () => {
  it("moves and turns a part; its labels and power symbol follow its pins", () => {
    const f = fixture();
    const { edit, moved } = movePartEdit({ doc: f.doc, moves: [{ ref: "R1", at: [127, 76.2], angle: 90 }] });
    expect(moved[0]).toMatchObject({ ref: "R1", at: [127, 76.2], angle: 90, followed: 2, wiresLeft: 0 });
    const after = roundTrip(f.doc, edit);
    const sheet = readSheet(after);
    const r1 = sheet.symbols.find((s) => s.ref === "R1")!;
    const sda = sheet.labels.find((l) => l.name === "SDA")!;
    expect(sda.at).toEqual(r1.pins[1]!.at);
    expect(sda.angle).toBe(0); // pin 2 now points right
    const pwr = sheet.symbols.find((s) => s.ref === "#PWR01")!;
    expect(pwr.pins[0]!.at).toEqual(r1.pins[0]!.at);
    // The power symbol turned to point away from R1 (left), and its text turned with it.
    expect(pwr.angle).toBe(90);
    const value = (pwr.form.find((n) => isForm(n, "property") && unquote(n[1]) === "Value") as Form).find((n) => isForm(n, "at")) as string[];
    expect([Number(value[1]), Number(value[2])]).toEqual([123.19, 71.12]);
    // Fields keep their place relative to the part.
    const ref = (r1.form.find((n) => isForm(n, "property") && unquote(n[1]) === "Reference") as Form).find((n) => isForm(n, "at")) as string[];
    expect([Number(ref[1]), Number(ref[2])]).toEqual([127, 73.66]);
  });

  it("counts wires it leaves behind", () => {
    const f = fixture();
    expect(movePartEdit({ doc: f.doc, moves: [{ ref: "R2", at: [76.2, 127] }] }).moved[0]!.wiresLeft).toBe(2);
  });
});

describe("parseNetlist", () => {
  it("reads KiCad's export format", () => {
    const text = `(export (version "E") (design (source "x.kicad_sch"))
      (components (comp (ref "R1") (value "10k")))
      (nets
        (net (code "1") (name "+3V3") (class "Default") (node (ref "R1") (pin "1") (pintype "passive")))
        (net (code "2") (name "/SDA") (class "Default") (node (ref "R1") (pin "2") (pintype "passive")) (node (ref "U1") (pin "5") (pinfunction "SDA") (pintype "bidirectional")))))`;
    expect(parseNetlist(text)).toEqual([
      { net: "+3V3", pins: [{ ref: "R1", pin: "1", type: "passive" }] },
      {
        net: "/SDA",
        pins: [
          { ref: "R1", pin: "2", type: "passive" },
          { ref: "U1", pin: "5", name: "SDA", type: "bidirectional" },
        ],
      },
    ]);
  });

  it("drops the pin number KiCad 10 appends to a pin's name", () => {
    const text = `(export (version "E") (nets
      (net (code "1") (name "Net-(P1-PM)") (class "Default")
        (node (ref "P1") (pin "2") (pinfunction "PM_2") (pintype "passive"))
        (node (ref "U1") (pin "12") (pinfunction "A_1") (pintype "input"))
        (node (ref "D1") (pin "1") (pinfunction "_1") (pintype "passive")))))`;
    expect(parseNetlist(text)[0]!.pins.map((p) => p.name)).toEqual(["PM", "A_1", "_1"]);
  });

  it("refuses something else", () => {
    expect(errorOf(() => parseNetlist("(kicad_sch)")).code).toBe("INVALID");
  });
});

describe("applySchematicEdit", () => {
  it("leaves the input alone and creates lib_symbols when the sheet has none", () => {
    const doc = fileToDoc(sheetText([], []));
    const before = JSON.stringify(doc);
    const def = parseSexpr(DEF_R.replace('"Test:R"', '"R"'))[0] as Form;
    const { edit } = placePartEdit({ doc, parts: [{ libId: "Test:R", def }], projectName: "fixture" });
    const after = roundTrip(doc, edit);
    expect(JSON.stringify(doc)).toBe(before);
    expect(listParts(after).map((p) => p.ref)).toEqual(["R1"]);
    expect(docToFile(after)).toContain(`(path "/${ROOT}" (reference "R1")`);
  });
});
