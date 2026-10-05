import { describe, expect, test } from "vitest";
import {
  BUILTIN_FAB_PROFILES,
  FAB_RULE_KEYS,
  builtinFabProfile,
  defaultChoices,
  fabDisclaimer,
  fabProfileSchema,
  matchingStackups,
  resolveFabRules,
  summarizeFabRules,
} from "../../src/index.js";

describe("built-in fab profiles", () => {
  test("ship in dialog order: KiCad default, PCBWay, JLCPCB", () => {
    expect(BUILTIN_FAB_PROFILES.map((p) => p.id)).toEqual(["kicad-default", "pcbway", "jlcpcb"]);
  });

  test.each(BUILTIN_FAB_PROFILES.map((p) => [p.id, p] as const))("%s parses and every value cites a declared source", (_id, profile) => {
    expect(() => fabProfileSchema.parse(profile)).not.toThrow();
    const sources = new Set(profile.sources.map((s) => s.id));
    for (const tier of Object.values(profile.tiers)) {
      for (const k of FAB_RULE_KEYS) {
        const v = tier.rules[k];
        if (v) {
          expect(sources.has(v.source)).toBe(true);
          expect(v.quote.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test.each(BUILTIN_FAB_PROFILES.map((p) => [p.id, p] as const))("%s has track/via rules for every offered layer count and tier", (_id, profile) => {
    for (const tier of Object.keys(profile.tiers)) {
      for (const layers of profile.options.layers) {
        for (const copperOuter of profile.options.copperOuter) {
          const rules = resolveFabRules(profile, { tier, layers, copperOuter });
          expect(rules.trackWidth, `${tier} ${layers}L ${copperOuter}oz`).toBeDefined();
          expect(rules.viaDrill, `${tier} ${layers}L ${copperOuter}oz`).toBeDefined();
        }
      }
    }
  });

  test("an unknown source id fails the schema", () => {
    const p = structuredClone(builtinFabProfile("jlcpcb")!);
    p.tiers.standard!.rules.trackWidth!.source = "nope";
    expect(fabProfileSchema.safeParse(p).success).toBe(false);
  });
});

describe("resolveFabRules", () => {
  const jlc = builtinFabProfile("jlcpcb")!;

  test("layer count overrides the base rules", () => {
    expect(resolveFabRules(jlc, { tier: "standard", layers: 2, copperOuter: 1 }).trackWidth?.mm).toBe(0.1);
    expect(resolveFabRules(jlc, { tier: "standard", layers: 4, copperOuter: 1 }).trackWidth?.mm).toBe(0.09);
  });

  test("copper weight overrides layer count", () => {
    expect(resolveFabRules(jlc, { tier: "standard", layers: 2, copperOuter: 2 }).trackWidth?.mm).toBe(0.16);
    expect(resolveFabRules(jlc, { tier: "standard", layers: 4, copperOuter: 2 }).trackWidth?.mm).toBe(0.15);
  });

  test("advanced extends standard", () => {
    const adv = resolveFabRules(jlc, { tier: "advanced", layers: 2, copperOuter: 1 });
    expect(adv.viaDrill?.mm).toBe(0.15);
    expect(adv.silkTextHeight?.mm).toBe(1.0);
  });

  test("summary line", () => {
    expect(summarizeFabRules(resolveFabRules(jlc, { tier: "standard", layers: 2, copperOuter: 1 }))).toBe("0.1 / 0.1 mm · via 0.3 / 0.4 mm");
  });
});

describe("defaults and stackups", () => {
  test("JLCPCB 4-layer 1.6 mm 1 oz matches its named stackups", () => {
    const jlc = builtinFabProfile("jlcpcb")!;
    expect(matchingStackups(jlc, { layers: 4, thicknessMm: 1.6, copperOuter: 1 }).map((s) => s.id)).toEqual(["JLC04161H-7628", "JLC04161H-3313"]);
    expect(matchingStackups(jlc, { layers: 4, thicknessMm: 1.2, copperOuter: 1 })).toEqual([]);
  });

  test("default choices are offered by the profile", () => {
    for (const p of BUILTIN_FAB_PROFILES) {
      const c = defaultChoices(p);
      expect(p.options.layers).toContain(c.layers);
      expect(p.options.thicknessMm).toContain(c.thicknessMm);
    }
  });
});

describe("fabDisclaimer", () => {
  test("names the fab and the review date; none for KiCad default", () => {
    expect(fabDisclaimer(builtinFabProfile("pcbway")!)).toMatch(/^Rules based on PCBWay's published capabilities as of \d{4}-\d{2}-\d{2}\. /);
    expect(fabDisclaimer(builtinFabProfile("kicad-default")!)).toBeNull();
  });
});
