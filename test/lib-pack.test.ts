import { describe, expect, it } from "vitest";
import { decodeLibPack, encodeLibPack, libPackKey } from "../src/lib-pack.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("library pack", () => {
  it("round-trips the bundles by (libId, versionId)", () => {
    const pack = encodeLibPack([
      { libId: "a", versionId: "1", name: "Device", bundle: bytes("device bundle") },
      { libId: "b", versionId: "7", name: "Resistor_SMD", bundle: bytes("") },
      { libId: "c", versionId: "2", name: "Connector", bundle: bytes("connector") },
    ]);
    const map = decodeLibPack(pack);
    expect([...map.keys()]).toEqual(["a@1", "b@7", "c@2"]);
    expect(new TextDecoder().decode(map.get(libPackKey("a", "1")))).toBe("device bundle");
    expect(map.get("b@7")!.byteLength).toBe(0);
    expect(new TextDecoder().decode(map.get("c@2"))).toBe("connector");
  });

  it("decodes from an offset view (a sliced download buffer)", () => {
    const pack = encodeLibPack([{ libId: "a", versionId: "1", name: "x", bundle: bytes("xyz") }]);
    const padded = new Uint8Array(pack.byteLength + 5);
    padded.set(pack, 5);
    expect(new TextDecoder().decode(decodeLibPack(padded.subarray(5)).get("a@1"))).toBe("xyz");
  });

  it("refuses a non-pack and a truncated pack", () => {
    expect(() => decodeLibPack(bytes("not a pack at all"))).toThrow(/not a library pack/);
    const pack = encodeLibPack([{ libId: "a", versionId: "1", name: "x", bundle: bytes("0123456789") }]);
    expect(() => decodeLibPack(pack.subarray(0, pack.byteLength - 3))).toThrow(/truncated/);
  });
});
