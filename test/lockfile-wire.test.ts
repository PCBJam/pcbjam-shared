import { describe, expect, it } from "vitest";
import { bundledLibDir, parseLockfile, serializeLockfile, type Lockfile } from "../src/index.js";

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
