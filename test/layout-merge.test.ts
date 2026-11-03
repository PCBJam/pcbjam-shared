import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docToFile, fileToDoc, type Slot } from "../src/kicad-doc.js";
import { seedDocToY, syncLayoutToY, yToDoc } from "../src/kicad-y.js";
import { merge3Slots } from "../src/layout-merge.js";

const layout = (text: string) => fileToDoc(`(kicad_pcb (version 20241229) ${text})`).layout;
const render = (slots: ReturnType<typeof layout>) =>
  docToFile({ root: "kicad_pcb", items: {}, layout: slots });

describe("merge3Slots (proposal 21 WP1)", () => {
  it("title vs revision in one title_block: both survive (SYNC-06b)", () => {
    const base = layout(`(title_block (title "Initial") (rev "1"))`);
    const theirs = layout(`(title_block (title "Remote title") (rev "1"))`);
    const mine = layout(`(title_block (title "Initial") (rev "2"))`);
    const out = render(merge3Slots(base, mine, theirs));
    expect(out).toContain('(title "Remote title")');
    expect(out).toContain('(rev "2")');
  });

  it("a stale setup edit keeps the peer's 4-layer stackup (layer-drift case 3)", () => {
    const stack2 = `(stackup (layer "F.Cu" (type "copper")) (layer "B.Cu" (type "copper")))`;
    const stack4 = `(stackup (layer "F.Cu" (type "copper")) (layer "In1.Cu" (type "copper")) (layer "In2.Cu" (type "copper")) (layer "B.Cu" (type "copper")))`;
    const base = layout(`(setup ${stack2} (pad_to_mask_clearance 0))`);
    const theirs = layout(`(setup ${stack4} (pad_to_mask_clearance 0))`);
    const mine = layout(`(setup ${stack2} (pad_to_mask_clearance 0.05))`);
    const out = render(merge3Slots(base, mine, theirs));
    expect(out).toContain('(layer "In1.Cu"');
    expect(out).toContain("(pad_to_mask_clearance 0.05)");
    // order preserved: In1/In2 between F and B
    expect(out.indexOf('"F.Cu"')).toBeLessThan(out.indexOf('"In1.Cu"'));
    expect(out.indexOf('"In2.Cu"')).toBeLessThan(out.indexOf('"B.Cu"'));
  });

  it("two peers renaming DIFFERENT layers both keep their rename", () => {
    const base = layout(`(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (50 "User.1" user) (52 "User.2" user))`);
    const theirs = layout(`(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (50 "User.1" user "Fab") (52 "User.2" user))`);
    const mine = layout(`(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (50 "User.1" user) (52 "User.2" user "Notes"))`);
    const out = render(merge3Slots(base, mine, theirs));
    expect(out).toContain('"Fab"');
    expect(out).toContain('"Notes"');
  });

  it("comments are keyed by their number, not by occurrence", () => {
    const base = layout(`(title_block (comment 2 "two"))`);
    const theirs = layout(`(title_block (comment 2 "two-peer"))`);
    const mine = layout(`(title_block (comment 1 "one") (comment 2 "two"))`);
    const out = render(merge3Slots(base, mine, theirs));
    expect(out).toContain('(comment 1 "one")');
    expect(out).toContain('(comment 2 "two-peer")');
  });

  it("a field the writer deleted is deleted; a field the peer added survives", () => {
    const base = layout(`(title_block (title "t") (company "c"))`);
    const theirs = layout(`(title_block (title "t") (company "c") (date "2026-09-30"))`);
    const mine = layout(`(title_block (title "t"))`);
    const out = render(merge3Slots(base, mine, theirs));
    expect(out).not.toContain("company");
    expect(out).toContain('(date "2026-09-30")');
  });

  it("same field changed on both sides: the writer (latest write) wins", () => {
    const base = layout(`(paper "A4")`);
    expect(render(merge3Slots(base, layout(`(paper "A3")`), layout(`(paper "A2")`)))).toContain('"A3"');
  });
});

describe("syncLayoutToY with a baseline merges per field (SYNC-06b through the real write path)", () => {
  const board = (tb: string) => fileToDoc(`(kicad_pcb (version 20241229) (paper "A4") ${tb}
    (segment (start 0 0) (end 1 1) (width 0.25) (layer "F.Cu") (uuid "seg-1")))`);

  it("a stale revision save keeps the peer's newer title", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u));
    const initial = board(`(title_block (title "Initial") (rev "1"))`);
    seedDocToY(initial, a, "seed", "n");
    // Peer saves a new title.
    syncLayoutToY(board(`(title_block (title "Remote title") (rev "1"))`), b, "layout-save", initial);
    // This editor never applied it; it saves a revision bump.
    syncLayoutToY(board(`(title_block (title "Initial") (rev "2"))`), a, "layout-save", initial);
    const text = docToFile(yToDoc(a));
    expect(text).toContain('(title "Remote title")');
    expect(text).toContain('(rev "2")');
  });
});

describe("merge3Slots: embedded files", () => {
  const f = (name: string, data: string): Slot => ({
    k: "file",
    v: [
      { k: "name", v: [{ atom: `"${name}"` }] },
      { k: "data", v: [{ atom: data }] },
    ],
  });

  it("keys files by name, so one added on each side is kept on both", () => {
    const merged = merge3Slots([], [f("a.ttf", "1")], [f("b.ttf", "2")]);
    expect(merged).toHaveLength(2);
    expect(merged).toEqual(expect.arrayContaining([f("a.ttf", "1"), f("b.ttf", "2")]));
  });

  it("a file both sides changed is the writer's", () => {
    expect(merge3Slots([f("a.ttf", "0")], [f("a.ttf", "1")], [f("a.ttf", "2")])).toEqual([f("a.ttf", "1")]);
  });
});

describe("syncLayoutToY: the embedded files budget (fonts 0001)", () => {
  // Boards: no root-context rule, the embedded files are plain content.
  const board = (files: string) =>
    fileToDoc(`(kicad_pcb (version 20241229) (paper "A4")
      (embedded_files ${files})
      (segment (start 0 0) (end 1 1) (width 0.25) (layer "F.Cu") (uuid "seg-1")))`);
  const file = (name: string, size: number) => `(file (name "${name}") (type font) (data "${"A".repeat(size)}"))`;
  const names = (doc: Y.Doc) => [...docToFile(yToDoc(doc)).matchAll(/\(file \(name "([^"]+)"\)/g)].map((m) => m[1]);

  it("a merge past the budget is not written, and the caller hears its size", () => {
    const doc = new Y.Doc();
    const opened = board(file("a.ttf", 100));
    seedDocToY(opened, doc, "seed", "n");
    const sizes: number[] = [];
    const changed = syncLayoutToY(board(file("a.ttf", 100) + file("big.ttf", 5000)), doc, "layout-save", opened, {
      embeddedFilesBudget: 1000,
      onEmbeddedOverBudget: (size) => sizes.push(size),
    });
    expect(changed).toBe(false);
    expect(names(doc)).toEqual(["a.ttf"]);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeGreaterThan(5000);
  });

  it("a merge within the budget is written", () => {
    const doc = new Y.Doc();
    const opened = board(file("a.ttf", 100));
    seedDocToY(opened, doc, "seed", "n");
    const over = () => {
      throw new Error("not over the budget");
    };
    syncLayoutToY(board(file("a.ttf", 100) + file("b.ttf", 100)), doc, "layout-save", opened, {
      embeddedFilesBudget: 1000,
      onEmbeddedOverBudget: over,
    });
    expect(names(doc)).toEqual(["a.ttf", "b.ttf"]);
  });

  it("removing files from a room already past the budget is written", () => {
    const doc = new Y.Doc();
    const opened = board(file("a.ttf", 3000) + file("b.ttf", 3000));
    seedDocToY(opened, doc, "seed", "n");
    syncLayoutToY(board(file("a.ttf", 3000)), doc, "layout-save", opened, { embeddedFilesBudget: 1000 });
    expect(names(doc)).toEqual(["a.ttf"]);
  });
});
