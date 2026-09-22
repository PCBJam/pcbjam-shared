import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSymbolClipboard,
  isForm,
  providerLibName,
  resolveSymbolDefinition,
  unquote,
  withFootprintProperty,
  wrapSymbolLib,
  type Form,
} from "../src/symbol-lib.js";
import { parseSexpr, printSexpr } from "../src/sexpr.js";

const SAMPLE = readFileSync("plugin-platform/examples/sample-symbols.kicad_sym", "utf8"); // vitest runs from the package root
const prop = (def: Form, key: string) =>
  unquote(def.find((n) => isForm(n, "property") && unquote(n[1]) === key)?.[2]);
const units = (def: Form) => def.slice(2).filter((n) => isForm(n, "symbol")).map((n) => unquote((n as Form)[1]));

describe("providerLibName", () => {
  it.each([
    ["https://www.eda.cn", "eda_cn"],
    ["https://api.datasheets.md", "datasheets_md"],
    ["https://eda.cn/path?x=1", "eda_cn"],
    ["http://Parts-DB.example.co.uk:8443/x", "parts_db_example_co_uk"],
    ["https://www.api.example.com", "api_example_com"],
  ])("%s → %s", (origin, name) => expect(providerLibName(origin)).toBe(name));
  it("caps at 64 characters and refuses empty or invalid origins", () => {
    expect(providerLibName("https://" + "a".repeat(80) + ".com")).toHaveLength(64);
    expect(() => providerLibName("not a url")).toThrow(/origin/);
    expect(() => providerLibName("https://___/")).toThrow(/origin/);
  });
});

describe("resolveSymbolDefinition", () => {
  it("returns a base symbol unchanged in content, with its units", () => {
    const def = resolveSymbolDefinition(SAMPLE, "PluginResistor");
    expect(unquote(def[1])).toBe("PluginResistor");
    expect(units(def)).toEqual(["PluginResistor_0_1", "PluginResistor_1_1"]);
    expect(prop(def, "Value")).toBe("PluginResistor");
    expect(def.some((n) => isForm(n, "extends"))).toBe(false);
  });
  it("flattens a derived symbol: no extends, units renamed, child fields win", () => {
    const def = resolveSymbolDefinition(SAMPLE, "PluginResistor_10k");
    expect(unquote(def[1])).toBe("PluginResistor_10k");
    expect(def.some((n) => isForm(n, "extends"))).toBe(false);
    expect(units(def)).toEqual(["PluginResistor_10k_0_1", "PluginResistor_10k_1_1"]);
    expect(prop(def, "Value")).toBe("10k"); // overridden by the child
    expect(prop(def, "Reference")).toBe("R"); // inherited from the parent
    // Inherited pins survive the flattening.
    expect(printSexpr(def)).toContain("(pin passive line");
  });
  it("accepts a bare symbol, a Lib:Name key, and a single symbol under another name", () => {
    const bare = resolveSymbolDefinition('(symbol "X" (property "Value" "v" (at 0 0 0)) (symbol "X_0_1" (rectangle (start 0 0) (end 1 1))))', "X");
    expect(unquote(bare[1])).toBe("X");
    const keyed = resolveSymbolDefinition('(kicad_symbol_lib (symbol "Vendor:Part" (symbol "Part_0_1" (rectangle (start 0 0) (end 1 1)))))', "Part");
    expect(unquote(keyed[1])).toBe("Part");
    const renamed = resolveSymbolDefinition('(kicad_symbol_lib (symbol "Other" (symbol "Other_0_1" (rectangle (start 0 0) (end 1 1)))))', "Wanted");
    expect(unquote(renamed[1])).toBe("Wanted");
    expect(units(renamed)).toEqual(["Wanted_0_1"]);
  });
  it("rejects missing, duplicate and cyclic symbols and oversized input", () => {
    expect(() => resolveSymbolDefinition(SAMPLE, "Nope")).toThrow(/not found/);
    expect(() => resolveSymbolDefinition('(kicad_symbol_lib (symbol "A") (symbol "A"))', "A")).toThrow(/duplicate/);
    expect(() => resolveSymbolDefinition('(kicad_symbol_lib (symbol "A" (extends "B")) (symbol "B" (extends "A")))', "A")).toThrow(/Circular/);
    expect(() => resolveSymbolDefinition('(kicad_symbol_lib (symbol "A" (extends "Gone")))', "A")).toThrow(/Missing parent/);
    expect(() => resolveSymbolDefinition("(kicad_symbol_lib", "A")).toThrow(/Unbalanced/);
    expect(() => resolveSymbolDefinition('(kicad_symbol_lib (symbol "A" (symbol "A_x")))', "A")).toThrow(/unit name/);
    expect(() => resolveSymbolDefinition("(x ".repeat(60) + ")".repeat(60), "A")).toThrow(/limits/);
  });
});

describe("withFootprintProperty and wrapSymbolLib", () => {
  it("replaces an existing Footprint and inserts a hidden one when absent", () => {
    const base = resolveSymbolDefinition(SAMPLE, "PluginResistor");
    const replaced = withFootprintProperty(base, "eda_cn:R_0603");
    expect(prop(replaced, "Footprint")).toBe("eda_cn:R_0603");
    expect(replaced.filter((n) => isForm(n, "property") && unquote(n[1]) === "Footprint")).toHaveLength(1);
    const noFp = resolveSymbolDefinition('(symbol "X" (property "Reference" "U" (at 0 0 0)) (symbol "X_0_1" (rectangle (start 0 0) (end 1 1))))', "X");
    const inserted = withFootprintProperty(noFp, "eda_cn:P");
    expect(prop(inserted, "Footprint")).toBe("eda_cn:P");
    const tags = inserted.slice(2).map((n) => (n as Form)[0]);
    expect(tags.indexOf("property")).toBeLessThan(tags.indexOf("symbol"));
    expect(printSexpr(inserted)).toContain("(hide yes)");
  });
  it("wraps one definition into a parseable kicad_symbol_lib", () => {
    const text = wrapSymbolLib(resolveSymbolDefinition(SAMPLE, "PluginResistor"));
    const [root] = parseSexpr(text) as Form[];
    expect(root[0]).toBe("kicad_symbol_lib");
    expect(root.filter((n) => isForm(n, "symbol"))).toHaveLength(1);
    expect(resolveSymbolDefinition(text, "PluginResistor")[1]).toBe('"PluginResistor"');
  });
});

describe("buildSymbolClipboard", () => {
  it("emits the definition under its library id and one instance", () => {
    const def = withFootprintProperty(resolveSymbolDefinition(SAMPLE, "PluginResistor_10k"), "eda_cn:R_0603");
    const { label, sexpr } = buildSymbolClipboard(def, "eda_cn", "PluginResistor_10k", "12345678-1234-4234-8234-123456789abc");
    expect(label).toBe("eda_cn:PluginResistor_10k");
    const [libs, instance] = parseSexpr(sexpr) as Form[];
    expect(libs[0]).toBe("lib_symbols");
    expect(unquote((libs[1] as Form)[1])).toBe("eda_cn:PluginResistor_10k");
    expect(instance[0]).toBe("symbol");
    expect(unquote((instance.find((n) => isForm(n, "lib_id")) as Form)[1])).toBe("eda_cn:PluginResistor_10k");
    expect(prop(instance, "Reference")).toBe("R?");
    expect(prop(instance, "Value")).toBe("10k");
    expect(prop(instance, "Footprint")).toBe("eda_cn:R_0603");
    expect(sexpr).toContain('(uuid "12345678-1234-4234-8234-123456789abc")');
  });
});
