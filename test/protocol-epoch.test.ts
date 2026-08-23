import { describe, expect, it } from "vitest";
import {
  collabRoomId,
  KDOC_COLLAB_PROTOCOL_VERSION,
  parseCollabRoomId,
} from "../src/schemas.js";
import { SEXPR_VERSION_CURRENT } from "../src/kicad-y2.js";

describe("collaboration writer epoch", () => {
  it("excludes v3 deleting writers without changing the stable v3 Y encoding", () => {
    expect(KDOC_COLLAB_PROTOCOL_VERSION).toBe(4);
    expect(SEXPR_VERSION_CURRENT).toBe(3);

    const room = collabRoomId("scope", "project", "main.kicad_sch");
    expect(room).toContain("~kdoc-v4~:");
    expect(parseCollabRoomId(room)?.schemaVersion).toBe(4);

    // Existing v3 room names remain parseable so the server can reject them
    // explicitly as incompatible instead of accidentally treating them as
    // unversioned paths.
    expect(
      parseCollabRoomId("scope:project:~kdoc-v3~:main.kicad_sch")?.schemaVersion,
    ).toBe(3);
  });
});
