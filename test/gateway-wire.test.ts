import { describe, expect, it } from "vitest";
import {
  parseGatewayClientMsg,
  parseGatewayServerMsg,
  parseProjectRoomName,
  projectRoomName,
  readGatewayVarint,
  tagGatewayFrame,
  untagGatewayFrame,
  GENERATION_CLOSE_CODE,
  GENERATION_REFUSED,
  isGenerationRefusal,
} from "../src/gateway-wire.js";

describe("gateway binary framing", () => {
  it("round-trips (channel, frame) through tag/untag", () => {
    const frame = new Uint8Array([0, 1, 2, 250, 255]);
    for (const ch of [0, 1, 127, 128, 300, 1_000_000]) {
      const tagged = tagGatewayFrame(ch, frame);
      const back = untagGatewayFrame(tagged);
      expect(back?.ch).toBe(ch);
      expect([...(back?.frame ?? [])]).toEqual([...frame]);
    }
  });

  it("tags an empty frame (control-less keepalive) losslessly", () => {
    const back = untagGatewayFrame(tagGatewayFrame(5, new Uint8Array(0)));
    expect(back?.ch).toBe(5);
    expect(back?.frame.length).toBe(0);
  });

  it("rejects an empty buffer and a truncated varint", () => {
    expect(untagGatewayFrame(new Uint8Array(0))).toBeNull();
    expect(untagGatewayFrame(new Uint8Array([0x80]))).toBeNull();
  });

  it("decodes non-minimal varints with lib0 semantics", () => {
    // 0x81 0x00 is a non-minimal encoding of 1 — must match channel 1, the
    // same permissiveness the sync worker's guards use.
    const data = new Uint8Array([0x81, 0x00, 42]);
    const back = untagGatewayFrame(data);
    expect(back?.ch).toBe(1);
    expect([...(back?.frame ?? [])]).toEqual([42]);
    expect(readGatewayVarint(data, 0)).toEqual({ value: 1, next: 2 });
  });
});

describe("gateway control messages", () => {
  it("round-trips every client message shape", () => {
    const msgs = [
      { t: "sub", ch: 0, doc: "boards/a.kicad_sch", mode: "passive" },
      { t: "sub", ch: 3, doc: "~presence", mode: "active" },
      { t: "act", ch: 3 },
      { t: "unsub", ch: 0 },
    ] as const;
    for (const m of msgs) {
      expect(parseGatewayClientMsg(JSON.stringify(m))).toEqual(m);
    }
  });

  it("rejects malformed client messages", () => {
    for (const bad of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ t: "sub", ch: 1, doc: "", mode: "active" }),
      JSON.stringify({ t: "sub", ch: 1, doc: "a", mode: "eager" }),
      JSON.stringify({ t: "sub", ch: -1, doc: "a", mode: "active" }),
      JSON.stringify({ t: "sub", ch: 1.5, doc: "a", mode: "active" }),
      JSON.stringify({ t: "act" }),
      JSON.stringify({ t: "nope", ch: 1 }),
    ]) {
      expect(parseGatewayClientMsg(bad)).toBeNull();
    }
  });

  it("round-trips every server message shape", () => {
    const msgs = [
      { t: "suberr", ch: 2, status: 409, message: "invalid" },
      { t: "resync", ch: 0 },
      { t: "touched", ch: 9 },
      { t: "reset", ch: 4 },
    ] as const;
    for (const m of msgs) {
      expect(parseGatewayServerMsg(JSON.stringify(m))).toEqual(m);
    }
  });

  it("defaults a missing suberr message and rejects a missing status", () => {
    expect(
      parseGatewayServerMsg(JSON.stringify({ t: "suberr", ch: 1, status: 403 })),
    ).toEqual({ t: "suberr", ch: 1, status: 403, message: "" });
    expect(
      parseGatewayServerMsg(JSON.stringify({ t: "suberr", ch: 1 })),
    ).toBeNull();
  });
});

describe("project room naming", () => {
  it("round-trips and refuses malformed names", () => {
    const name = projectRoomName("scope-1", "proj-2");
    expect(name).toBe("project:scope-1:proj-2");
    expect(parseProjectRoomName(name)).toEqual({
      scopeId: "scope-1",
      projectId: "proj-2",
      copyId: null,
    });
    for (const bad of [
      "scope-1:proj-2",
      "project:only-one",
      "project::proj",
      "project:scope:",
      "project:scope:proj:extra",
      "project:scope:proj:99999999-8888-7777-6666-555555555555:more",
      "scope:abc",
    ]) {
      expect(parseProjectRoomName(bad)).toBeNull();
    }
  });

  it("names a non-default working copy's gateway with its id (git-integration 0004)", () => {
    const CID = "99999999-8888-7777-6666-555555555555";
    const name = projectRoomName("scope-1", "proj-2", CID);
    expect(name).toBe(`project:scope-1:proj-2:${CID}`);
    expect(parseProjectRoomName(name)).toEqual({ scopeId: "scope-1", projectId: "proj-2", copyId: CID });
    expect(projectRoomName("scope-1", "proj-2", null)).toBe("project:scope-1:proj-2");
  });
});

describe("generation fencing (git-integration 0004)", () => {
  it("round-trips a sub carrying gen and rejects a malformed one", () => {
    const withGen = parseGatewayClientMsg(JSON.stringify({ t: "sub", ch: 1, doc: "a.kicad_sch", mode: "active", gen: 3 }));
    expect(withGen).toEqual({ t: "sub", ch: 1, doc: "a.kicad_sch", mode: "active", gen: 3 });
    const without = parseGatewayClientMsg(JSON.stringify({ t: "sub", ch: 1, doc: "a.kicad_sch", mode: "active" }));
    expect(without).toEqual({ t: "sub", ch: 1, doc: "a.kicad_sch", mode: "active" });
    expect("gen" in (without as object)).toBe(false);
    for (const gen of [-1, 1.5, "3", null]) {
      expect(parseGatewayClientMsg(JSON.stringify({ t: "sub", ch: 1, doc: "a", mode: "active", gen }))).toBeNull();
    }
  });

  it("recognizes the refusal only by status 409 + the reserved message", () => {
    expect(isGenerationRefusal(409, GENERATION_REFUSED)).toBe(true);
    expect(isGenerationRefusal(409, "file failed KiCad validation: x")).toBe(false);
    expect(isGenerationRefusal(410, GENERATION_REFUSED)).toBe(false);
    expect(GENERATION_CLOSE_CODE).toBe(4409);
  });
});
