import { describe, expect, it } from "vitest";
import {
  collabDocKey,
  collabLiveKey,
  parseCollabKey,
} from "../src/schemas.js";

const PID = "11111111-2222-3333-4444-555555555555";

describe("parseCollabKey (inverse of collabDocKey/collabLiveKey)", () => {
  it("round-trips clean POSIX doc paths for both kinds", () => {
    for (const path of ["board.kicad_pcb", "sub/child.kicad_sch", "a/b/c.kicad_wks"]) {
      expect(parseCollabKey(PID, collabDocKey(PID, path))).toEqual({ path, kind: "ydoc" });
      expect(parseCollabKey(PID, collabLiveKey(PID, path))).toEqual({ path, kind: "live" });
    }
  });

  it("returns null for keys outside this project's prefix", () => {
    expect(parseCollabKey(PID, collabDocKey("other-project", "x.kicad_sch"))).toBeNull();
    expect(parseCollabKey(PID, `libs/foo/bar.kicad_sym.ydoc`)).toBeNull();
  });

  it("returns null for a raw file (no .ydoc/.live suffix) and for the bare prefix", () => {
    expect(parseCollabKey(PID, `projects/${PID}/board.kicad_pcb`)).toBeNull();
    expect(parseCollabKey(PID, `projects/${PID}/.ydoc`)).toBeNull();
  });
});
