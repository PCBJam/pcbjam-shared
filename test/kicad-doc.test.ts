import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docToFile, fileToDoc, kicadDocSchema } from "../src/kicad-doc.js";
import { parseSexpr } from "../src/sexpr.js";

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
    expect(doc.items["via-1"]!.type).toBe("via");
    // version/generator/uuid/layers are raw (no direct uuid child); items are refs.
    const kinds = doc.layout.map((e) => ("item" in e ? `item:${e.item}` : "raw"));
    expect(kinds).toEqual(["raw", "raw", "raw", "raw", "item:seg-1", "item:via-1"]);
    expect(kicadDocSchema.safeParse(doc).success).toBe(true);
  });

  it("the document's own (uuid …) is NOT treated as an item", () => {
    const doc = fileToDoc(SAMPLE);
    expect(doc.items["doc-id-not-an-item"]).toBeUndefined();
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
    it(path.relative(FIXTURES, file), () => {
      const text = fs.readFileSync(file, "utf8");
      const doc = fileToDoc(text);
      // The decomposition validates against the schema…
      expect(kicadDocSchema.safeParse(doc).success).toBe(true);
      // …and reassembly is structurally identical to the original (lossless).
      expect(parseSexpr(docToFile(doc))).toEqual(parseSexpr(text));
    });
  }
});
