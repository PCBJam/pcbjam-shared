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
  workingCopyKeyPrefix,
} from "../src/schemas.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PID = "11111111-2222-3333-4444-555555555555";
const CID = "99999999-8888-7777-6666-555555555555";

describe("parseCollabKey (inverse of collabDocKey/collabLiveKey)", () => {
  it("round-trips clean POSIX doc paths for both kinds", () => {
    for (const path of ["board.kicad_pcb", "sub/child.kicad_sch", "a/b/c.kicad_wks"]) {
      expect(parseCollabKey(SID, PID, collabDocKey(SID, PID, path))).toEqual({ path, kind: "ydoc", copyId: null });
      expect(parseCollabKey(SID, PID, collabLiveKey(SID, PID, path))).toEqual({ path, kind: "live", copyId: null });
    }
  });

  it("nests a non-default working copy under copies/<id>/ and recovers it (git-integration 0004)", () => {
    const key = collabDocKey(SID, PID, "sub/child.kicad_sch", CID);
    expect(key).toBe(`teams/${SID}/projects/${PID}/copies/${CID}/sub/child.kicad_sch.ydoc`);
    expect(parseCollabKey(SID, PID, key)).toEqual({ path: "sub/child.kicad_sch", kind: "ydoc", copyId: CID });
    expect(parseCollabKey(SID, PID, collabLiveKey(SID, PID, "b.kicad_pcb", CID))).toEqual({
      path: "b.kicad_pcb",
      kind: "live",
      copyId: CID,
    });
    expect(collabDocGoodKey(SID, PID, "b.kicad_pcb", CID)).toBe(`${collabDocKey(SID, PID, "b.kicad_pcb", CID)}.good`);
    expect(collabDocArchiveKey(SID, PID, "b.kicad_pcb", 7, CID)).toBe(`${collabDocKey(SID, PID, "b.kicad_pcb", CID)}.7`);
    expect(workingCopyKeyPrefix(SID, PID, CID)).toBe(`teams/${SID}/projects/${PID}/copies/${CID}/`);
    // the default copy is the flat legacy layout: null / undefined / "" all mean default
    expect(collabDocKey(SID, PID, "b.kicad_pcb", null)).toBe(collabDocKey(SID, PID, "b.kicad_pcb"));
    // a default-copy file that merely lives in a folder named `copies` is not a copy
    expect(parseCollabKey(SID, PID, collabDocKey(SID, PID, "copies/notes.kicad_sch"))).toEqual({
      path: "copies/notes.kicad_sch",
      kind: "ydoc",
      copyId: null,
    });
    // per-copy blobs never had a legacy (fold-scheme) key
    expect(legacyCollabKeys(SID, PID, "my board.kicad_pcb", CID)).toBeNull();
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
      expect(parseCollabKey(SID, PID, collabDocKey(SID, PID, path))).toEqual({ path, kind: "ydoc", copyId: null });
      expect(parseCollabKey(SID, PID, collabLiveKey(SID, PID, path))).toEqual({ path, kind: "live", copyId: null });
    }
  });

  it("nests a non-default working copy under copies/<id>/ and recovers it (git-integration 0004)", () => {
    const key = collabDocKey(SID, PID, "sub/child.kicad_sch", CID);
    expect(key).toBe(`teams/${SID}/projects/${PID}/copies/${CID}/sub/child.kicad_sch.ydoc`);
    expect(parseCollabKey(SID, PID, key)).toEqual({ path: "sub/child.kicad_sch", kind: "ydoc", copyId: CID });
    expect(parseCollabKey(SID, PID, collabLiveKey(SID, PID, "b.kicad_pcb", CID))).toEqual({
      path: "b.kicad_pcb",
      kind: "live",
      copyId: CID,
    });
    expect(collabDocGoodKey(SID, PID, "b.kicad_pcb", CID)).toBe(`${collabDocKey(SID, PID, "b.kicad_pcb", CID)}.good`);
    expect(collabDocArchiveKey(SID, PID, "b.kicad_pcb", 7, CID)).toBe(`${collabDocKey(SID, PID, "b.kicad_pcb", CID)}.7`);
    expect(workingCopyKeyPrefix(SID, PID, CID)).toBe(`teams/${SID}/projects/${PID}/copies/${CID}/`);
    // the default copy is the flat legacy layout: null / undefined / "" all mean default
    expect(collabDocKey(SID, PID, "b.kicad_pcb", null)).toBe(collabDocKey(SID, PID, "b.kicad_pcb"));
    // a default-copy file that merely lives in a folder named `copies` is not a copy
    expect(parseCollabKey(SID, PID, collabDocKey(SID, PID, "copies/notes.kicad_sch"))).toEqual({
      path: "copies/notes.kicad_sch",
      kind: "ydoc",
      copyId: null,
    });
    // per-copy blobs never had a legacy (fold-scheme) key
    expect(legacyCollabKeys(SID, PID, "my board.kicad_pcb", CID)).toBeNull();
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
        copyId: null,
      });
    }
    expect(parseCollabRoomId(presenceRoomId(SID, PID))).toEqual({
      scopeId: SID,
      projectId: PID,
      docPath: "~presence",
      copyId: null,
    });
  });

  it("carries a non-default working copy as the third segment (git-integration 0004)", () => {
    for (const docPath of ["board.kicad_pcb", "sub/child.kicad_sch", "weird:name.kicad_pcb", "~presence"]) {
      const room = collabRoomId(SID, PID, docPath, CID);
      expect(room).toBe(`${SID}:${PID}:${CID}:${docPath}`);
      expect(parseCollabRoomId(room)).toEqual({ scopeId: SID, projectId: PID, docPath, copyId: CID });
    }
    expect(presenceRoomId(SID, PID, CID)).toBe(collabRoomId(SID, PID, "~presence", CID));
    // default copy: no segment, whatever falsy spelling the caller uses
    expect(collabRoomId(SID, PID, "x.kicad_sch", null)).toBe(`${SID}:${PID}:x.kicad_sch`);
    expect(collabRoomId(SID, PID, "x.kicad_sch", "")).toBe(`${SID}:${PID}:x.kicad_sch`);
    // a copy segment with nothing after it is not a room
    expect(parseCollabRoomId(`${SID}:${PID}:${CID}:`)).toBeNull();
    // a doc path that merely starts with something uuid-ish but is not one stays a doc path
    expect(parseCollabRoomId(`${SID}:${PID}:not-a-uuid:x.kicad_sch`)?.docPath).toBe("not-a-uuid:x.kicad_sch");
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
