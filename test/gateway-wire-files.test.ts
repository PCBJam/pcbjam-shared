import { describe, expect, it } from "vitest";
import {
  FILES_DOC_PATH,
  parseGatewayFileChange,
  parseGatewayServerMsg,
} from "../src/gateway-wire";

describe("gateway `files` hint (project-sync 0002)", () => {
  it("round-trips a well-formed frame", () => {
    const text = JSON.stringify({
      t: "files",
      ch: 3,
      seq: 7,
      changes: [
        { path: "a/b.kicad_pro", revision: 2, origin: "editor", by: "alice" },
        { path: "old.txt", revision: 0, deleted: true, origin: "job" },
      ],
    });
    expect(parseGatewayServerMsg(text)).toEqual({
      t: "files",
      ch: 3,
      seq: 7,
      changes: [
        { path: "a/b.kicad_pro", revision: 2, origin: "editor", by: "alice" },
        { path: "old.txt", revision: 0, deleted: true, origin: "job" },
      ],
    });
  });

  it("an empty change list is valid (the oversized-batch signal)", () => {
    expect(parseGatewayServerMsg('{"t":"files","ch":1,"seq":9,"changes":[]}')).toEqual({
      t: "files",
      ch: 1,
      seq: 9,
      changes: [],
    });
  });

  it("rejects malformed frames rather than partially accepting them", () => {
    expect(parseGatewayServerMsg('{"t":"files","ch":1,"changes":[]}')).toBeNull(); // no seq
    expect(parseGatewayServerMsg('{"t":"files","ch":1,"seq":-1,"changes":[]}')).toBeNull();
    expect(
      parseGatewayServerMsg(
        '{"t":"files","ch":1,"seq":1,"changes":[{"path":"x","revision":1,"origin":"nope"}]}',
      ),
    ).toBeNull();
    expect(parseGatewayFileChange({ path: "", revision: 1, origin: "editor" })).toBeNull();
    expect(parseGatewayFileChange({ path: "x", revision: 1.5, origin: "editor" })).toBeNull();
    // Unknown extras are dropped, not forwarded.
    expect(parseGatewayFileChange({ path: "x", revision: 1, origin: "upload", by: 4, z: 1 })).toEqual({
      path: "x",
      revision: 1,
      origin: "upload",
    });
  });

  it("the reserved channel name never collides with a project path", () => {
    expect(FILES_DOC_PATH.startsWith("~")).toBe(true);
  });
});
