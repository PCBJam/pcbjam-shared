import { describe, expect, it } from "vitest";
import {
  collabDocArchiveKey,
  collabDocGoodKey,
  collabDocKey,
  collabLiveKey,
  collabRoomId,
  legacyCollabKeys,
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

describe("doc paths with spaces/special chars (filename-spaces fix)", () => {
  it("round-trips paths the old fold destroyed", () => {
    for (const path of [
      "my board.kicad_pcb",
      "100% done.kicad_sch",
      "rev#2.kicad_sch",
      "a (copy).kicad_pcb",
      "sch/übersicht.kicad_sch",
      "sub dir/my board.kicad_pcb",
    ]) {
      expect(parseCollabKey(SID, PID, collabDocKey(SID, PID, path))).toEqual({ path, kind: "ydoc" });
      expect(parseCollabKey(SID, PID, collabLiveKey(SID, PID, path))).toEqual({ path, kind: "live" });
    }
  });

  it("is injective — the old-scheme collisions can no longer happen", () => {
    expect(collabDocKey(SID, PID, "my board.kicad_pcb")).not.toBe(
      collabDocKey(SID, PID, "my_board.kicad_pcb"),
    );
    // A literal `%20` in a name must not collide with a real space either.
    expect(collabDocKey(SID, PID, "a%20b.kicad_sch")).not.toBe(
      collabDocKey(SID, PID, "a b.kicad_sch"),
    );
  });

  it("keeps clean paths byte-identical to the pre-fix scheme (no migration)", () => {
    expect(collabDocKey(SID, PID, "pcbnew/board.kicad_pcb")).toBe(
      `teams/${SID}/projects/${PID}/pcbnew/board.kicad_pcb.ydoc`,
    );
    expect(legacyCollabKeys(SID, PID, "pcbnew/board.kicad_pcb")).toBeNull();
  });

  it("never lets a dot segment reach a key verbatim (filesystem-backed dev storage)", () => {
    expect(collabDocKey(SID, PID, "../escape.kicad_pcb")).not.toContain("../");
    expect(collabDocKey(SID, PID, "a/./b.kicad_pcb")).not.toContain("/./");
  });
});

describe("legacyCollabKeys (lazy-migration source keys)", () => {
  const prefix = `teams/${SID}/projects/${PID}/`;

  it("reproduces the key the pre-fix sync DO wrote for a spaced filename", () => {
    // Pre-fix, the browser wire-encoded the room (space → %20) and the worker
    // never decoded it, so the old fold saw `my%20board…` → `my_20board…`.
    expect(legacyCollabKeys(SID, PID, "my board.kicad_sch")).toEqual({
      doc: `${prefix}my_20board.kicad_sch.ydoc`,
      good: `${prefix}my_20board.kicad_sch.ydoc.good`,
      live: `${prefix}my_20board.kicad_sch.live`,
    });
  });

  it("folds chars the browser left raw in the wire path (parens, +)", () => {
    expect(legacyCollabKeys(SID, PID, "a (copy).kicad_pcb")?.doc).toBe(
      `${prefix}a_20_copy_.kicad_pcb.ydoc`,
    );
    expect(legacyCollabKeys(SID, PID, "a+b.kicad_sch")?.doc).toBe(
      `${prefix}a_b.kicad_sch.ydoc`,
    );
  });

  it("folds non-ASCII via its UTF-8 wire bytes", () => {
    expect(legacyCollabKeys(SID, PID, "ä.kicad_sch")?.doc).toBe(
      `${prefix}_C3_A4.kicad_sch.ydoc`,
    );
  });

  it("agrees with the canonical .good key shape for migrated checkpoints", () => {
    expect(collabDocGoodKey(SID, PID, "my board.kicad_sch")).toBe(
      `${collabDocKey(SID, PID, "my board.kicad_sch")}.good`,
    );
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
