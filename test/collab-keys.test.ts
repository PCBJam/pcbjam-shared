import { describe, expect, it } from "vitest";
import {
  collabDocArchiveKey,
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

describe("collabDocArchiveKey (ysync 0009 archived epochs)", () => {
  it("extends the doc key with the epoch, under the doc-key prefix", () => {
    const key = collabDocArchiveKey(PID, "pcbnew/board.kicad_pcb", 1783680000000);
    expect(key).toBe(`${collabDocKey(PID, "pcbnew/board.kicad_pcb")}.1783680000000`);
    expect(key.startsWith(`${collabDocKey(PID, "pcbnew/board.kicad_pcb")}.`)).toBe(true);
  });

  it("archives never parse as live collab docs (invisible to listings)", () => {
    const key = collabDocArchiveKey(PID, "board.kicad_pcb", 42);
    expect(parseCollabKey(PID, key)).toBeNull();
  });
});
