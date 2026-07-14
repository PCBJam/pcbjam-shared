import { describe, expect, it } from "vitest";
import {
  colorForUser,
  PRESENCE_COLORS,
  presenceStateSchema,
  symbolUuidFromFootprintPath,
  type PresenceState,
} from "../src/presence-wire.js";
import { collabRoomId, presenceRoomId } from "../src/schemas.js";

describe("colorForUser", () => {
  it("is deterministic and stays inside the palette", () => {
    for (const slug of ["alice", "bob", "local-user", "枝豆", ""]) {
      const c = colorForUser(slug);
      expect(colorForUser(slug)).toBe(c);
      expect(PRESENCE_COLORS).toContain(c);
    }
  });

  it("spreads distinct slugs over more than one color", () => {
    const slugs = Array.from({ length: 24 }, (_, i) => `user-${i}`);
    const colors = new Set(slugs.map(colorForUser));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("symbolUuidFromFootprintPath", () => {
  it("returns the KIID_PATH's last segment", () => {
    expect(symbolUuidFromFootprintPath("/00000000-0000-0000-0000-00004549f4be")).toBe(
      "00000000-0000-0000-0000-00004549f4be",
    );
    expect(
      symbolUuidFromFootprintPath("/aaaa0000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000002"),
    ).toBe("bbbb0000-0000-0000-0000-000000000002");
  });

  it("returns null for degenerate paths", () => {
    expect(symbolUuidFromFootprintPath("")).toBeNull();
    expect(symbolUuidFromFootprintPath("/")).toBeNull();
    expect(symbolUuidFromFootprintPath("//")).toBeNull();
  });
});

describe("presenceRoomId", () => {
  it("cannot collide with any real docPath room", () => {
    expect(presenceRoomId("S1", "P1")).toBe("S1:P1:~presence");
    // Project files are relative POSIX paths — `~presence` is not a valid one.
    expect(presenceRoomId("S1", "P1")).not.toBe(collabRoomId("S1", "P1", "board.kicad_pcb"));
  });
});

describe("presenceStateSchema", () => {
  const valid: PresenceState = {
    user: { id: "alice", name: "alice", color: colorForUser("alice") },
    tool: "pcbnew",
    cursor: { x: 1_000_000, y: -2_000_000 },
    selection: ["a0b1c2d3-0000-0000-0000-000000000001"],
    updatedAt: 1750000000000,
  };

  it("round-trips a full state (with and without optional fields)", () => {
    expect(presenceStateSchema.parse(valid)).toEqual(valid);
    const withSheet = { ...valid, sheetPath: "sub/child.kicad_sch", cursor: null };
    expect(presenceStateSchema.parse(withSheet)).toEqual(withSheet);
  });

  it("round-trips selectionPaths and rejects non-string entries (0006)", () => {
    const withPaths = {
      ...valid,
      selectionPaths: ["/00000000-0000-0000-0000-00004549f4be"],
    };
    expect(presenceStateSchema.parse(withPaths)).toEqual(withPaths);
    // Absent field (older builds / eeschema) still validates — see `valid` above.
    expect(presenceStateSchema.safeParse(valid).success).toBe(true);
    expect(
      presenceStateSchema.safeParse({ ...valid, selectionPaths: [42] }).success,
    ).toBe(false);
  });

  it("accepts the optional follow-user viewport rect (0008) and rejects bad rects", () => {
    const withViewport = {
      ...valid,
      viewport: { cx: 1e8, cy: 2e8, halfW: 5e7, halfH: 4e7 },
    };
    expect(presenceStateSchema.parse(withViewport)).toEqual(withViewport);
    // Null while unknown, absent on older builds — both validate.
    expect(presenceStateSchema.safeParse({ ...valid, viewport: null }).success).toBe(true);
    expect(presenceStateSchema.safeParse(valid).success).toBe(true);
    // Degenerate half-extents (zero/negative) are rejected, not fitted.
    expect(
      presenceStateSchema.safeParse({
        ...valid,
        viewport: { cx: 0, cy: 0, halfW: 0, halfH: 10 },
      }).success,
    ).toBe(false);
  });

  it("rejects a state missing the user identity", () => {
    const { user: _user, ...rest } = valid;
    expect(presenceStateSchema.safeParse(rest).success).toBe(false);
    expect(
      presenceStateSchema.safeParse({ ...valid, user: { id: "", name: "x", color: "#fff" } })
        .success,
    ).toBe(false);
  });
});
