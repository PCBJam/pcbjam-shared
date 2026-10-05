import { describe, expect, it, test } from "vitest";
import {
  bundledLibDir,
  carriedKicadProjects,
  isLockfilePath,
  kicadProjectsByPath,
  kicadProjectsForDir,
  lockfileDirOf,
  lockfileOwnerDirs,
  lockfilePathFor,
  mergeLockfiles,
  ownerDirOf,
  parseLockfile,
  serializeLockfile,
  type Lockfile,
} from "../src/index.js";

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

describe("one lockfile per KiCad project folder (git-integration 0018)", () => {
  const rec = { profile: "jlcpcb", profileVersion: 3, choices: { layers: 2 }, generatedAt: "2026-10-05T10:00:00.000Z" } as never;

  test("owner folders: nested projects, two .kicad_pro in one folder, files under none", () => {
    const owners = lockfileOwnerDirs(["a/a.kicad_pro", "a/x.kicad_pro", "a/sub/s.kicad_pro", "root.kicad_pro", "b/b.kicad_sch"]);
    expect(owners).toEqual(["", "a", "a/sub"]);
    expect(ownerDirOf("a/sub/deep/s.kicad_sch", owners)).toBe("a/sub");
    expect(ownerDirOf("a/a.kicad_pcb", owners)).toBe("a");
    expect(ownerDirOf("b/b.kicad_sch", owners)).toBe("");
    expect(ownerDirOf("b/b.kicad_sch", ["a"])).toBeNull();
  });

  test("lockfile paths", () => {
    expect(lockfilePathFor("")).toBe("pcbjam.lock.json");
    expect(lockfilePathFor("b")).toBe("b/pcbjam.lock.json");
    expect(isLockfilePath("b/pcbjam.lock.json")).toBe(true);
    expect(isLockfilePath("b/other.json")).toBe(false);
    expect(lockfileDirOf("b/c/pcbjam.lock.json")).toBe("b/c");
  });

  test("records: folder-relative keys, legacy root-relative keys read as is", () => {
    const byPath = kicadProjectsByPath("a", { "a.kicad_pro": rec, "b/b.kicad_pro": rec });
    expect(Object.keys(byPath).sort()).toEqual(["a/a.kicad_pro", "b/b.kicad_pro"]);
    expect(Object.keys(kicadProjectsForDir("a", byPath)!)).toEqual(["a.kicad_pro"]);
    expect(Object.keys(kicadProjectsForDir("b", byPath)!)).toEqual(["b.kicad_pro"]);
    expect(kicadProjectsForDir("c", byPath)).toBeUndefined();
  });

  test("mergeLockfiles: bundled paths from the root, one entry per library, bundled wins", () => {
    const lib = (over: object) => ({ nickname: "Device", kinds: ["symbol"], libId: "L1", type: "origin", revision: null, bundled: false, ...over }) as never;
    const merged = mergeLockfiles([
      { path: "b/pcbjam.lock.json", lock: { version: 1, generatedAt: "t", libs: [lib({ bundled: "used-items", path: "libs/Device" })], kicadProjects: { "b.kicad_pro": rec } } },
      { path: "a/pcbjam.lock.json", lock: { version: 1, generatedAt: "t", libs: [lib({}), lib({ libId: "L2", nickname: "Other" })] } },
    ])!;
    expect(merged.libs.map((l) => [l.libId, l.path ?? null])).toEqual([
      ["L1", "b/libs/Device"],
      ["L2", null],
    ]);
    expect(Object.keys(merged.kicadProjects!)).toEqual(["b/b.kicad_pro"]);
    expect(mergeLockfiles([])).toBeNull();
  });
});
