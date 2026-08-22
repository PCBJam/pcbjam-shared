import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docToFile,
  fileToDoc,
} from "../src/kicad-doc.js";
import { analyzeKicadDocGraph } from "../src/kicad-graph.js";
import { docToY, yToDoc } from "../src/kicad-y.js";
import { parseSexpr } from "../src/sexpr.js";

/**
 * App-free gate over pinned upstream KiCad demo/QA designs.
 *
 * The smaller fixture suite proves the same conversion laws on focused
 * examples. This corpus adds dense production-shaped files, groups, generated
 * tuning patterns, zones, anonymous ordered sequences and an old migration
 * file. It crosses Yjs' encoded-update boundary into a fresh Y.Doc and compares
 * the complete parsed file, including layout/meta and anonymous order.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

const CORPUS = [
  ["app demo board", "tests/fixtures/demo/demo.kicad_pcb"],
  ["app demo schematic", "tests/fixtures/demo/demo.kicad_sch"],
  ["newest grammar board", "kicad/demos/pic_programmer/pic_programmer.kicad_pcb"],
  [
    "newest grammar schematic",
    "kicad/demos/pic_programmer/pic_programmer.kicad_sch",
  ],
  ["dense grouped board", "kicad/demos/stickhub/StickHub.kicad_pcb"],
  [
    "dimension with writer-owned repeated UUID",
    "kicad/qa/data/pcbnew/issue23704/issue23704.kicad_pcb",
  ],
  [
    "generated tuning-pattern board",
    "kicad/qa/data/pcbnew/diff_pair_uncoupled_tuning_drc.kicad_pcb",
  ],
  ["legacy migration board", "kicad/qa/data/pcbnew/issue6039.kicad_pcb"],
] as const;

describe("real KiCad corpus: file -> Yjs update -> fresh Yjs -> file", () => {
  for (const [label, relative] of CORPUS) {
    it(label, () => {
      const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
      const source = fileToDoc(text);
      expect(analyzeKicadDocGraph(source).issues, `${relative}: source graph`).toEqual([]);

      const author = new Y.Doc();
      const remote = new Y.Doc();
      try {
        docToY(source, author, "real-corpus-seed");
        const update = Y.encodeStateAsUpdate(author);
        Y.applyUpdate(remote, update, "real-corpus-wire");
        // Duplicate delivery must be harmless at the actual Yjs wire boundary.
        Y.applyUpdate(remote, update, "real-corpus-duplicate");

        const materialized = yToDoc(remote);
        expect(
          analyzeKicadDocGraph(materialized).issues,
          `${relative}: materialized graph`,
        ).toEqual([]);

        const rendered = docToFile(materialized);
        expect(
          isDeepStrictEqual(parseSexpr(rendered), parseSexpr(text)),
          `${relative}: complete parsed document changed ` +
            `(source=${text.length} bytes, y-update=${update.byteLength} bytes, ` +
            `items=${Object.keys(source.items).length})`,
        ).toBe(true);
      } finally {
        author.destroy();
        remote.destroy();
      }
    }, 120_000);
  }
});
