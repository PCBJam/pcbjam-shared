import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  parseJsonLossless,
  sidecarCodecFor,
  sidecarKind,
  sidecarUpdateToFile,
  stringifyKicadJson,
} from "../src/sidecar-doc.js";

const QA = path.resolve(__dirname, "../../../kicad/qa/data");
const qaProjects = (): string[] =>
  ["pcbnew", "eeschema"].flatMap((d) => {
    const dir = path.join(QA, d);
    return existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".kicad_pro")).map((f) => path.join(dir, f))
      : [];
  });

const pro = sidecarCodecFor("p/p.kicad_pro")!;
const dru = sidecarCodecFor("p/p.kicad_dru")!;

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u));
  return { a, b };
}

describe("sidecar kinds", () => {
  it("routes .kicad_pro to json and .kicad_dru to text", () => {
    expect(sidecarKind("a/b.kicad_pro")).toBe("json");
    expect(sidecarKind("a/b.kicad_dru")).toBe("text");
    expect(sidecarKind("a/b.kicad_pcb")).toBeNull();
  });
});

describe("lossless JSON (KiCad's nlohmann dump(2) form)", () => {
  it("keeps number lexemes", () => {
    const text = '{\n  "a": 1.0,\n  "b": 1e-06,\n  "c": [\n    0.1,\n    2\n  ],\n  "d": {}\n}\n';
    expect(stringifyKicadJson(parseJsonLossless(text))).toBe(text);
  });

  it("every KiCad QA .kicad_pro round-trips byte-equal through a room", () => {
    const files = qaProjects();
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const doc = new Y.Doc();
      pro.seed(doc, text);
      const back = sidecarUpdateToFile("x.kicad_pro", Y.encodeStateAsUpdate(doc));
      if (back !== text) bad.push(path.basename(f));
    }
    expect(bad).toEqual([]);
  });
});

describe("json room merge (per key, netclasses per name)", () => {
  const base = {
    net_settings: {
      classes: [
        { name: "Default", clearance: { "#n": "0.2" } },
        { name: "Power", clearance: { "#n": "0.3" } },
      ],
    },
    erc: { rule_severities: { pin_not_connected: "error" } },
  };
  const text = (v: unknown) => stringifyKicadJson(v as never);

  it("a netclass edit and an ERC severity edit from two stale writers both survive", () => {
    const { a, b } = pair();
    pro.seed(a, text(base));
    const aFile = text({ ...base, net_settings: { classes: [base.net_settings.classes[0], { name: "Power", clearance: { "#n": "0.5" } }] } });
    const bFile = text({ ...base, erc: { rule_severities: { pin_not_connected: "warning" } } });
    pro.patch(a, aFile, text(base));
    pro.patch(b, bFile, text(base));
    const merged = pro.render(a)!;
    expect(merged).toContain('"clearance": 0.5');
    expect(merged).toContain('"pin_not_connected": "warning"');
    expect(pro.render(b)).toBe(merged);
  });

  it("two peers adding DIFFERENT netclasses keep both", () => {
    const { a, b } = pair();
    pro.seed(a, text(base));
    const add = (name: string) =>
      text({ ...base, net_settings: { classes: [...base.net_settings.classes, { name, clearance: { "#n": "0.1" } }] } });
    pro.patch(a, add("HS"), text(base));
    pro.patch(b, add("RF"), text(base));
    const merged = pro.render(a)!;
    expect(merged).toContain('"name": "HS"');
    expect(merged).toContain('"name": "RF"');
  });

  it("an unchanged save writes nothing", () => {
    const doc = new Y.Doc();
    pro.seed(doc, text(base));
    let updates = 0;
    doc.on("update", () => updates++);
    expect(pro.patch(doc, text(base), text(base))).toBe(false);
    expect(updates).toBe(0);
  });

  it("an unparseable file never half-writes", () => {
    const doc = new Y.Doc();
    pro.seed(doc, text(base));
    expect(() => pro.patch(doc, "{ nope", text(base))).toThrow();
    expect(pro.render(doc)).toBe(text(base));
  });
});

describe("text room merge (custom rules)", () => {
  const BASE = `(version 1)\n(rule "a"\n  (constraint clearance (min 0.2mm)))\n(rule "b"\n  (constraint clearance (min 0.3mm)))\n`;

  it("edits of different rules from two stale writers both survive", () => {
    const { a, b } = pair();
    dru.seed(a, BASE);
    dru.patch(a, BASE.replace("0.2mm", "0.25mm"), BASE);
    dru.patch(b, BASE.replace("0.3mm", "0.35mm"), BASE);
    const merged = dru.render(a)!;
    expect(merged).toContain("0.25mm");
    expect(merged).toContain("0.35mm");
    expect(dru.render(b)).toBe(merged);
  });

  it("without a baseline the file replaces the text", () => {
    const doc = new Y.Doc();
    dru.seed(doc, BASE);
    dru.patch(doc, "(version 1)\n", undefined);
    expect(dru.render(doc)).toBe("(version 1)\n");
  });
});
