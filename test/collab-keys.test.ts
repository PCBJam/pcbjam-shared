import { describe, expect, it } from "vitest";
import {
  collabDocArchiveKey,
  collabDocKey,
  collabLiveKey,
  collabRoomId,
  parseCollabKey,
  parseCollabRoomId,
  presenceRoomId,
} from "../src/schemas.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PID = "11111111-2222-3333-4444-555555555555";

describe("parseCollabKey (inverse of collabDocKey/collabLiveKey)", () => {
  it("round-trips clean POSIX doc paths for both kinds", () => {
    for (const path of ["board.kicad_pcb", "sub/child.kicad_sch", "a/b/c.kicad_wks"]) {
      expect(parseCollabKey(SID, PID, collabDocKey(SID, PID, path))).toEqual({ path, kind: "ydoc" });
      expect(parseCollabKey(SID, PID, collabLiveKey(SID, PID, path))).toEqual({ path, kind: "live" });
    }
  });

  it("returns null for keys outside this project's prefix", () => {
    expect(parseCollabKey(SID, PID, collabDocKey(SID, "other-project", "x.kicad_sch"))).toBeNull();
    expect(parseCollabKey(SID, PID, `libs/foo/bar.kicad_sym.ydoc`)).toBeNull();
  });

  it("returns null for the same project under a different team", () => {
    expect(parseCollabKey(SID, PID, collabDocKey("other-team", PID, "x.kicad_sch"))).toBeNull();
  });

  it("returns null for a raw file (no .ydoc/.live suffix) and for the bare prefix", () => {
    expect(parseCollabKey(SID, PID, `teams/${SID}/projects/${PID}/board.kicad_pcb`)).toBeNull();
    expect(parseCollabKey(SID, PID, `teams/${SID}/projects/${PID}/.ydoc`)).toBeNull();
  });
});

describe("collabDocArchiveKey (ysync 0009 archived epochs)", () => {
  it("extends the doc key with the epoch, under the doc-key prefix", () => {
    const key = collabDocArchiveKey(SID, PID, "pcbnew/board.kicad_pcb", 1783680000000);
    expect(key).toBe(`${collabDocKey(SID, PID, "pcbnew/board.kicad_pcb")}.1783680000000`);
    expect(key.startsWith(`${collabDocKey(SID, PID, "pcbnew/board.kicad_pcb")}.`)).toBe(true);
  });

  it("archives never parse as live collab docs (invisible to listings)", () => {
    const key = collabDocArchiveKey(SID, PID, "board.kicad_pcb", 42);
    expect(parseCollabKey(SID, PID, key)).toBeNull();
  });
});

describe("parseCollabRoomId (inverse of collabRoomId/presenceRoomId)", () => {
  it("round-trips doc and presence rooms, keeping colons in docPath intact", () => {
    for (const docPath of ["board.kicad_pcb", "sub/child.kicad_sch", "weird:name.kicad_pcb"]) {
      expect(parseCollabRoomId(collabRoomId(SID, PID, docPath))).toEqual({
        scopeId: SID,
        projectId: PID,
        docPath,
      });
    }
    expect(parseCollabRoomId(presenceRoomId(SID, PID))).toEqual({
      scopeId: SID,
      projectId: PID,
      docPath: "~presence",
    });
  });

  it("rejects legacy 2-part and malformed room ids", () => {
    expect(parseCollabRoomId(`${PID}:board.kicad_pcb`)).toBeNull();
    expect(parseCollabRoomId(PID)).toBeNull();
    expect(parseCollabRoomId("")).toBeNull();
    expect(parseCollabRoomId(`:${PID}:x`)).toBeNull();
    expect(parseCollabRoomId(`${SID}::x`)).toBeNull();
    expect(parseCollabRoomId(`${SID}:${PID}:`)).toBeNull();
  });
});
