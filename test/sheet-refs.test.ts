import { describe, expect, it } from "vitest";
import { resolveSheetRef, sheetRefsOf } from "../src/sheet-refs";

describe("Sheetfile references", () => {
  it("resolves against the referencing sheet's directory", () => {
    expect(resolveSheetRef("root.kicad_sch", "power.kicad_sch")).toBe("power.kicad_sch");
    expect(resolveSheetRef("hw/root.kicad_sch", "sub/power.kicad_sch")).toBe("hw/sub/power.kicad_sch");
    expect(resolveSheetRef("hw/a/root.kicad_sch", "../shared/x.kicad_sch")).toBe("hw/shared/x.kicad_sch");
    expect(resolveSheetRef("hw/root.kicad_sch", "./power.kicad_sch")).toBe("hw/power.kicad_sch");
  });

  it("${KIPRJMOD}/ is the project root, backslashes are separators", () => {
    expect(resolveSheetRef("hw/root.kicad_sch", "${KIPRJMOD}/lib/x.kicad_sch")).toBe("lib/x.kicad_sch");
    expect(resolveSheetRef("hw/root.kicad_sch", "sub\\\\power.kicad_sch")).toBe("hw/sub/power.kicad_sch");
  });

  it("lists every reference of a schematic, escaped quotes included", () => {
    const text = `(kicad_sch
      (sheet (property "Sheetname" "P") (property "Sheetfile" "power.kicad_sch"))
      (sheet (property "Sheetfile" "sub/my \\"odd\\".kicad_sch")))`;
    expect(sheetRefsOf("hw/root.kicad_sch", text)).toEqual([
      { raw: "power.kicad_sch", path: "hw/power.kicad_sch" },
      { raw: 'sub/my \\"odd\\".kicad_sch', path: 'hw/sub/my "odd".kicad_sch' },
    ]);
  });
});
