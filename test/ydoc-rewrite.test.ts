import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docToFile, fileToDoc } from "../src/kicad-doc";
import { docToY, kicadItemsMap, yToDoc } from "../src/kicad-y";
import { computeTextRewriteUpdate } from "../src/ydoc-rewrite";

const SCH = `(kicad_sch (version 20231120) (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (wire (pts (xy 0 0) (xy 10 0)) (uuid "00000000-0000-0000-0000-0000000000aa"))
  (sheet (at 10 10) (size 20 20) (uuid "00000000-0000-0000-0000-0000000000bb")
    (property "Sheetname" "Power" (at 10 9 0))
    (property "Sheetfile" "power.kicad_sch" (at 10 31 0)))
)
`;

function seeded(): Uint8Array {
  const ydoc = new Y.Doc();
  docToY(fileToDoc(SCH), ydoc);
  return Y.encodeStateAsUpdate(ydoc);
}

describe("computeTextRewriteUpdate", () => {
  it("a one-property rewrite touches only that item and keeps everything else", () => {
    const current = seeded();
    const out = computeTextRewriteUpdate(current, (t) => t.replace('"power.kicad_sch"', '"psu/power.kicad_sch"'));
    expect(out).not.toBeNull();

    // The merged blob materializes with the new value.
    const cold = new Y.Doc();
    Y.applyUpdate(cold, out!.merged);
    const text = docToFile(yToDoc(cold));
    expect(text).toContain('"Sheetfile" "psu/power.kicad_sch"');
    expect(text).toContain('"Sheetname" "Power"');

    // The incremental update applied to a LIVE copy converges to the same doc,
    // and the untouched wire item was not rewritten (same Y type instance).
    const live = new Y.Doc();
    Y.applyUpdate(live, current);
    const wireBefore = kicadItemsMap(live).get("00000000-0000-0000-0000-0000000000aa");
    Y.applyUpdate(live, out!.update);
    expect(docToFile(yToDoc(live))).toBe(text);
    expect(kicadItemsMap(live).get("00000000-0000-0000-0000-0000000000aa")).toBe(wireBefore);
    // Far smaller than re-seeding the document.
    expect(out!.update.length).toBeLessThan(current.length);
  });

  it("a rewrite that changes nothing yields null", () => {
    expect(computeTextRewriteUpdate(seeded(), (t) => t)).toBeNull();
  });
});
