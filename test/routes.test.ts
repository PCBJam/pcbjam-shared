import { describe, expect, it } from "vitest";
import {
  fileExt,
  libPath,
  parseProjectTarget,
  parseToolParam,
  projectPath,
  projectToolPath,
  toolForFile,
  toolForLibFile,
  toolForLibKind,
} from "../src/routes.js";

describe("URL builders", () => {
  it("builds project paths", () => {
    expect(projectPath("myorg", "myproject")).toBe("/myorg/projects/myproject");
    expect(projectPath("myorg", "myproject", "pcbnew/board.kicad_pcb")).toBe(
      "/myorg/projects/myproject/pcbnew/board.kicad_pcb",
    );
  });

  it("percent-encodes only the free-form file path segments", () => {
    expect(projectPath("@local", "uploaded", "sub dir/a b.kicad_sch")).toBe(
      "/@local/projects/uploaded/sub%20dir/a%20b.kicad_sch",
    );
  });

  it("builds a fileless tool boot under a project", () => {
    expect(projectToolPath("myorg", "proj", "calculator")).toBe(
      "/myorg/projects/proj/-/calculator",
    );
  });

  it("builds library paths", () => {
    expect(libPath("kicad", "Device")).toBe("/kicad/libs/Device");
  });
});

describe("tool inference", () => {
  it("reads the lowercased extension", () => {
    expect(fileExt("a/b/Board.KiCad_Pcb")).toBe(".kicad_pcb");
    expect(fileExt("noext")).toBe("");
    expect(fileExt(".gitignore")).toBe("");
  });

  it("maps document files to their tool", () => {
    expect(toolForFile("x/board.kicad_pcb")).toBe("pcbnew");
    expect(toolForFile("x/sheet.kicad_sch")).toBe("eeschema");
    expect(toolForFile("x/frame.kicad_wks")).toBe("pl_editor");
  });

  it("maps gerber/drill artifacts to the gerber viewer", () => {
    expect(toolForFile("gerbers/top.gtl")).toBe("gerbview");
    expect(toolForFile("gerbers/drill.drl")).toBe("gerbview");
  });

  it("returns null for unknown extensions", () => {
    expect(toolForFile("readme.txt")).toBeNull();
  });

  it("maps lib files + kinds to their editor", () => {
    expect(toolForLibFile("Device.kicad_sym")).toBe("symbol_editor");
    expect(toolForLibFile("R.kicad_mod")).toBe("footprint_editor");
    expect(toolForLibKind("symbol")).toBe("symbol_editor");
    expect(toolForLibKind("footprint")).toBe("footprint_editor");
  });

  it("parses the ?tool= override", () => {
    expect(parseToolParam("gerbview")).toBe("gerbview");
    expect(parseToolParam("bogus")).toBeNull();
    expect(parseToolParam(null)).toBeNull();
  });
});

describe("parseProjectTarget", () => {
  it("treats an empty splat as the overview", () => {
    expect(parseProjectTarget("")).toEqual({ kind: "overview" });
    expect(parseProjectTarget(undefined)).toEqual({ kind: "overview" });
  });

  it("treats a -/<tool> splat as a fileless tool boot", () => {
    expect(parseProjectTarget("-/calculator")).toEqual({
      kind: "tool",
      tool: "calculator",
    });
  });

  it("falls back to overview for an unknown tool name", () => {
    expect(parseProjectTarget("-/bogus")).toEqual({ kind: "overview" });
  });

  it("treats anything else as a file path and infers its tool", () => {
    expect(parseProjectTarget("pcbnew/board.kicad_pcb")).toEqual({
      kind: "file",
      filePath: "pcbnew/board.kicad_pcb",
      tool: "pcbnew",
    });
    expect(parseProjectTarget("notes.txt")).toEqual({
      kind: "file",
      filePath: "notes.txt",
      tool: null,
    });
  });
});
