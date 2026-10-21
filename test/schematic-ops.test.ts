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
  layoutIssues,
  wireEdit,
  withDefinitions,
  type NetlistNet,
  type PlacedReport,
  type SchematicEdit,
} from "../src/schematic-ops.js";
import { hitsBox, onSegmentInterior } from "../src/schematic-route.js";
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

// The name sits beyond the symbol, as in KiCad's power library: above a supply, below a ground.
const powerDef = (libId: string, value: string, pinAngle: number) => `(symbol "${libId}" (power) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -3.81 0) ${HIDE}) (property "Value" "${value}" (at 0 ${pinAngle === 90 ? "3.556" : "-3.81"} 0) ${F})
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

describe("tidier drawing (ai-chat 0003 step 5c)", () => {
  // Q1 at 101.6,50.8: pin 1 (A) ends at 96.52,50.8 facing left, pin 3 (C) at 106.68,53.34 facing right.
  const wires = (forms: Form[]) => ofType(forms, "wire").map((w) => (w.find((n) => isForm(n, "pts")) as Form).slice(1).map((xy) => (xy as string[]).slice(1).map(Number)));
  const powerAt = (forms: Form[], value: string) => ofType(forms, "symbol").find((s) => prop(s, "Value") === value);

  it("puts a power symbol on a sideways pin upright, on a short stub", () => {
    const { doc } = fixture();
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: "+3V3" }, { ref: "Q1", pin: "3", net: "GND" }] });
    expect(connected.map((c) => c.how)).toEqual(["power", "power"]);
    const forms = upserted(edit);
    expect(wires(forms)).toEqual([
      [[96.52, 50.8], [93.98, 50.8]],
      [[106.68, 53.34], [109.22, 53.34]],
    ]);
    // Natural orientation (angle 0): the supply points up, the ground down, so they never meet.
    expect(atOfForm(powerAt(forms, "+3V3")!)).toEqual([93.98, 50.8, 0]);
    expect(atOfForm(powerAt(forms, "GND")!)).toEqual([109.22, 53.34, 0]);
    // A pin that already points the symbol's way gets no stub: R3's top pin and +3V3.
    expect(wires(upserted(connectEdit({ doc, pins: [{ ref: "R3", pin: "1", net: "+3V3" }] }).edit))).toEqual([]);
  });

  it("sees a stubbed power symbol as connected, moves it with the part, and removes it with the pin's wires", () => {
    const { doc } = fixture();
    const stubbed = roundTrip(doc, connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: "+3V3" }] }).edit);
    expect(connectEdit({ doc: stubbed, pins: [{ ref: "Q1", pin: "1", net: "+3V3" }] }).connected[0]!.how).toBe("already");

    const moved = roundTrip(stubbed, movePartEdit({ doc: stubbed, moves: [{ ref: "Q1", at: [101.6, 76.2] }] }).edit);
    const sheet = readSheet(moved);
    // The old stub (96.52 → 93.98 at y 50.8) is gone, a new one hangs off the moved pin.
    expect(sheet.wires.filter((w) => [w.a, w.b].some((p) => p[1] === 50.8 && (p[0] === 96.52 || p[0] === 93.98)))).toEqual([]);
    const supply = sheet.symbols.find((s) => s.value === "+3V3" && s.pins.some((p) => p.at[0] === 93.98 && p.at[1] === 76.2));
    expect(supply?.angle).toBe(0);

    const gone = upserted(connectEdit({ doc: stubbed, pins: [{ ref: "Q1", pin: "1", net: null }] }).edit);
    expect(gone).toEqual([]);
    expect(connectEdit({ doc: stubbed, pins: [{ ref: "Q1", pin: "1", net: null }] }).edit.remove).toHaveLength(2); // the stub and the symbol
  });

  it("draws wires: straight, one bend away from parts, and a junction on another wire's middle", () => {
    const { doc } = fixture();
    // R3.1 (50.8,85.09) to R4.1 (63.5,85.09): in line.
    expect(wireEdit({ doc, wires: [{ from: "R3.1", to: "R4.1" }] }).wired[0]!.points).toEqual([[50.8, 85.09], [63.5, 85.09]]);
    // Q1.1 (96.52,50.8, facing left) to a point above: one bend. Leaving Q1 outward would bend on
    // (88.9,50.8), where w1 and w2 end: that joins the OUT net, so the wire goes up first (0008 §2.1).
    const bent = wireEdit({ doc, wires: [{ from: "Q1.1", to: [88.9, 40.64] }] }).wired[0]!.points;
    expect(bent).toEqual([[96.52, 50.8], [96.52, 40.64], [88.9, 40.64]]);
    // To the middle of the wire w2 (88.9,50.8 → 88.9,60.96): KiCad connects it only with a junction.
    const { edit } = wireEdit({ doc, wires: [{ from: "Q1.1", to: [88.9, 55.88] }] });
    expect(ofType(upserted(edit), "junction").map(atOfForm)).toEqual([[88.9, 55.88]]);
  });

  it("connect `to` wires two pins instead of labelling them", () => {
    const { doc } = fixture();
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "R3", pin: "1", to: "R4.1" }] });
    expect(connected).toEqual([{ pin: "R3.1", net: "R4.1", how: "wire" }]);
    expect(ofType(upserted(edit), "label")).toEqual([]);
    expect(ofType(upserted(edit), "wire")).toHaveLength(1);
  });

  it("names what an edit made untidy, and nothing that was there before", () => {
    const { doc } = fixture();
    // The old way (power symbols turned sideways on neighbouring pins) is gone; this edit is tidy.
    expect(layoutIssues(doc, connectEdit({ doc, pins: [{ ref: "Q1", pin: "1", net: "+3V3" }, { ref: "Q1", pin: "3", net: "GND" }] }).edit)).toEqual([]);
    // A part dropped onto R1: the parts overlap, and so does their text (0009 §3.5).
    const { edit } = placePartEdit({ doc, parts: [{ libId: "Test:R", at: [50.8, 50.8] }] });
    expect(layoutIssues(doc, edit)).toEqual([
      expect.objectContaining({ issue: "overlap", items: expect.arrayContaining(["R6", "R1"]) }),
      expect.objectContaining({ issue: "text_overlap", items: ["R1 Reference", "R6 Reference"] }),
      expect.objectContaining({ issue: "text_overlap", items: ["R6 Value", "R1"] }),
    ]);
    // An item off the grid.
    const label = `(label "X" (at 10.1 10.1 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id()}"))`;
    expect(layoutIssues(doc, { label: "x", upsert: [{ sexpr: label }], remove: [], libSymbols: {} })).toEqual([
      { issue: "off_grid", items: ["label X"], at: [10.1, 10.1] },
    ]);
  });
});

// A connector with pins on its right (like a USB-C receptacle's CC1, CC2, D+) and one at the bottom.
const DEF_J = `(symbol "Test:J" (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "J" (at 0 10.16 0) ${F}) (property "Value" "J" (at 0 -10.16 0) ${F})
  (property "Footprint" "" (at 0 0 0) ${HIDE}) (property "Datasheet" "" (at 0 0 0) ${HIDE})
  (symbol "J_0_1" (rectangle (start -5.08 7.62) (end 5.08 -7.62) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "J_1_1"
    (pin passive line (at 7.62 5.08 180) (length 2.54) (name "CC1" ${F}) (number "A5" ${F}))
    (pin passive line (at 7.62 2.54 180) (length 2.54) (name "CC2" ${F}) (number "B5" ${F}))
    (pin passive line (at 7.62 -2.54 180) (length 2.54) (name "D+" ${F}) (number "B6" ${F}))
    (pin passive line (at 0 -10.16 90) (length 2.54) (name "GND" ${F}) (number "A1" ${F}))))`;

describe("safe and tidy drawing (ai-chat 0008)", () => {
  const segments = (pts: number[][]) => pts.slice(1).map((q, i) => [pts[i]!, q] as [[number, number], [number, number]]);
  const touches = (p: [number, number], pts: number[][]) =>
    pts.some((q) => q[0] === p[0] && q[1] === p[1]) || segments(pts).some(([a, z]) => onSegmentInterior(p, a, z));

  it("goes around a part, never through another pin's end (the CC2 short)", () => {
    // J1 at 101.6,76.2: A5 ends at 109.22,71.12, B5 at 109.22,73.66, B6 at 109.22,78.74. R7 left of
    // it, its pin 1 at 76.2,78.74: level with B6, so an L to B5 either bends on B6 or crosses J1.
    const j1 = placed("Test:J", "J1", 101.6, 76.2, { pins: ["A5", "B5", "B6", "A1"] });
    const r7 = placed("Test:R", "R7", 76.2, 82.55, { pins: ["1", "2"] });
    const doc = fileToDoc(sheetText([j1.text, r7.text], [DEF_R, DEF_J, DEF_3V3, DEF_GND]));
    const { edit, wired } = wireEdit({ doc, wires: [{ from: "R7.1", to: "J1.B5" }] });
    const pts = wired[0]!.points;
    expect(pts[0]).toEqual([76.2, 78.74]);
    expect(pts[pts.length - 1]).toEqual([109.22, 73.66]);
    const body = { minX: 96.52, minY: 68.58, maxX: 109.22, maxY: 86.36 };
    for (const [a, z] of segments(pts)) expect(hitsBox(a, z, body), `${a} → ${z}`).toBe(false);
    for (const other of [[109.22, 71.12], [109.22, 78.74], [101.6, 86.36]] as Array<[number, number]>) expect(touches(other, pts)).toBe(false);
    // Safe, but the way around is long: named, so the model can use a net name (0009 §3.1).
    expect(layoutIssues(doc, edit)).toEqual([{ issue: "long_wire", items: ["R7.1", "J1.B5"], at: [76.2, 78.74], mm: 51 }]);
  });

  it("puts both pins on the net's name when no clean wire exists, and refuses a wire", () => {
    // R4.1 (63.5,85.09) walled in: junctions left, right and above; R4's body below.
    const f = fixture();
    const items = Object.entries(f).filter(([k]) => k !== "doc").map(([, v]) => (v as { text: string }).text);
    const walls = [junction([62.23, 85.09]), junction([64.77, 85.09]), junction([63.5, 83.82])];
    const doc = fileToDoc(sheetText([...items, ...walls.map((w) => w.text)]));
    expect(errorOf(() => wireEdit({ doc, wires: [{ from: "R3.1", to: "R4.1" }] })).code).toBe("NO_ROUTE");
    expect(errorOf(() => connectEdit({ doc, pins: [{ ref: "R3", pin: "1", to: "R4.1" }] })).message).toMatch(/connect with a net/);
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "R3", pin: "1", to: "R4.1", orNet: "LINK" }] });
    expect(connected[0]).toMatchObject({ pin: "R3.1", net: "LINK", how: "label", note: expect.stringContaining("No clean wire to R4.1") });
    expect(ofType(upserted(edit), "label").map((l) => unquote(l[1]))).toEqual(["LINK", "LINK"]);
  });

  it("takes a label that would run into a part out on a stub; the label stays its pin's", () => {
    // R8's pin 2 points down at 50.8,54.61; R9 sits right below: a long label there runs into it.
    const r8 = placed("Test:R", "R8", 50.8, 50.8, { pins: ["1", "2"] });
    const r9 = placed("Test:R", "R9", 50.8, 63.5, { pins: ["1", "2"] });
    const doc = fileToDoc(sheetText([r8.text, r9.text]));
    const { edit } = connectEdit({ doc, pins: [{ ref: "R8", pin: "2", net: "CC_LONG_NAME" }] });
    const forms = upserted(edit);
    const label = ofType(forms, "label")[0]!;
    // Out one step, then sideways: clear of both parts.
    expect(atOfForm(label)).toEqual([53.34, 57.15, 0]);
    expect(ofType(forms, "wire")).toHaveLength(2);
    expect(layoutIssues(doc, edit)).toEqual([]);

    const after = roundTrip(doc, edit);
    expect(connectEdit({ doc: after, pins: [{ ref: "R8", pin: "2", net: "CC_LONG_NAME" }] }).connected[0]!.how).toBe("already");
    // Moved, it is drawn again from the new pin end; removed, it goes with the part.
    const moved = roundTrip(after, movePartEdit({ doc: after, moves: [{ ref: "R8", at: [101.6, 50.8] }] }).edit);
    const sheet = readSheet(moved);
    expect(sheet.labels.filter((l) => l.name === "CC_LONG_NAME")).toEqual([expect.objectContaining({ at: [101.6, 54.61] })]);
    expect(sheet.wires).toEqual([]);
    const { edit: gone } = removePartEdit({ doc: after, refs: ["R8"] });
    expect(gone.remove).toEqual(expect.arrayContaining(readSheet(after).labels.map((l) => l.uuid)));
    expect(readSheet(roundTrip(after, gone)).wires).toEqual([]);
  });

  it("places a part with room for its labels, beside the labels of its nets", () => {
    const f = fixture();
    // SDA's label hangs down from R1's pin 2 (50.8,54.61): the new part starts below it.
    const { edit, placed: [part] } = placePartEdit({ doc: f.doc, parts: [{ libId: "Test:R", nets: { "1": "SDA", "2": "GND" } }] });
    expect(Math.abs(part!.at[0] - 50.8)).toBeLessThanOrEqual(7.62);
    expect(part!.at[1]).toBeGreaterThan(54.61);
    expect(part!.at[1]).toBeLessThan(80);
    expect(layoutIssues(f.doc, edit)).toEqual([]);
    // Two turned parts in one request, long names on both pins: no label runs into the other part.
    const two = placePartEdit({
      doc: f.doc,
      parts: [
        { libId: "Test:R", angle: 90, nets: { "1": "ALPHA_LONG_NET", "2": "BRAVO_LONG_NET" } },
        { libId: "Test:R", angle: 90, nets: { "1": "CHARLIE_LONG_NET", "2": "DELTA_LONG_NET" } },
      ],
    });
    expect(layoutIssues(f.doc, two.edit)).toEqual([]);
  });

  it("names a wire through a part and a pin end on a wire's middle", () => {
    const { doc } = fixture();
    const wire = (a: [number, number], z: [number, number]) =>
      `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${z[0]} ${z[1]})) (stroke (width 0) (type default)) (uuid "${id()}"))`;
    const edit = { label: "x", upsert: [{ sexpr: wire([40.64, 50.8], [60.96, 50.8]) }, { sexpr: wire([93.98, 50.8], [99.06, 50.8]) }], remove: [], libSymbols: {} };
    expect(layoutIssues(doc, edit)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issue: "wire_crosses_part", items: ["wire", "R1"] }),
        expect.objectContaining({ issue: "wire_touches_pin", items: ["wire", "Q1.1"] }),
      ]),
    );
  });
});

describe("the drawing rulebook (ai-chat 0009)", () => {
  const DEF_C = `(symbol "Test:C" (pin_numbers (hide yes)) (pin_names (offset 0.254)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "C" (at 0.635 2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "C" (at 0.635 -2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "" (at 0 0 0) ${HIDE}) (property "Datasheet" "~" (at 0 0 0) ${HIDE})
    (symbol "C_0_1" (polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
      (polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none))))
    (symbol "C_1_1"
      (pin passive line (at 0 3.81 270) (length 2.794) (name "~" ${F}) (number "1" ${F}))
      (pin passive line (at 0 -3.81 90) (length 2.794) (name "~" ${F}) (number "2" ${F}))))`;
  // A chip: VDD on top and GND at the bottom (power inputs), SDA on the right.
  const DEF_U = `(symbol "Test:U" (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "U" (at -5.08 6.35 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "U" (at -5.08 -6.35 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "" (at 0 0 0) ${HIDE}) (property "Datasheet" "" (at 0 0 0) ${HIDE})
    (symbol "U_0_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254) (type default)) (fill (type background))))
    (symbol "U_1_1"
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "VDD" ${F}) (number "1" ${F}))
      (pin power_in line (at 0 -7.62 90) (length 2.54) (name "GND" ${F}) (number "2" ${F}))
      (pin bidirectional line (at 7.62 0 180) (length 2.54) (name "SDA" ${F}) (number "3" ${F}))))`;
  // An LED-like part: its light arrows reach past the cathode's pin end (K, on the left).
  const DEF_D = `(symbol "Test:D" (pin_numbers (hide yes)) (pin_names (offset 1.016) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "D" (at 0 2.54 0) ${F}) (property "Value" "D" (at 0 -2.54 0) ${F})
    (property "Footprint" "" (at 0 0 0) ${HIDE}) (property "Datasheet" "" (at 0 0 0) ${HIDE})
    (symbol "D_0_1"
      (polyline (pts (xy -1.27 -1.27) (xy -1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy 1.27 -1.27) (xy 1.27 1.27) (xy -1.27 0) (xy 1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy -1.778 -0.762) (xy -4.572 -2.286)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "D_1_1"
      (pin passive line (at -3.81 0 0) (length 2.54) (name "K" ${F}) (number "1" ${F}))
      (pin passive line (at 3.81 0 180) (length 2.54) (name "A" ${F}) (number "2" ${F}))))`;
  const pinAt = (p: { pins: Array<{ number: string; at: [number, number] }> }, n: string) => p.pins.find((q) => q.number === n)!.at;
  const raw = (sexpr: string): SchematicEdit => ({ label: "x", upsert: [{ sexpr }], remove: [], libSymbols: {} });

  it("puts both pins on the net's name when the clean wire would be long, and names a long wire (rule 9)", () => {
    // 0008's CC2 case: the way around J1 is 51 mm.
    const j1 = placed("Test:J", "J1", 101.6, 76.2, { pins: ["A5", "B5", "B6", "A1"] });
    const r7 = placed("Test:R", "R7", 76.2, 82.55, { pins: ["1", "2"] });
    const doc = fileToDoc(sheetText([j1.text, r7.text], [DEF_R, DEF_J, DEF_3V3, DEF_GND]));
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "R7", pin: "1", to: "J1.B5", orNet: "CC2" }] });
    expect(connected[0]).toMatchObject({ how: "label", note: expect.stringContaining("No clean wire to J1.B5 (it would run 51 mm)") });
    expect(ofType(upserted(edit), "label").map((l) => unquote(l[1]))).toEqual(["CC2", "CC2"]);
    expect(layoutIssues(doc, edit)).toEqual([]);
    // Without a net name to fall back on (a plain `to`), the wire is drawn, as asked.
    expect(connectEdit({ doc, pins: [{ ref: "R7", pin: "1", to: "J1.B5" }] }).connected[0]!.how).toBe("wire");
  });

  it("never makes four lines meet at one dot (rule 10)", () => {
    // R3.1 (50.8,85.09) has two wires already: with the pin, three lines meet there.
    const r3 = placed("Test:R", "R3", 50.8, 88.9, { pins: ["1", "2"] });
    const r4 = placed("Test:R", "R4", 76.2, 88.9, { pins: ["1", "2"] });
    const doc = fileToDoc(sheetText([r3.text, r4.text, wire([50.8, 85.09], [45.72, 85.09]).text, wire([50.8, 85.09], [55.88, 85.09]).text]));
    expect(errorOf(() => wireEdit({ doc, wires: [{ from: "R4.1", to: "R3.1" }] })).message).toMatch(/three lines already meet there/);
    const { edit, connected } = connectEdit({ doc, pins: [{ ref: "R4", pin: "1", to: "R3.1", orNet: "LINK" }] });
    expect(connected[0]!.note).toContain("three lines already meet at R3.1");
    // R3.1's label sits on the pin end itself: a stub would be the fourth line.
    const forms = upserted(edit);
    expect(ofType(forms, "label").map(atOfForm)).toEqual(expect.arrayContaining([[50.8, 85.09, 90]]));
    expect(ofType(forms, "wire")).toEqual([]);
    // One drawn by hand is named.
    const fourth = `(wire (pts (xy 50.8 85.09) (xy 50.8 80.01)) (stroke (width 0) (type default)) (uuid "${id()}"))`;
    expect(layoutIssues(doc, raw(fourth))).toEqual([{ issue: "four_way_junction", items: ["R3.1"], at: [50.8, 85.09] }]);
  });

  it("stands a decoupling capacitor upright next to its chip's power pin, the next one at the next chip (rule 11)", () => {
    const u1 = placed("Test:U", "U1", 101.6, 76.2, { pins: ["1", "2", "3"] });
    const u2 = placed("Test:U", "U2", 50.8, 127, { pins: ["1", "2", "3"] });
    const bare = fileToDoc(sheetText([u1.text, u2.text], [DEF_U, DEF_C, DEF_3V3, DEF_GND]));
    const pins = ["U1", "U2"].flatMap((ref) => [{ ref, pin: "1", net: "+3V3" }, { ref, pin: "2", net: "GND" }]);
    const doc = roundTrip(bare, connectEdit({ doc: bare, pins }).edit);
    // Pin 2 on the supply: turned so it is on top.
    const { edit, placed: caps } = placePartEdit({ doc, parts: [0, 1].map(() => ({ libId: "Test:C", value: "100n", nets: { "1": "GND", "2": "+3V3" } })) });
    const [c1, c2] = caps as [PlacedReport, PlacedReport];
    for (const c of [c1, c2]) {
      expect(c.angle).toBe(180);
      expect(pinAt(c, "2")[1]).toBeLessThan(pinAt(c, "1")[1]);
    }
    const vdd1: [number, number] = [101.6, 68.58];
    const vdd2: [number, number] = [50.8, 119.38];
    const dist = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    expect(dist(c1.at, vdd1)).toBeLessThan(15.24);
    expect(dist(c2.at, vdd2)).toBeLessThan(15.24);
    expect(layoutIssues(doc, edit)).toEqual([]);
  });

  it("puts a pull-up above its signal's label and a pull-down below, upright (rule 12)", () => {
    const f = fixture();
    // Q1.3 (106.68,53.34) gets the label SIG, facing right.
    const doc = roundTrip(f.doc, connectEdit({ doc: f.doc, pins: [{ ref: "Q1", pin: "3", net: "SIG" }] }).edit);
    const labelTop = 53.34 - 1.27;
    const up = placePartEdit({ doc, parts: [{ libId: "Test:R", nets: { "1": "SIG", "2": "+3V3" } }] });
    const [pullUp] = up.placed as [PlacedReport];
    expect(pinAt(pullUp, "2")[0]).toBe(pinAt(pullUp, "1")[0]);
    expect(pinAt(pullUp, "2")[1]).toBeLessThan(pinAt(pullUp, "1")[1]);
    expect(pinAt(pullUp, "1")[1]).toBeLessThan(labelTop);
    expect(layoutIssues(doc, up.edit)).toEqual([]);

    const down = placePartEdit({ doc, parts: [{ libId: "Test:R", nets: { "1": "SIG", "2": "GND" } }] });
    const [pullDown] = down.placed as [PlacedReport];
    expect(pinAt(pullDown, "1")[1]).toBeLessThan(pinAt(pullDown, "2")[1]);
    expect(pinAt(pullDown, "1")[1]).toBeGreaterThan(53.34);
    expect(layoutIssues(doc, down.edit)).toEqual([]);
    // Turned on purpose: kept.
    expect(placePartEdit({ doc, parts: [{ libId: "Test:R", angle: 90, nets: { "1": "SIG", "2": "+3V3" } }] }).placed[0]!.angle).toBe(90);
  });

  it("stands a ground upright on a stub off an LED's cathode, past its light arrows", () => {
    // D1's cathode ends at 97.79,76.2, facing left; its arrows reach to 97.03. A stub used to
    // count as crossing D1, so the ground sat on the pin end, turned sideways.
    const d1 = placed("Test:D", "D1", 101.6, 76.2, { pins: ["1", "2"] });
    const doc = fileToDoc(sheetText([d1.text], [DEF_D, DEF_3V3, DEF_GND]));
    const { edit } = connectEdit({ doc, pins: [{ ref: "D1", pin: "1", net: "GND" }] });
    const forms = upserted(edit);
    expect(atOfForm(ofType(forms, "symbol").find((s) => prop(s, "Value") === "GND")!)).toEqual([95.25, 76.2, 0]);
    expect(ofType(forms, "wire").map((w) => (w.find((n) => isForm(n, "pts")) as Form).slice(1).map((xy) => (xy as string[]).slice(1).map(Number)))).toEqual([
      [
        [97.79, 76.2],
        [95.25, 76.2],
      ],
    ]);
    // Leaving its own pin outward is not crossing D1.
    expect(layoutIssues(doc, edit)).toEqual([]);
  });

  it("keeps text clear, and names text an edit covered (rule 13)", () => {
    const { doc } = fixture();
    // R1's value (10k) sits right of it at 55.88,50.8: a part placed next to R1 keeps off it.
    const { edit } = placePartEdit({ doc, parts: [{ libId: "Test:R", value: "4.7k", near: "R1" }] });
    expect(layoutIssues(doc, edit)).toEqual([]);
    // A label dropped on it is named.
    const label = `(label "X" (at 54.61 52.07 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id()}"))`;
    expect(layoutIssues(doc, raw(label))).toEqual(expect.arrayContaining([expect.objectContaining({ issue: "text_overlap", items: ["R1 Value", "label X"] })]));
  });
});

describe("withDefinitions", () => {
  it("carries the definition of every symbol an edit places, even one the sheet embeds", () => {
    const { doc } = fixture();
    // +3V3 is embedded in the fixture, so connectEdit leaves its definition out.
    const { edit } = connectEdit({ doc, pins: [{ ref: "R3", pin: "1", net: "+3V3" }, { ref: "R3", pin: "2", net: "NODE" }] });
    expect(edit.libSymbols).toEqual({});
    const full = withDefinitions(doc, edit);
    expect(Object.keys(full.libSymbols)).toEqual(["power:+3V3"]);
    expect(full.libSymbols["power:+3V3"]).toMatch(/^\(symbol "power:\+3V3"/);
    expect(full.upsert).toBe(edit.upsert);
    // One the edit already carries stays as it is.
    expect(withDefinitions(doc, { ...edit, libSymbols: { "power:+3V3": "(symbol \"power:+3V3\")" } }).libSymbols).toEqual({ "power:+3V3": "(symbol \"power:+3V3\")" });
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

  // ai-chat 0006 S4, S21: what a stranger's text could steer the model to write.
  it.each(["javascript:alert(1)", " JavaScript:fetch('/api/me')", "data:text/html,<b>x</b>", "file:///etc/passwd", "${URL}", "vbscript:x"])(
    "refuses the Datasheet %s",
    (value) => {
      const { doc } = fixture();
      expect(errorOf(() => setFieldEdit({ doc, changes: [{ ref: "R1", field: "Datasheet", value }] })).code).toBe("INVALID");
    },
  );

  it.each(["", "~", "https://example.com/r.pdf", "http://example.com/r.pdf", "docs/r1.pdf", "kicad-embed://r1.pdf"])("takes the Datasheet %j", (value) => {
    const { doc } = fixture();
    expect(setFieldEdit({ doc, changes: [{ ref: "R1", field: "datasheet", value }] }).changed[0]!.value).toBe(value);
  });

  it("refuses invisible characters and a virtual reference on a part", () => {
    const { doc } = fixture();
    expect(errorOf(() => setFieldEdit({ doc, changes: [{ ref: "R1", field: "Reference", value: "R2​" }] })).message).toMatch(/invisible/);
    expect(errorOf(() => setFieldEdit({ doc, changes: [{ ref: "R1", field: "Value", value: "10k‮" }] })).message).toMatch(/invisible/);
    expect(errorOf(() => setFieldEdit({ doc, changes: [{ ref: "R1", field: "Reference", value: "#R9" }] })).message).toMatch(/power symbols/);
    for (const value of ["R'9", 'R"9', "R\\9"]) {
      expect(errorOf(() => setFieldEdit({ doc, changes: [{ ref: "R1", field: "Reference", value }] })).message).toMatch(/quotes/);
    }
    // A power symbol keeps its "#" reference.
    expect(setFieldEdit({ doc, changes: [{ ref: "#PWR01", field: "Reference", value: "#PWR09" }] }).changed[0]!.ref).toBe("#PWR09");
  });
});

describe("links and lookalikes, second review (ai-chat 0006 S4, S21)", () => {
  const set = (doc: KicadDoc, field: string, value: string, ref = "R1") => setFieldEdit({ doc, changes: [{ ref, field, value }] });

  it.each([
    ["Datasheet", "javascript{colon}alert(1)"],
    ["Datasheet", "{dollar}{Description}"],
    ["Datasheet", "$(MY_LINK)"],
    ["Datasheet", "@{lower(X)}"],
    ["Datasheet", "https://x/{dollar}"],
    ["Datasheet", "../other/secret.html"],
    ["Value", "javascript:alert(1)//https://x"],
    ["Description", "see https://example.com for details"],
    ["Description", "${Datasheet}"],
    ["MPN", "{colon}"],
    ["Sim.Library", "models/x.lib"],
  ])("refuses %s = %j", (field, value) => {
    const { doc } = fixture();
    expect(errorOf(() => set(doc, field, value)).code).toBe("INVALID");
  });

  it("takes plain links and plain text", () => {
    const { doc } = fixture();
    expect(set(doc, "Datasheet", "https://www.ti.com/lit/ds/symlink/lm358.pdf?ts=1#page=3").changed[0]!.value).toContain("ti.com");
    expect(set(doc, "MPN", "RC0603FR-0710KL").changed[0]!.value).toBe("RC0603FR-0710KL");
    expect(set(doc, "Description", "خروجی‌ها").changed[0]!.value).toBe("خروجی‌ها"); // ZWNJ is writing, not a trick
  });

  it("strips C1 controls and refuses blank fillers", () => {
    const { doc } = fixture();
    expect(set(doc, "Value", "10k\u0085").changed[0]!.value).toBe("10k");
    for (const filler of ["ㅤ", "ᅟ", "ﾠ", "͏", "⠀", " "]) {
      expect(errorOf(() => set(doc, "Value", `10k${filler}x`)).message).toMatch(/invisible/);
    }
  });

  it("refuses net names with a space other than a plain one", () => {
    const { doc } = fixture();
    expect(errorOf(() => connectEdit({ doc, pins: [{ ref: "R2", pin: "1", net: "VCC 3V3" }] })).code).toBe("INVALID");
    expect(connectEdit({ doc, pins: [{ ref: "R2", pin: "1", net: "VCC 3V3" }] }).connected[0]!.net).toBe("VCC 3V3");
  });

  it("refuses references outside ASCII letters, digits and _ + - . ?", () => {
    const { doc } = fixture();
    for (const value of ["R2 ", "R 2", "Ｒ2", "R2́"]) expect(errorOf(() => set(doc, "Reference", value)).code).toBe("INVALID");
  });

  it("places a library part without the library's script link, and refuses a virtual reference on a non-power part", () => {
    const { doc } = fixture();
    const evil = parseSexpr(DEF_R.replace('(property "Datasheet" "~"', '(property "Datasheet" "javascript:alert(1)"'))[0] as Form;
    const { edit } = placePartEdit({ doc, parts: [{ libId: "Evil:R", def: evil }] });
    expect(prop(upserted(edit)[0]!, "Datasheet")).toBe("~");
    expect(edit.libSymbols["Evil:R"]).not.toContain("javascript:");
    expect(placementBlob({ def: evil, libId: "Test:R" }).sexpr).not.toContain("javascript:");
    // A library field KiCad would expand into anything is left empty; a click placement checks its value too.
    const expanding = parseSexpr(DEF_R.replace('(property "Value" "R"', '(property "Value" "${Datasheet}"'))[0] as Form;
    expect(prop(upserted(placePartEdit({ doc, parts: [{ libId: "Exp:R", def: expanding }] }).edit)[0]!, "Value")).toBe("");
    expect(errorOf(() => placementBlob({ def: evil, libId: "Test:R", value: "javascript:alert(1)//https://x" })).code).toBe("INVALID");
    const virtual = parseSexpr(DEF_R.replace('(property "Reference" "R"', '(property "Reference" "#R"'))[0] as Form;
    expect(errorOf(() => placePartEdit({ doc, parts: [{ libId: "Test:Rv", def: virtual }] })).message).toMatch(/power symbol/);
  });

  it("refuses a NaN angle and a quote in the library name", () => {
    const { doc } = fixture();
    expect(() => placePartEdit({ doc, parts: [{ libId: "Test:R", angle: Number.NaN }] })).toThrow(RangeError);
    const def = parseSexpr(DEF_R)[0] as Form;
    expect(errorOf(() => placePartEdit({ doc, parts: [{ libId: 'Te"st:R', def }] })).code).toBe("INVALID");
  });
});

describe("what KiCad cannot load (ai-chat 0006 S18, S20)", () => {
  it("refuses a non-finite position", () => {
    const { doc } = fixture();
    expect(() => placePartEdit({ doc, parts: [{ libId: "Test:R", at: [Number.POSITIVE_INFINITY, 0] }] })).toThrow(RangeError);
    expect(() => placePartEdit({ doc, parts: [{ libId: "Test:R", at: [0, JSON.parse("1e400") as number] }] })).toThrow(RangeError);
    expect(() => movePartEdit({ doc, moves: [{ ref: "R1", at: [Number.NaN, 0] }] })).toThrow(RangeError);
  });

  it.each(['Lib:R<">', "Lib:R\\x", "Lib:R:x", "Li\\b:R", ":R", "Lib:"])("refuses the lib id %j", (libId) => {
    const { doc } = fixture();
    const def = parseSexpr(DEF_R)[0] as Form;
    expect(errorOf(() => placePartEdit({ doc, parts: [{ libId, def }] })).code).toBe("INVALID");
    expect(errorOf(() => placementBlob({ def, libId })).code).toBe("INVALID");
  });

  it("refuses a tab in a lib id it is handed as is", () => {
    const def = parseSexpr(DEF_R)[0] as Form;
    expect(errorOf(() => placementBlob({ def, libId: "Lib:R\tx" })).code).toBe("INVALID");
  });

  it("takes a lib id with spaces and dots, as KiCad does", () => {
    const { doc } = fixture();
    const def = parseSexpr(DEF_R)[0] as Form;
    const { edit } = placePartEdit({ doc, parts: [{ libId: "My Lib:R 0603.1", def }] });
    expect(Object.keys(edit.libSymbols)).toEqual(["My Lib:R 0603.1"]);
  });
});

describe("movePartEdit", () => {
  it("moves and turns a part; its labels and power symbol follow its pins", () => {
    const f = fixture();
    const { edit, moved } = movePartEdit({ doc: f.doc, moves: [{ ref: "R1", at: [127, 76.2], angle: 90 }] });
    expect(moved[0]).toMatchObject({ ref: "R1", at: [127, 76.2], angle: 90, followed: 2, rerouted: 0 });
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

  it("re-routes the wires on its pins from their new ends, so the part stays connected", () => {
    const f = fixture();
    const { edit, moved } = movePartEdit({ doc: f.doc, moves: [{ ref: "R2", at: [76.2, 127] }] });
    // Pin 2's run (to the bend at 88.9) is re-routed. Pin 1's wire led only to the MID label: a
    // stub, so MID is drawn again at the new pin end instead of a wire running back (0008 §2.3).
    expect(moved[0]!).toMatchObject({ rerouted: 1, followed: 1 });
    const sheet = readSheet(roundTrip(f.doc, edit));
    const r2 = sheet.symbols.find((s) => s.ref === "R2")!;
    expect(sheet.wires.some((w) => [w.a, w.b].some((p) => p[0] === r2.pins[1]!.at[0] && p[1] === r2.pins[1]!.at[1]))).toBe(true);
    expect(sheet.wires.some((w) => [w.a, w.b].some((p) => p[0] === 88.9 && p[1] === 50.8))).toBe(true);
    const mid = sheet.labels.filter((l) => l.name === "MID");
    expect(mid).toHaveLength(1);
    expect(Math.hypot(mid[0]!.at[0] - r2.pins[0]!.at[0], mid[0]!.at[1] - r2.pins[0]!.at[1])).toBeLessThan(15);
    // Still on R2's pin 1: connecting it to MID again changes nothing.
    expect(connectEdit({ doc: roundTrip(f.doc, edit), pins: [{ ref: "R2", pin: "1", net: "MID" }] }).connected[0]!.how).toBe("already");
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
