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

  // Embedding the first font (fonts 0001): between two ROOT views of a sheet (the save and
  // the room both carry sheet_instances) the embedded files are document content.
  const EMB = `(embedded_files (file (name "x.ttf") (type font) (data |KLUv/QBYAQ==|) (checksum "AB")))`;

  it("save-sync: embedding the first font in a root sheet adds embedded_files to its room", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(`${INST} ${FONTS}`));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(fileToDoc(sheet(`${INST} (embedded_fonts yes) ${EMB}`)), doc, "layout-save", opened);
    const room = docToFile(yToDoc(doc));
    expect(room).toContain("(embedded_fonts yes)");
    expect(room).toContain('(name "x.ttf")');
  });

  it("save-sync: removing a root sheet's last embedded file removes it from the room", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(`${INST} (embedded_fonts yes) ${EMB}`));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(fileToDoc(sheet(`${INST} ${FONTS}`)), doc, "layout-save", opened);
    expect(docToFile(yToDoc(doc))).not.toContain("embedded_files");
  });

  it("save-sync: a standalone subsheet's save still never adds embedded_files to its room", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet());
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(fileToDoc(sheet(`${INST} (embedded_fonts yes) ${EMB}`)), doc, "layout-save", opened);
    const room = docToFile(yToDoc(doc));
    expect(room).not.toContain("embedded_files");
    expect(room).not.toContain("sheet_instances");
  });

  // Embedded files merge per file (fonts 0001, live embedding): two writers who each embedded
  // a font both keep theirs.
  const file = (name: string, data = "KLUv/QBYAQ==") =>
    `(file (name "${name}") (type font) (data |${data}|) (checksum "${name.length}"))`;
  const embedded = (...names: string[]) => `(embedded_fonts yes) (embedded_files ${names.map((n) => file(n)).join(" ")})`;
  // What the editor emits live: the two heads, marked as the root view (embedded_sync.h).
  const live = (...names: string[]) =>
    fileToDoc(`(kicad_sch (version 20250114) (generator "eeschema") (sheet_instances) ${embedded(...names)})`);
  const HEADS = new Set(["embedded_fonts", "embedded_files"]);
  const names = (doc: Y.Doc) => [...docToFile(yToDoc(doc)).matchAll(/\(name "([^"]+)"\)/g)].map((m) => m[1]);

  it("live: a font embedded from the editor reaches a root sheet's room without a save", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(`${INST} ${FONTS}`));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(live("Zapfino.ttf"), doc, "embedded", opened, { heads: HEADS });
    const room = docToFile(yToDoc(doc));
    expect(room).toContain("(embedded_fonts yes)");
    expect(names(doc)).toEqual(["Zapfino.ttf"]);
    expect(room).toContain("(paper \"A4\")"); // other heads untouched
  });

  it("live: two writers who each embedded a font both keep theirs", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(`${INST} ${FONTS}`));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(live("Zapfino.ttf"), doc, "embedded", opened, { heads: HEADS }); // tab A
    syncLayoutToY(live("Trattatello.ttf"), doc, "embedded", opened, { heads: HEADS }); // tab B, stale
    expect(names(doc).sort()).toEqual(["Trattatello.ttf", "Zapfino.ttf"]);
  });

  it("live: a writer that added a font next to a peer's keeps the peer's, and a removal still removes", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet(`${INST} ${embedded("A.ttf")}`));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(live("A.ttf", "Zapfino.ttf"), doc, "embedded", opened, { heads: HEADS }); // peer
    syncLayoutToY(live("A.ttf", "Noto.ttf"), doc, "embedded", opened, { heads: HEADS }); // stale writer
    expect(names(doc).sort()).toEqual(["A.ttf", "Noto.ttf", "Zapfino.ttf"]);
    syncLayoutToY(live("Noto.ttf"), doc, "embedded", live("A.ttf", "Noto.ttf"), { heads: HEADS }); // removes A
    expect(names(doc).sort()).toEqual(["Noto.ttf", "Zapfino.ttf"]);
  });

  it("live: a subsheet's room never takes the root's embedded files", () => {
    const doc = new Y.Doc();
    const opened = fileToDoc(sheet());
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(live("Zapfino.ttf"), doc, "embedded", opened, { heads: HEADS });
    expect(docToFile(yToDoc(doc))).not.toContain("embedded_files");
  });
});
