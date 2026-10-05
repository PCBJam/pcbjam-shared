import { describe, expect, it } from "vitest";
import { KICAD_GITIGNORE } from "../src/kicad-gitignore.js";

describe("KICAD_GITIGNORE", () => {
  it("is LF-only text ending with a newline", () => {
    expect(KICAD_GITIGNORE.includes("\r")).toBe(false);
    expect(KICAD_GITIGNORE.endsWith("\n")).toBe(true);
  });

  it("ignores KiCad backups, autosaves, lock files and per-user settings", () => {
    const lines = KICAD_GITIGNORE.split("\n");
    for (const rule of ["*-backups", "_autosave-*", "~*.lck", "fp-info-cache", "*.kicad_prl", "\\#auto_saved_files\\#"]) {
      expect(lines).toContain(rule);
    }
  });
});
