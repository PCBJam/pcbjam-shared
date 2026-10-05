import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { compareDriftLayouts } from "../src/kicad-delta.js";
import { docToFile, fileToDoc } from "../src/kicad-doc.js";
import { seedDocToY, syncLayoutToY, yToDoc } from "../src/kicad-y.js";

// A sheet file's root-only sections depend on how the editor OPENED it
// (standalone subsheet → it becomes a root; former root under the project root → not).
const sheet = (trailer = "") =>
  `(kicad_sch (version 20250114) (generator "eeschema") (paper "A4")
    (symbol (lib_id "Device:R") (at 10 10 0) (uuid "sym-1")) ${trailer})`;
const INST = `(sheet_instances (path "/" (page "1")))`;
const FONTS = `(embedded_fonts no)`;

describe("schematic root-context sections (sheet_instances, embedded_fonts, …)", () => {
  it("drift: a standalone-opened subsheet's added sheet_instances is not drift", () => {
    expect(compareDriftLayouts(fileToDoc(sheet()), fileToDoc(sheet(INST)))).not.toBe("different");
  });

  it("drift: a former root's embedded_fonts missing from the editor save is not drift", () => {
    expect(compareDriftLayouts(fileToDoc(sheet(FONTS)), fileToDoc(sheet()))).not.toBe("different");
  });

  it("drift: a CONTENT change while both sides have the section is still drift", () => {
    const peer = `(sheet_instances (path "/" (page "2")))`;
    expect(compareDriftLayouts(fileToDoc(sheet(INST)), fileToDoc(sheet(peer)))).toBe("different");
  });

  it("drift: boards are untouched by the rule (an added embedded_files is an edit)", () => {
    const board = (t = "") => fileToDoc(`(kicad_pcb (version 20241229) (paper "A4") ${t})`);
    expect(compareDriftLayouts(board(), board(`(embedded_files (file (name "x.ttf") (type font)))`))).toBe("different");
  });

  it("save-sync: a standalone subsheet's save never adds sheet_instances to its room", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet());
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(fileToDoc(sheet(INST)), doc, "layout-save", opened);
    expect(docToFile(yToDoc(doc))).not.toContain("sheet_instances");
  });

  it("save-sync: a save without embedded_fonts never removes it from the room", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(FONTS));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(fileToDoc(sheet()), doc, "layout-save", opened);
    expect(docToFile(yToDoc(doc))).toContain("(embedded_fonts no)");
  });

  it("save-sync: a page-number change still syncs while both sides have the section", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(INST));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(fileToDoc(sheet(`(sheet_instances (path "/" (page "7")))`)), doc, "layout-save", opened);
    expect(docToFile(yToDoc(doc))).toContain('(page "7")');
  });
});
