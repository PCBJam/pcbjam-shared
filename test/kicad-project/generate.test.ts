import { describe, expect, test } from "vitest";
import {
  BUILTIN_FAB_PROFILES,
  KICAD_GITIGNORE,
  builtinFabProfile,
  defaultChoices,
  generateKicadProject,
  parseSexpr,
  seededUuid,
  validateKicadProjectDir,
  validateKicadProjectName,
  type KicadProjectChoices,
} from "../../src/index.js";

const opts = { name: "blinky", dir: "blinky", date: "2026-10-05" };
const byPath = (files: { path: string; text: string }[]) => new Map(files.map((f) => [f.path, f.text]));

/** Every offered (profile, tier, layers) with the profile's defaults otherwise. */
const variants: [string, string, number][] = BUILTIN_FAB_PROFILES.flatMap((p) =>
  Object.keys(p.tiers).flatMap((tier) => p.options.layers.map((layers) => [p.id, tier, layers] as [string, string, number])),
);

describe("generateKicadProject", () => {
  test.each(variants)("%s %s %d-layer matches its snapshot", (id, tier, layers) => {
    const p = builtinFabProfile(id)!;
    const choices: KicadProjectChoices = { ...defaultChoices(p), tier, layers, stackup: undefined };
    const files = generateKicadProject(p, choices, opts);
    expect(Object.fromEntries(files.map((f) => [f.path, f.text]))).toMatchSnapshot();
  });

  test("is deterministic", () => {
    const p = builtinFabProfile("jlcpcb")!;
    const a = generateKicadProject(p, defaultChoices(p), opts);
    const b = generateKicadProject(p, defaultChoices(p), opts);
    expect(a).toEqual(b);
  });

  test("names files by stem inside the folder; dru only for fab templates", () => {
    const fab = byPath(generateKicadProject(builtinFabProfile("pcbway")!, defaultChoices(builtinFabProfile("pcbway")!), opts));
    expect([...fab.keys()]).toEqual(["blinky/blinky.kicad_pro", "blinky/blinky.kicad_sch", "blinky/blinky.kicad_pcb", "blinky/blinky.kicad_dru"]);
    const kicad = generateKicadProject(builtinFabProfile("kicad-default")!, defaultChoices(builtinFabProfile("kicad-default")!), { ...opts, dir: "" });
    expect(kicad.map((f) => f.path)).toEqual(["blinky.kicad_pro", "blinky.kicad_sch", "blinky.kicad_pcb"]);
  });

  test(".gitignore only when asked, at the project root", () => {
    const p = builtinFabProfile("jlcpcb")!;
    const files = byPath(generateKicadProject(p, defaultChoices(p), { ...opts, gitignore: true }));
    expect(files.get(".gitignore")).toBe(KICAD_GITIGNORE);
  });

  test(".kicad_pro carries the rules under KiCad's keys with nested schema versions", () => {
    const p = builtinFabProfile("jlcpcb")!;
    const pro = JSON.parse(byPath(generateKicadProject(p, { ...defaultChoices(p), layers: 4 }, opts)).get("blinky/blinky.kicad_pro")!);
    expect(pro.meta).toEqual({ filename: "blinky.kicad_pro", version: 3 });
    expect(pro.board.design_settings.meta.version).toBe(2);
    expect(pro.board.design_settings.rules).toMatchObject({
      min_track_width: 0.09,
      min_clearance: 0.09,
      min_via_diameter: 0.4,
      min_through_hole_diameter: 0.3,
      min_copper_edge_clearance: 0.2,
    });
    expect(pro.net_settings.meta.version).toBe(5);
    expect(pro.net_settings.classes[0]).toMatchObject({ name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 });
    expect(pro.text_variables.FAB).toBe("JLCPCB");
  });

  test("the board has the chosen copper layers and the fab stackup", () => {
    const p = builtinFabProfile("jlcpcb")!;
    const pcb = byPath(generateKicadProject(p, { ...defaultChoices(p), layers: 4, stackup: "JLC04161H-3313" }, opts)).get("blinky/blinky.kicad_pcb")!;
    expect(parseSexpr(pcb)).toHaveLength(1);
    for (const name of ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]) expect(pcb).toContain(`"${name}" signal`);
    expect(pcb).not.toContain("In3.Cu");
    expect(pcb).toContain('(material "3313")');
    expect(pcb).toContain("(thickness 1.265)");
    expect(pcb.startsWith("(kicad_pcb\n\t(version ")).toBe(true);
  });

  test("the schematic carries a seeded uuid and the title block", () => {
    const p = builtinFabProfile("pcbway")!;
    const sch = byPath(generateKicadProject(p, defaultChoices(p), { ...opts, company: "Acme" })).get("blinky/blinky.kicad_sch")!;
    expect(sch).toContain(`(uuid "${seededUuid("blinky/blinky|pcbway|2026-10-05|sch")}")`);
    expect(sch).toContain('(title "blinky")');
    expect(sch).toContain('(company "Acme")');
    expect(sch).toContain('(comment 1 "PCBWay Standard rules, 2 layers")');
  });

  test("the rules file names each rule after the fab", () => {
    const p = builtinFabProfile("jlcpcb")!;
    const dru = byPath(generateKicadProject(p, defaultChoices(p), opts)).get("blinky/blinky.kicad_dru")!;
    expect(dru.startsWith("(version 1)\n")).toBe(true);
    expect(dru).toContain('(rule "JLCPCB: via diameter"');
    expect(dru).toContain("(constraint hole_to_hole (min 0.45mm))");
    expect(dru).not.toContain("(constraint clearance");
  });

  test("recommended values by default; smallest switches to the published minimums", () => {
    const p = builtinFabProfile("jlcpcb")!;
    const files = (smallest: boolean) => byPath(generateKicadProject(p, { ...defaultChoices(p), smallest }, opts));
    const rec = files(false);
    const min = files(true);
    expect(rec.get("blinky/blinky.kicad_dru")).toContain("(constraint annular_width (min 0.25mm))");
    expect(min.get("blinky/blinky.kicad_dru")).toContain("(constraint annular_width (min 0.18mm))");
    expect(JSON.parse(min.get("blinky/blinky.kicad_pro")!).text_variables.FAB_PROFILE).toBe(`jlcpcb v${p.version} (standard, smallest)`);
  });

  test("rejects choices the profile does not offer", () => {
    const p = builtinFabProfile("jlcpcb")!;
    expect(() => generateKicadProject(p, { ...defaultChoices(p), layers: 8 }, opts)).toThrow(/8 layers/);
    expect(() => generateKicadProject(p, { ...defaultChoices(p), layers: 4, thicknessMm: 1.2, stackup: "JLC04161H-7628" }, opts)).toThrow(/stackup/);
  });
});

describe("name and folder rules", () => {
  test.each([
    ["blinky", null],
    ["my board v2", null],
    ["", "Enter a name."],
    [" lead", "The name can't start or end with a space."],
    ["a/b", expect.stringMatching(/can't contain/)],
    [".hidden", "The name can't start with a dot."],
  ])("name %j", (name, want) => {
    expect(validateKicadProjectName(name)).toEqual(want);
  });

  test("folders", () => {
    expect(validateKicadProjectDir("")).toBeNull();
    expect(validateKicadProjectDir("hw/main")).toBeNull();
    expect(validateKicadProjectDir("../x")).not.toBeNull();
    expect(validateKicadProjectDir("/abs")).not.toBeNull();
  });
});
