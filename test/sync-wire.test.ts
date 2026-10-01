import { describe, expect, it } from "vitest";
import {
  decodeBundle,
  decodeFolder,
  decodeFrames,
  diffManifest,
  encodeBundle,
  encodeFolder,
  encodeFrames,
  sha256Hex,
  type SyncManifest,
} from "../src/sync-wire.js";

const enc = new TextEncoder();
const body = (s: string) => enc.encode(s);

function manifest(
  entries: Record<string, { hash: string; size?: number }>,
  version = 1,
): SyncManifest {
  return {
    version,
    entries: Object.fromEntries(
      Object.entries(entries).map(([p, e]) => [
        p,
        { hash: e.hash, size: e.size ?? 0, mtime: 0 },
      ]),
    ),
  };
}

describe("sha256Hex", () => {
  it("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex(body("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("diffManifest", () => {
  it("treats a null local as init — every remote path is a put", () => {
    const remote = manifest({ "a": { hash: "x" }, "b": { hash: "y" } });
    expect(diffManifest(null, remote)).toEqual({ put: ["a", "b"], del: [] });
  });

  it("puts only changed/added paths and dels only removed ones", () => {
    const local = manifest({
      same: { hash: "1" },
      changed: { hash: "old" },
      gone: { hash: "3" },
    });
    const remote = manifest({
      same: { hash: "1" },
      changed: { hash: "new" },
      added: { hash: "4" },
    });
    const diff = diffManifest(local, remote);
    expect(diff.put.sort()).toEqual(["added", "changed"]);
    expect(diff.del).toEqual(["gone"]);
  });

  it("is a no-op when identical", () => {
    const m = manifest({ a: { hash: "1" }, b: { hash: "2" } });
    expect(diffManifest(m, m)).toEqual({ put: [], del: [] });
  });
});

describe("frame codec", () => {
  it("round-trips path/body pairs, including empty and binary bodies", () => {
    const entries: Array<[string, Uint8Array]> = [
      ["symbol/R", body("(symbol R)")],
      ["symbol/Empty", new Uint8Array()],
      ["footprint/0805", new Uint8Array([0, 255, 1, 254, 13, 10])],
      ["weird/náме with spaces", body("ünïcödé")],
    ];
    const decoded = decodeFrames(encodeFrames(entries));
    expect(decoded.length).toBe(entries.length);
    for (let i = 0; i < entries.length; i++) {
      expect(decoded[i]![0]).toBe(entries[i]![0]);
      expect([...decoded[i]![1]]).toEqual([...entries[i]![1]]);
    }
  });

  it("decodes an empty buffer to no frames", () => {
    expect(decodeFrames(new Uint8Array())).toEqual([]);
  });

  it("decoded bodies are standalone copies, not views into the input", () => {
    const buf = encodeFrames([["p", body("abc")]]);
    const [[, b]] = decodeFrames(buf);
    expect(b!.buffer).not.toBe(buf.buffer);
  });
});

describe("bundle codec", () => {
  it("round-trips manifest + bodies, and survives a byte-offset input", () => {
    const m = manifest({ "a/b": { hash: "z", size: 3 } }, 7);
    const bodies: Array<[string, Uint8Array]> = [
      ["a/b", body("xyz")],
      ["c/d", body("")],
    ];
    const buf = encodeBundle(m, bodies);

    // Wrap in a larger buffer at a non-zero offset to catch DataView offset bugs.
    const padded = new Uint8Array(buf.length + 5);
    padded.set(buf, 5);
    const view = padded.subarray(5);

    const out = decodeBundle(view);
    expect(out.manifest).toEqual(m);
    expect(out.bodies.map(([p]) => p)).toEqual(["a/b", "c/d"]);
    expect([...out.bodies[0]![1]]).toEqual([...body("xyz")]);
    expect(out.bodies[1]![1].length).toBe(0);
  });
});

describe("folder codec (project-sync 0003)", () => {
  const folder = {
    revisions: { "docs/a.md": 2, "docs/b.bin": 1, "docs/room-only.kicad_sch": 0 },
    omitted: ["docs/huge.step"],
    files: [
      ["docs/a.md", enc.encode("AAA")],
      ["docs/b.bin", new Uint8Array([0, 255, 128, 10])],
      ["docs/room-only.kicad_sch", enc.encode("")],
    ] as Array<[string, Uint8Array]>,
  };

  it("round-trips bodies, revisions and the omitted list", () => {
    const out = decodeFolder(encodeFolder(folder));
    expect(out.revisions).toEqual(folder.revisions);
    expect(out.omitted).toEqual(["docs/huge.step"]);
    expect(out.files.map(([p, b]) => [p, Array.from(b)])).toEqual(folder.files.map(([p, b]) => [p, Array.from(b)]));
  });

  it("decodes from a view into a larger buffer", () => {
    const buf = encodeFolder(folder);
    const padded = new Uint8Array(buf.length + 7);
    padded.set(buf, 3);
    expect(decodeFolder(padded.subarray(3, 3 + buf.length)).files).toHaveLength(3);
  });

  it("refuses a response that was cut short, wherever the cut is", () => {
    const buf = encodeFolder(folder);
    for (const cut of [2, 20, buf.length - 30, buf.length - 1]) {
      expect(() => decodeFolder(buf.subarray(0, cut))).toThrow();
    }
  });

  it("an empty folder is a header and nothing else", () => {
    expect(decodeFolder(encodeFolder({ revisions: {}, omitted: [], files: [] }))).toEqual({ revisions: {}, omitted: [], files: [] });
  });
});
