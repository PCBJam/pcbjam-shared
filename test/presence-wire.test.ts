import { describe, expect, it } from "vitest";
import {
  colorForUser,
  PRESENCE_COLORS,
  presenceStateSchema,
  type PresenceState,
} from "../src/presence-wire.js";

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

  it("rejects a state missing the user identity", () => {
    const { user: _user, ...rest } = valid;
    expect(presenceStateSchema.safeParse(rest).success).toBe(false);
    expect(
      presenceStateSchema.safeParse({ ...valid, user: { id: "", name: "x", color: "#fff" } })
        .success,
    ).toBe(false);
  });
});
