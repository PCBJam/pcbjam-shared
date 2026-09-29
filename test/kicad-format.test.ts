import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docToFile, fileToDoc } from "../src/kicad-doc.js";
import {
  ATOM_WRAP_COLUMN,
  detectKicadFormatMode,
  formatKicadText,
  XY_PACK_COLUMN,
} from "../src/kicad-format.js";
import { parseSexpr } from "../src/sexpr.js";
import { FIXTURES, listFixtures } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The pcbjam repo this package is checked out in (absent when standalone). */
const PCBJAM = path.resolve(here, "..", "..", "..");
const KICAD_QA = path.join(PCBJAM, "kicad", "qa", "data");
const DEMO = path.join(PCBJAM, "tests", "fixtures", "demo");

const KICAD_FILE = /\.(kicad_pcb|kicad_sch|kicad_sym|kicad_mod)$/;
const KICAD_GENERATORS = /^\t\(generator "?(pcbnew|eeschema|kicad_symbol_editor)"?\)$/m;

function walk(dir: string, re: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, re));
    else if (re.test(e.name)) out.push(full);
  }
  return out.sort();
}

/**
 * A file KiCad itself saved in the current (tab-indented) layout: header on its
 * own line, a KiCad generator. Skips pre-8 saves (space-indented, header inline)
 * and files written by other tools (footprint generators, hand-written tests).
 */
function isKicadSaved(text: string): boolean {
  return /^\([a-z_]+\n\t\(version \d+\)\n/.test(text) && KICAD_GENERATORS.test(text);
}

/**
 * Upstream qa files that are KiCad-generated but were then touched by hand or by
 * a non-default writer, so their bytes are NOT what a KiCad save produces.
 */
const QA_NOT_KICAD_BYTES: Record<string, string> = {
  "pcbnew/plugins/kicad_sexpr/ScientificNotation.kicad_pcb": "hand-edited: space+tab indentation",
  "pcbnew/teardrop_offcenter_two_segment.kicad_pcb": "trailing `</content>` garbage after the form",
  "pcbnew/issue23332_min_width/issue23332_min_width.kicad_pcb": "(tenting (front yes) (back yes)) inline — non-default writer",
  "pcbnew/issue23418_diffnet/testing.kicad_pcb": "(tenting (front yes) (back yes)) inline — non-default writer",
  "pcbnew/issue22983/issue22983.kicad_pcb": "125-column (members …) never wrapped — non-default writer",
  "eeschema/issue23058/issue23058.kicad_sch": "(jumper_pin_groups (\"1\" \"3\")) inline — hand-edited",
};

/** KiCad saves end in "\n"; a few checked-in files had it trimmed by an editor. */
const withFinalNewline = (t: string) => (t.endsWith("\n") ? t : t + "\n");

/** First differing line, for a readable failure. */
function firstDiff(want: string, got: string): string {
  const a = want.split("\n");
  const b = got.split("\n");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `line ${i + 1}\n  want ${JSON.stringify(a[i])}\n  got  ${JSON.stringify(b[i])}`;
}

function expectRoundTrip(file: string): void {
  const text = withFinalNewline(fs.readFileSync(file, "utf8"));
  const doc = fileToDoc(text);
  const mode = detectKicadFormatMode(text);
  const pretty = docToFile(doc, { format: "kicad", mode });
  if (pretty !== text) expect.fail(`${file}: ${firstDiff(text, pretty)}`);
  // The same through our own one-line form: flatten, parse that again, pretty-print.
  const compact = docToFile(doc);
  if (compact.includes("\n")) expect.fail(`${file}: the compact form is not one line`);
  const again = docToFile(fileToDoc(compact), { format: "kicad", mode });
  if (again !== text) expect.fail(`${file} (via compact): ${firstDiff(text, again)}`);
}

// ── Layout rules on small inputs ─────────────────────────────────────────────

describe("formatKicadText — layout rules", () => {
  it("tabs per level, leaf lists inline, parents close on their own line, final newline", () => {
    expect(formatKicadText(`(kicad_pcb (version 20241229) (general (thickness 1.6)) (net 0 ""))`)).toBe(
      "(kicad_pcb\n\t(version 20241229)\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(net 0 \"\")\n)\n",
    );
  });

  it("atoms stay on the head line; an atom after an inner list closes inline", () => {
    expect(formatKicadText(`(sym (pin_names (offset 0) hide) (property "Value" "R" (at 0 0 0)))`)).toBe(
      '(sym\n\t(pin_names\n\t\t(offset 0) hide)\n\t(property "Value" "R"\n\t\t(at 0 0 0)\n\t)\n)\n',
    );
  });

  it("an empty list renders bare", () => {
    expect(formatKicadText(`(kicad_sch (lib_symbols))`)).toBe("(kicad_sch\n\t(lib_symbols)\n)\n");
  });

  it(`packs (xy …) runs until column ${XY_PACK_COLUMN}`, () => {
    const pts = Array.from({ length: 6 }, (_, i) => `(xy 100.${i}00001 200.${i}00002)`).join(" ");
    const out = formatKicadText(`(kicad_pcb (zone (polygon (pts ${pts}))))`);
    const lines = out.split("\n").filter((l) => l.includes("(xy"));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("\t\t\t\t(xy ")).toBe(true);
    // the first line took xy's while it was still shorter than the pack column
    const before = lines[0]!.slice(0, lines[0]!.lastIndexOf(" (xy"));
    expect(before.length).toBeLessThan(XY_PACK_COLUMN);
    expect(lines[0]!.length).toBeGreaterThanOrEqual(XY_PACK_COLUMN);
  });

  it(`wraps atom runs at column ${ATOM_WRAP_COLUMN} and closes them on their own line`, () => {
    const ids = Array.from({ length: 5 }, (_, i) => `"0000000${i}-0000-4000-8000-000000000000"`);
    const out = formatKicadText(`(kicad_pcb (group "" (uuid "g") (members ${ids.join(" ")})))`);
    expect(out).toBe(
      "(kicad_pcb\n\t(group \"\"\n\t\t(uuid \"g\")\n" +
        `\t\t(members ${ids[0]} ${ids[1]}\n` +
        `\t\t\t${ids[2]} ${ids[3]}\n` +
        `\t\t\t${ids[4]}\n` +
        "\t\t)\n\t)\n)\n",
    );
  });

  it("a short atom run stays on one line", () => {
    expect(formatKicadText(`(kicad_pcb (group "" (members "a" "b")))`)).toBe(
      '(kicad_pcb\n\t(group ""\n\t\t(members "a" "b")\n\t)\n)\n',
    );
  });

  it("compact_text_properties keeps text/stroke/model-transform lists on one line", () => {
    const src = `(kicad_pcb (fp_line (stroke (width 0.1) (type solid)) (layer "F.SilkS")) (property "R" "1" (effects (font (size 1 1) (thickness 0.15)))) (model "m.step" (offset (xyz 0 0 0))))`;
    expect(formatKicadText(src, "compact_text_properties")).toBe(
      "(kicad_pcb\n" +
        "\t(fp_line\n\t\t(stroke (width 0.1) (type solid))\n\t\t(layer \"F.SilkS\")\n\t)\n" +
        "\t(property \"R\" \"1\"\n\t\t(effects\n\t\t\t(font (size 1 1) (thickness 0.15))\n\t\t)\n\t)\n" +
        "\t(model \"m.step\"\n\t\t(offset (xyz 0 0 0))\n\t)\n" +
        ")\n",
    );
    expect(detectKicadFormatMode(formatKicadText(src, "compact_text_properties"))).toBe(
      "compact_text_properties",
    );
    expect(detectKicadFormatMode(formatKicadText(src))).toBe("normal");
  });

  it("library tables put each (lib …) row on one line", () => {
    const src = `(sym_lib_table (version 7) (lib (name "Device") (type "KiCad") (uri "\${KIPRJMOD}/Device.kicad_sym") (options "") (descr "")))`;
    expect(detectKicadFormatMode(src)).toBe("library_table");
    expect(formatKicadText(src)).toBe(
      '(sym_lib_table\n\t(version 7)\n\t(lib (name "Device") (type "KiCad") (uri "${KIPRJMOD}/Device.kicad_sym") (options "") (descr ""))\n)\n',
    );
  });

  it("docToFile defaults to the compact one-line form (unchanged for existing callers)", () => {
    const text = `(kicad_pcb (version 1) (footprint "R" (uuid "u1") (pad "1" smd (uuid "p1"))))`;
    expect(docToFile(fileToDoc(text))).toBe(text);
    expect(docToFile(fileToDoc(text), { format: "compact" })).toBe(text);
  });

  it("pretty docToFile honours onMissingItem like the compact renderer", () => {
    const doc = fileToDoc(`(kicad_pcb (version 1) (footprint "R" (uuid "u1") (pad "1" (uuid "p1"))))`);
    delete doc.items["p1"];
    const missing: string[] = [];
    expect(docToFile(doc, { format: "kicad", onMissingItem: (u) => missing.push(u) })).toBe(
      '(kicad_pcb\n\t(version 1)\n\t(footprint "R"\n\t\t(uuid "u1")\n\t)\n)\n',
    );
    expect(missing).toEqual(["p1"]);
    expect(() => docToFile(doc, { format: "kicad" })).toThrow(/missing item p1/);
  });
});

// ── Real KiCad saves: byte-identical round trip ──────────────────────────────

/**
 * In-package + in-repo fixtures that KiCad itself saved in the current layout.
 * `demo/hier/` is excluded: those sheets are hand-written test inputs (inline
 * `(pts …)` / `(stroke …)`) that merely carry an eeschema header.
 */
const LOCAL = [...listFixtures(FIXTURES), ...walk(DEMO, KICAD_FILE)].filter(
  (f) => !f.includes(`${path.sep}hier${path.sep}`) && isKicadSaved(fs.readFileSync(f, "utf8")),
);

describe("round trip: fileToDoc → docToFile({ format: 'kicad' }) === KiCad's bytes", () => {
  it("has local KiCad-saved fixtures to check", () => {
    expect(LOCAL.length).toBeGreaterThan(0);
  });
  for (const f of LOCAL) {
    it(path.relative(PCBJAM, f), () => expectRoundTrip(f));
  }
});

describe("idempotence + semantic equality", () => {
  for (const f of LOCAL) {
    it(path.relative(PCBJAM, f), () => {
      const text = fs.readFileSync(f, "utf8");
      const compact = docToFile(fileToDoc(text));
      const once = formatKicadText(compact);
      expect(formatKicadText(once)).toBe(once);
      expect(parseSexpr(once)).toEqual(parseSexpr(compact));
      // and the pretty text converts back to the same doc
      expect(fileToDoc(once)).toEqual(fileToDoc(compact));
    });
  }
});

// ── Upstream KiCad data, read in place (skipped without the kicad submodule) ─

const QA = walk(KICAD_QA, KICAD_FILE).filter((f) => isKicadSaved(fs.readFileSync(f, "utf8")));

describe.skipIf(QA.length === 0)("round trip: KiCad qa data (read in place)", () => {
  it("every KiCad-saved qa file renders byte-identical, except the listed hand-edited ones", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const f of QA) {
      const rel = path.relative(KICAD_QA, f);
      if (rel in QA_NOT_KICAD_BYTES) continue;
      checked++;
      try {
        expectRoundTrip(f);
      } catch (e) {
        failures.push(e instanceof Error ? e.message.split("\n").slice(0, 3).join("\n") : String(e));
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(200);
  }, 120_000);

  it("the listed outliers really are not KiCad-layout bytes", () => {
    for (const rel of Object.keys(QA_NOT_KICAD_BYTES)) {
      const f = path.join(KICAD_QA, rel);
      if (!fs.existsSync(f)) continue;
      expect(() => expectRoundTrip(f)).toThrow();
    }
  });
});

/** KiCad's own prettifier golden pairs (input → *_formatted), read in place. */
const PRETTIFIER = path.join(KICAD_QA, "pcbnew", "prettifier");
const GOLDEN = walk(PRETTIFIER, /_formatted\.kicad_(pcb|mod)$/);

describe.skipIf(GOLDEN.length === 0)("KiCad prettifier golden pairs (read in place)", () => {
  for (const out of GOLDEN) {
    it(path.basename(out), () => {
      const input = fs.readFileSync(out.replace("_formatted", ""), "utf8");
      const want = fs.readFileSync(out, "utf8");
      const got = formatKicadText(input, "normal");
      if (got !== want) expect.fail(firstDiff(want, got));
    });
  }
});

/** Library tables KiCad saved in the current (tab-indented) layout, read in place. */
const LIB_TABLES = walk(KICAD_QA, /^(fp|sym|design-block)-lib-table$/).filter((f) =>
  /^\([a-z_]+\n\t/.test(fs.readFileSync(f, "utf8")),
);

describe.skipIf(LIB_TABLES.length === 0)("library tables (read in place)", () => {
  for (const f of LIB_TABLES) {
    it(path.relative(KICAD_QA, f), () => {
      const text = withFinalNewline(fs.readFileSync(f, "utf8"));
      expect(detectKicadFormatMode(text)).toBe("library_table");
      const got = formatKicadText(text);
      if (got !== text) expect.fail(firstDiff(text, got));
    });
  }
});
