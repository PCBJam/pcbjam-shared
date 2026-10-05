import { describe, expect, it, test } from "vitest";
import { bundledLibDir, carriedKicadProjects, parseLockfile, serializeLockfile, type Lockfile } from "../src/index.js";

describe("lockfile wire", () => {
  it("round-trips a v1 lockfile and rejects other shapes", () => {
    const lock: Lockfile = {
      version: 1,
      generatedAt: "2026-09-23T12:00:00.000Z",
      projectId: "p",
      libs: [
        { nickname: "Device", kinds: ["symbol"], libId: "l1", type: "origin", revision: "sha256:ab", source: { provenance: "kicad-official", ref: "kicad-symbols@10.0.3" }, bundled: false, license: "CC-BY-SA-4.0" },
        { nickname: "Device", kinds: ["symbol"], libId: "l2", type: "mirror", originLibId: "l1", overlayScopeId: "s", revision: null, bundled: "used-items", path: "libs/Device", items: { symbol: ["R"] } },
        { nickname: "acme", kinds: ["symbol", "footprint", "model"], libId: "l3", type: "team", revision: "sha256:cd", bundled: "whole", path: "libs/acme", git: { repoUrl: "git@x:y.git", ref: "main" } },
      ],
    };
    const text = serializeLockfile(lock);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseLockfile(text)).toEqual(lock);
    expect(parseLockfile(JSON.stringify({ version: 2, generatedAt: "", libs: [] }))).toBeNull();
    expect(parseLockfile("not json")).toBeNull();
    expect(bundledLibDir("Device")).toBe("libs/Device");
  });
});

describe("lockfile kicadProjects section (new-kicad-project 0001)", () => {
  const entry = {
    profile: "jlcpcb",
    profileVersion: 1,
    choices: { layers: 4, tier: "standard", thicknessMm: 1.6, copperOuter: 1, copperInner: 0.5, stackup: "JLC04161H-7628" },
    generatedAt: "2026-10-05T10:00:00.000Z",
  };

  test("a v1 lockfile with and without the section round-trips", () => {
    const without = { version: 1 as const, generatedAt: "2026-10-05T10:00:00.000Z", libs: [] };
    expect(parseLockfile(serializeLockfile(without))).toEqual(without);
    const withSection = { ...without, kicadProjects: { "blinky/blinky.kicad_pro": entry } };
    expect(parseLockfile(serializeLockfile(withSection))).toEqual(withSection);
  });

  test("carriedKicadProjects reads the section on its own", () => {
    const text = JSON.stringify({ version: 1, generatedAt: "x", libs: "broken", kicadProjects: { "a.kicad_pro": entry } });
    expect(carriedKicadProjects(text)).toEqual({ "a.kicad_pro": entry });
    expect(carriedKicadProjects(null)).toBeUndefined();
    expect(carriedKicadProjects("not json")).toBeUndefined();
    expect(carriedKicadProjects(JSON.stringify({ kicadProjects: {} }))).toBeUndefined();
  });
});
