import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docToFile, fileToDoc, kicadDocSchema, renderItem } from "../src/kicad-doc.js";
import { directUuid, parseSexpr, type SNode } from "../src/sexpr.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "kicad");
const KICAD_EXT = /\.(kicad_pcb|kicad_sch|kicad_wks|kicad_sym)$/;

/** Recursively collect every KiCad file under the fixtures dir. */
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

// ── Converter unit tests (hand-built docs, no wasm) ──────────────────────────

describe("fileToDoc / docToFile", () => {
  const SAMPLE = `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (uuid "doc-id-not-an-item")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (uuid "seg-1"))
  (via (at 5 5) (size 0.8) (uuid "via-1"))
)`;

  it("keys top-level uuid items, preserves order in layout", () => {
    const doc = fileToDoc(SAMPLE);
    expect(doc.root).toBe("kicad_pcb");
    expect(Object.keys(doc.items).sort()).toEqual(["seg-1", "via-1"]);
    expect(doc.items["seg-1"]!.type).toBe("segment");
    expect(doc.items["seg-1"]!.parent).toBe(null);
    const kinds = doc.layout.map((e) => ("item" in e ? `item:${e.item}` : "raw"));
    expect(kinds).toEqual(["raw", "raw", "raw", "raw", "item:seg-1", "item:via-1"]);
    expect(kicadDocSchema.safeParse(doc).success).toBe(true);
  });

  it("the document's own (uuid …) is NOT treated as an item", () => {
    expect(fileToDoc(SAMPLE).items["doc-id-not-an-item"]).toBeUndefined();
  });

  it("flattens NESTED uuid items with parent links, by reference not inline", () => {
    const NESTED = `(kicad_pcb
  (footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
    (pad "1" smd (at 0 0) (uuid "pad-1"))
  )
)`;
    const doc = fileToDoc(NESTED);
    // footprint + its field + its pad are all top-level keys.
    expect(Object.keys(doc.items).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);
    expect(doc.items["fp-1"]!.parent).toBe(null);
    expect(doc.items["pad-1"]!.parent).toBe("fp-1");
    expect(doc.items["fld-1"]!.parent).toBe("fp-1");
    // The footprint references its children rather than embedding their content.
    const refs = doc.items["fp-1"]!.body.flatMap((e) => ("item" in e ? [e.item] : []));
    expect(refs.sort()).toEqual(["fld-1", "pad-1"]);
    // …and still round-trips structurally.
    expect(parseSexpr(docToFile(doc))).toEqual(parseSexpr(NESTED));
    // renderItem rebuilds a single nested item's full s-expr.
    expect(parseSexpr(renderItem(doc, "pad-1"))).toEqual(
      parseSexpr(`(pad "1" smd (at 0 0) (uuid "pad-1"))`),
    );
  });

  it("round-trips structurally (docToFile ∘ fileToDoc)", () => {
    expect(parseSexpr(docToFile(fileToDoc(SAMPLE)))).toEqual(parseSexpr(SAMPLE));
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
        // Item uuids = every uuid in the root's CHILDREN subtrees. The root form's
        // own (uuid …) is the document identity, not an item (stays in layout).
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
