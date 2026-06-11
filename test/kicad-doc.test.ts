import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  args,
  docToFile,
  field,
  fields,
  fileToDoc,
  kicadDocSchema,
  renderItem,
  scalar,
  type Slot,
} from "../src/kicad-doc.js";
import { directUuid, parseSexpr, type SNode } from "../src/sexpr.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "kicad");
const KICAD_EXT = /\.(kicad_pcb|kicad_sch|kicad_wks|kicad_sym)$/;

function listFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFixtures(full));
    else if (KICAD_EXT.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/** Every uuid that appears as a direct (uuid "X") child of a list node, anywhere. */
function allUuids(node: SNode, acc: Set<string> = new Set()): Set<string> {
  if (!Array.isArray(node)) return acc;
  const id = directUuid(node);
  if (id !== null) acc.add(id);
  for (const c of node) allUuids(c, acc);
  return acc;
}

/** Keys of the field slots in order (helper for assertions). */
function keys(slots: Slot[]): string[] {
  return slots.flatMap((s) => ("k" in s ? [s.k] : []));
}

// ── Structure: the generic ground rule ───────────────────────────────────────

describe("slot structure", () => {
  it("scalar / tuple / nested-object fields", () => {
    const d = fileToDoc(`(kicad_pcb (thickness 1.6) (at 1 2 90) (stroke (width 0) (type solid)))`);
    expect(scalar(d.layout, "thickness")).toBe("1.6");
    expect(args(field(d.layout, "at")!)).toEqual(["1", "2", "90"]);
    const stroke = field(d.layout, "stroke")!;
    expect(scalar(stroke, "width")).toBe("0");
    expect(scalar(stroke, "type")).toBe("solid");
  });

  it("keeps atoms verbatim (quoting, trailing zeros) — no coercion", () => {
    const d = fileToDoc(`(kicad_pcb (fill (color 0 0 0 0.0000)) (val "5"))`);
    const fill = field(d.layout, "fill")!;
    expect(args(field(fill, "color")!)).toEqual(["0", "0", "0", "0.0000"]); // trailing zeros kept
    expect(scalar(d.layout, "val")).toBe('"5"'); // quoted string stays distinct from bare 5
  });

  it("layers: numeric ids keep FILE order (not sorted), variable arity", () => {
    const d = fileToDoc(
      `(kicad_pcb (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive")))`,
    );
    const layers = field(d.layout, "layers")!;
    expect(keys(layers)).toEqual(["0", "4", "2", "9"]); // 4 before 2, preserved
    expect(args(field(layers, "9")!)).toEqual(['"F.Adhes"', "user", '"F.Adhesive"']);
  });

  it("stackup / repeated keys: every occurrence kept, in order", () => {
    const d = fileToDoc(
      `(kicad_pcb (setup (stackup (layer "F.SilkS" (type "Top Silk Screen")) (layer "F.Cu" (type "copper") (thickness 0.035)))))`,
    );
    const stackup = field(field(d.layout, "setup")!, "stackup")!;
    const layerVals = fields(stackup, "layer");
    expect(layerVals).toHaveLength(2);
    expect(args(layerVals[0]!)).toEqual(['"F.SilkS"']);
    expect(scalar(layerVals[1]!, "thickness")).toBe("0.035");
  });
});

// ── Flatten + parent links ───────────────────────────────────────────────────

describe("fileToDoc / docToFile", () => {
  const NESTED = `(kicad_pcb
  (uuid "doc-id-not-an-item")
  (footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
    (pad "1" smd (at 0 0) (uuid "pad-1"))
  )
)`;

  it("flattens nested uuid items with parent links, by reference", () => {
    const d = fileToDoc(NESTED);
    expect(Object.keys(d.items).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);
    expect(d.items["fp-1"]!.parent).toBe(null);
    expect(d.items["pad-1"]!.parent).toBe("fp-1");
    expect(d.items["fld-1"]!.parent).toBe("fp-1");
    // The footprint references its children, not inlines them.
    const refs = d.items["fp-1"]!.body.flatMap((s) => ("item" in s ? [s.item] : []));
    expect(refs.sort()).toEqual(["fld-1", "pad-1"]);
    // Leading positional atoms survive as atom slots.
    expect(args(d.items["fp-1"]!.body)).toEqual(['"lib:R"']);
    expect(args(d.items["pad-1"]!.body)).toEqual(['"1"', "smd"]);
  });

  it("the document's own (uuid …) is NOT an item (stays a uuid field)", () => {
    const d = fileToDoc(NESTED);
    expect(d.items["doc-id-not-an-item"]).toBeUndefined();
    expect(scalar(d.layout, "uuid")).toBe('"doc-id-not-an-item"');
  });

  it("renderItem rebuilds a single nested item's full s-expr", () => {
    const d = fileToDoc(NESTED);
    expect(parseSexpr(renderItem(d, "pad-1"))).toEqual(parseSexpr(`(pad "1" smd (at 0 0) (uuid "pad-1"))`));
  });

  it("round-trips structurally (docToFile ∘ fileToDoc)", () => {
    expect(parseSexpr(docToFile(fileToDoc(NESTED)))).toEqual(parseSexpr(NESTED));
  });

  it("rejects text that is not a single top-level form", () => {
    expect(() => fileToDoc("(a) (b)")).toThrow(/one top-level/);
  });

  it("docToFile throws on a dangling item reference", () => {
    expect(() =>
      docToFile({ root: "kicad_pcb", items: {}, layout: [{ item: "missing" }] }),
    ).toThrow(/missing item/);
  });
});

// ── Lossless round trip over real OSS fixtures (auto-discovered) ──────────────
//
// Drop any .kicad_pcb/.kicad_sch/.kicad_wks/.kicad_sym into test/fixtures/kicad/
// (any depth) and it is tested automatically on the next run.

describe("kicad file ⇄ doc round trip (real fixtures)", () => {
  const files = listFixtures(FIXTURES);

  it("has at least one fixture", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(path.relative(FIXTURES, file), () => {
      const text = fs.readFileSync(file, "utf8");
      const doc = fileToDoc(text);

      it("decomposition validates against the schema", () => {
        expect(kicadDocSchema.safeParse(doc).success).toBe(true);
      });

      it("flattens every item uuid in the file", () => {
        const root = parseSexpr(text)[0] as SNode[];
        const inFile = new Set<string>();
        for (const child of root.slice(1)) allUuids(child, inFile);
        expect(new Set(Object.keys(doc.items))).toEqual(inFile);
      });

      it("reassembles structurally identical text (lossless)", () => {
        expect(parseSexpr(docToFile(doc))).toEqual(parseSexpr(text));
      });
    });
  }
});
