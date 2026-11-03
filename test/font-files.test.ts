import { describe, expect, it } from "vitest";
import { fontFacesLabel, fontFacesLicense, fontRefusalReason, planFontUpload, type FontFace } from "../src/index.js";

const face = (over: Partial<FontFace> = {}): FontFace => ({
  index: 0,
  family: "Inter",
  style: "Regular",
  weight: 400,
  italic: false,
  embedding: "installable",
  ...over,
});

const file = (name: string, text: string, size = text.length) => ({
  name,
  size,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
});

const sha = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");

describe("planFontUpload", () => {
  it("adds new fonts, skips same content, offers to replace other content, leaves out non-fonts", async () => {
    const plan = await planFontUpload(
      [file("New.ttf", "a"), file("Same.otf", "b"), file("Changed.ttc", "c"), file("readme.txt", "d"), file("New.ttf", "again")],
      [
        { name: "Same.otf", sha256: await sha("b") },
        { name: "Changed.ttc", sha256: await sha("old") },
      ],
    );
    expect(plan.add.map((p) => p.name)).toEqual(["New.ttf"]);
    expect(plan.same).toEqual(["Same.otf"]);
    expect(plan.replace.map((p) => p.name)).toEqual(["Changed.ttc"]);
    expect(plan.refused).toEqual([]);
  });

  it("refuses files over 32 MB before sending them", async () => {
    const plan = await planFontUpload([file("Huge.ttf", "x", 33 * 1024 * 1024)], []);
    expect(plan.add).toEqual([]);
    expect(plan.refused).toEqual([{ name: "Huge.ttf", reason: "larger than 32 MB" }]);
  });
});

describe("font labels", () => {
  it("names the free license only when every face states the same one", () => {
    expect(fontFacesLicense([face({ license: { id: "OFL" } }), face({ license: { id: "OFL" } })])).toBe("SIL Open Font License");
    expect(fontFacesLicense([face({ license: { id: "OFL" } }), face({ license: { id: null } })])).toBeNull();
    expect(fontFacesLicense([face()])).toBeNull();
  });

  it("joins a collection's families and styles, and falls back to the file name", () => {
    expect(fontFacesLabel([face(), face({ index: 1, style: "Bold" })], "fonts/Inter.ttc")).toEqual({ family: "Inter", styles: "Regular, Bold" });
    expect(fontFacesLabel([], "fonts/Odd.ttf")).toEqual({ family: "Odd.ttf", styles: "" });
  });

  it("keeps only the reason of a refusal", () => {
    expect(fontRefusalReason("A.ttf", "A.ttf: its license does not allow embedding")).toBe("its license does not allow embedding");
    expect(fontRefusalReason("A.ttf", "team storage is full")).toBe("team storage is full");
    expect(fontRefusalReason("A.ttf", null, 403)).toBe("upload failed (403)");
  });
});
