import { describe, expect, it } from "vitest";
import { libPathVar, libVarRef, modelItemNameFor, parseLibVarRef } from "../src/lib-paths.js";

describe("lib path variables (libs 0020)", () => {
  it("derives an upper-case KiCad variable from the nickname", () => {
    expect(libPathVar("MyParts")).toBe("MYPARTS_DIR");
    expect(libPathVar("my-parts.v2")).toBe("MY_PARTS_V2_DIR");
    expect(libPathVar("+")).toBe("LIB_DIR");
  });

  it("round-trips a variable ref", () => {
    const ref = libVarRef("MYPARTS_DIR", "3d/sot23.step");
    expect(ref).toBe("${MYPARTS_DIR}/3d/sot23.step");
    expect(parseLibVarRef(ref)).toEqual({ pathVar: "MYPARTS_DIR", rest: "3d/sot23.step" });
    expect(parseLibVarRef("$(MYPARTS_DIR)\\3d\\a.step")).toEqual({
      pathVar: "MYPARTS_DIR",
      rest: "3d/a.step",
    });
    expect(parseLibVarRef("Package_SO.3dshapes/x.step")).toBeNull();
  });

  it("maps a root-relative path to a model item name", () => {
    expect(modelItemNameFor("3d/sub/x.step", "3d")).toBe("sub/x.step");
    expect(modelItemNameFor("3d/x.step", "3d/")).toBe("x.step");
    expect(modelItemNameFor("other/x.step", "3d")).toBeNull();
    expect(modelItemNameFor("x.step", "")).toBe("x.step");
  });
});
