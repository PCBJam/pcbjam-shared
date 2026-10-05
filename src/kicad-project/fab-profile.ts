import { z } from "zod";

/**
 * Fab profiles (new-kicad-project 0001): a manufacturer's published
 * capabilities as data, every value citing the page it was read from. The
 * New KiCad project dialog turns a profile plus the user's choices into
 * design rules (`generate.ts`); the docs site renders the same JSON as one
 * page per fab. Profiles are MIT so anyone can check and correct them.
 *
 * Values are millimetres. A rule is a MINIMUM the fab can make; the generator
 * writes them as KiCad's board-setup minimums and `.kicad_dru` rules.
 */

/** One sourced value: the number, where it came from, and the verbatim text. */
export const fabValueSchema = z.object({
  mm: z.number().nonnegative(),
  /** Id of an entry in the profile's `sources`. */
  source: z.string().min(1),
  /** The row or section label on the source page, verbatim (a text anchor). */
  anchor: z.string().min(1).optional(),
  /** The text on the source page the value was read from, verbatim. */
  quote: z.string().min(1),
  /** How the number follows from the quote when it is not literally in it. */
  note: z.string().optional(),
});
export type FabValue = z.infer<typeof fabValueSchema>;

/** Every rule a profile may set. Unset rules fall back to KiCad's defaults. */
export const FAB_RULE_KEYS = [
  "trackWidth",
  "clearance",
  "viaDrill",
  "viaDiameter",
  "viaAnnular",
  "holeMin",
  "holeToHole",
  "padHoleToHole",
  "holeClearance",
  "pthToTrack",
  "pthAnnular",
  "copperEdge",
  "silkWidth",
  "silkTextHeight",
  "silkClearance",
  "maskWeb",
] as const;
export type FabRuleKey = (typeof FAB_RULE_KEYS)[number];

/** Short human labels, shared by the dialog summary and the docs tables. */
export const FAB_RULE_LABELS: Record<FabRuleKey, string> = {
  trackWidth: "Track width",
  clearance: "Copper clearance",
  viaDrill: "Via drill",
  viaDiameter: "Via diameter",
  viaAnnular: "Via annular ring",
  holeMin: "Smallest hole",
  holeToHole: "Hole to hole",
  padHoleToHole: "Pad hole to pad hole",
  holeClearance: "Hole to copper",
  pthToTrack: "Plated hole to track",
  pthAnnular: "Plated hole annular ring",
  copperEdge: "Copper to board edge",
  silkWidth: "Silkscreen line width",
  silkTextHeight: "Silkscreen text height",
  silkClearance: "Silkscreen to pad",
  maskWeb: "Solder mask web",
};

export const fabRulesSchema = z.object(
  Object.fromEntries(FAB_RULE_KEYS.map((k) => [k, fabValueSchema.optional()])) as Record<
    FabRuleKey,
    z.ZodOptional<typeof fabValueSchema>
  >,
).strict();
export type FabRules = z.infer<typeof fabRulesSchema>;

/** Rules plus per-layer-count overrides (keys "2", "4", "6"). */
const ruleSetSchema = z.object({
  rules: fabRulesSchema,
  byLayers: z.record(z.string().regex(/^\d+$/), fabRulesSchema).optional(),
});

export const fabTierSchema = ruleSetSchema.extend({
  label: z.string().min(1),
  description: z.string().min(1),
  /** Tier these rules override (e.g. "advanced" extends "standard"). */
  extends: z.string().optional(),
  /** Overrides by outer copper weight in oz ("2" = 2 oz), layered on top. */
  byCopper: z.record(z.string().regex(/^\d+(\.\d+)?$/), ruleSetSchema).optional(),
});
export type FabTier = z.infer<typeof fabTierSchema>;

export const fabStackupLayerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("copper"), mm: z.number().positive() }),
  z.object({
    kind: z.enum(["core", "prepreg"]),
    mm: z.number().positive(),
    material: z.string().min(1),
    er: z.number().positive(),
    lossTangent: z.number().nonnegative().optional(),
  }),
]);
export type FabStackupLayer = z.infer<typeof fabStackupLayerSchema>;

export const fabStackupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layers: z.number().int().min(2),
  thicknessMm: z.number().positive(),
  copperOuter: z.number().positive(),
  copperInner: z.number().positive().optional(),
  source: z.string().min(1),
  anchor: z.string().optional(),
  /** Top to bottom, copper and dielectrics alternating. */
  build: z.array(fabStackupLayerSchema).min(3),
});
export type FabStackup = z.infer<typeof fabStackupSchema>;

export const fabSourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** false = the daily freshness check skips this page (it changes on every load). */
  check: z.boolean().optional(),
});
export type FabSource = z.infer<typeof fabSourceSchema>;

export const fabProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    kind: z.enum(["kicad", "fab"]),
    /** Bumped on any value change; recorded in pcbjam.lock.json. */
    version: z.number().int().positive(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** People who checked every value against the sources. Empty until signed off. */
    reviewers: z.array(z.string()),
    website: z.string().url(),
    sources: z.array(fabSourceSchema).min(1),
    tiers: z.object({ standard: fabTierSchema }).catchall(fabTierSchema),
    stackups: z.array(fabStackupSchema).default([]),
    options: z.object({
      layers: z.array(z.number().int().min(1)).min(1),
      thicknessMm: z.array(z.number().positive()).min(1),
      copperOuter: z.array(z.number().positive()).min(1),
      copperInner: z.array(z.number().positive()).min(1),
    }),
    defaults: z.object({
      layers: z.number().int(),
      thicknessMm: z.number().positive(),
      copperOuter: z.number().positive(),
      copperInner: z.number().positive(),
    }),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.sources.map((s) => s.id));
    const check = (v: FabValue | undefined, path: (string | number)[]) => {
      if (v && !ids.has(v.source)) ctx.addIssue({ code: "custom", path, message: `unknown source "${v.source}"` });
    };
    const checkRules = (r: FabRules | undefined, path: (string | number)[]) => {
      for (const k of FAB_RULE_KEYS) check(r?.[k], [...path, k]);
    };
    for (const [tierId, tier] of Object.entries(p.tiers)) {
      checkRules(tier.rules, ["tiers", tierId, "rules"]);
      for (const [n, r] of Object.entries(tier.byLayers ?? {})) checkRules(r, ["tiers", tierId, "byLayers", n]);
      for (const [oz, set] of Object.entries(tier.byCopper ?? {})) {
        checkRules(set.rules, ["tiers", tierId, "byCopper", oz, "rules"]);
        for (const [n, r] of Object.entries(set.byLayers ?? {})) checkRules(r, ["tiers", tierId, "byCopper", oz, "byLayers", n]);
      }
      if (tier.extends && !(tier.extends in p.tiers)) {
        ctx.addIssue({ code: "custom", path: ["tiers", tierId, "extends"], message: `unknown tier "${tier.extends}"` });
      }
    }
    p.stackups.forEach((s, i) => {
      if (!ids.has(s.source)) ctx.addIssue({ code: "custom", path: ["stackups", i, "source"], message: `unknown source "${s.source}"` });
    });
    if (!p.options.layers.includes(p.defaults.layers)) {
      ctx.addIssue({ code: "custom", path: ["defaults", "layers"], message: "default layer count is not offered" });
    }
  });
export type FabProfile = z.infer<typeof fabProfileSchema>;

/** What the user picked in the dialog. */
export const kicadProjectChoicesSchema = z.object({
  layers: z.number().int().min(1),
  tier: z.string().min(1),
  thicknessMm: z.number().positive(),
  copperOuter: z.number().positive(),
  copperInner: z.number().positive(),
  stackup: z.string().nullable().optional(),
});
export type KicadProjectChoices = z.infer<typeof kicadProjectChoicesSchema>;

/** A rule after tiers, layer count and copper weight are applied. */
export type ResolvedFabRules = Partial<Record<FabRuleKey, FabValue>>;

function mergeRules(into: ResolvedFabRules, rules: FabRules | undefined): void {
  if (!rules) return;
  for (const k of FAB_RULE_KEYS) {
    const v = rules[k];
    if (v) into[k] = v;
  }
}

/** Tier chain from the base tier up to `tierId` ("advanced" → [standard, advanced]). */
function tierChain(profile: FabProfile, tierId: string): FabTier[] {
  const chain: FabTier[] = [];
  const seen = new Set<string>();
  let id: string | undefined = tierId;
  while (id) {
    if (seen.has(id)) throw new Error(`fab profile ${profile.id}: tier cycle at "${id}"`);
    seen.add(id);
    const tier: FabTier | undefined = profile.tiers[id];
    if (!tier) throw new Error(`fab profile ${profile.id}: unknown tier "${id}"`);
    chain.unshift(tier);
    id = tier.extends;
  }
  return chain;
}

/**
 * The rules for one set of choices. Order (later wins): each tier from the
 * base up, its layer-count overrides, then its copper-weight overrides.
 */
export function resolveFabRules(profile: FabProfile, choices: Pick<KicadProjectChoices, "tier" | "layers" | "copperOuter">): ResolvedFabRules {
  const out: ResolvedFabRules = {};
  const n = String(choices.layers);
  const oz = String(choices.copperOuter);
  for (const tier of tierChain(profile, choices.tier)) {
    mergeRules(out, tier.rules);
    mergeRules(out, tier.byLayers?.[n]);
    const copper = tier.byCopper?.[oz];
    mergeRules(out, copper?.rules);
    mergeRules(out, copper?.byLayers?.[n]);
  }
  return out;
}

/** Stackups that fit the choices (same layer count, thickness, outer copper). */
export function matchingStackups(profile: FabProfile, choices: Pick<KicadProjectChoices, "layers" | "thicknessMm" | "copperOuter">): FabStackup[] {
  return profile.stackups.filter(
    (s) => s.layers === choices.layers && s.thicknessMm === choices.thicknessMm && s.copperOuter === choices.copperOuter,
  );
}

const fmt = (mm: number) => `${Number(mm.toFixed(3))}`;

/** One-line summary for a template card: "0.1 / 0.1 mm · via 0.3 / 0.4 mm". */
export function summarizeFabRules(rules: ResolvedFabRules): string {
  const parts: string[] = [];
  if (rules.trackWidth && rules.clearance) parts.push(`${fmt(rules.trackWidth.mm)} / ${fmt(rules.clearance.mm)} mm`);
  if (rules.viaDrill && rules.viaDiameter) parts.push(`via ${fmt(rules.viaDrill.mm)} / ${fmt(rules.viaDiameter.mm)} mm`);
  else if (rules.viaDrill) parts.push(`via drill ${fmt(rules.viaDrill.mm)} mm`);
  return parts.join(" · ");
}

/** Default choices for a profile (the dialog's starting state). */
export function defaultChoices(profile: FabProfile): KicadProjectChoices {
  const d = profile.defaults;
  const stackup = matchingStackups(profile, d)[0]?.id ?? null;
  return { layers: d.layers, tier: "standard", thicknessMm: d.thicknessMm, copperOuter: d.copperOuter, copperInner: d.copperInner, stackup };
}

/** Throws a readable message when the choices don't fit the profile. */
export function assertChoicesFit(profile: FabProfile, c: KicadProjectChoices): void {
  const o = profile.options;
  if (!o.layers.includes(c.layers)) throw new Error(`${profile.name} does not offer ${c.layers} layers`);
  if (!(c.tier in profile.tiers)) throw new Error(`${profile.name} has no "${c.tier}" tier`);
  if (!o.thicknessMm.includes(c.thicknessMm)) throw new Error(`${profile.name} does not offer ${c.thicknessMm} mm boards`);
  if (!o.copperOuter.includes(c.copperOuter)) throw new Error(`${profile.name} does not offer ${c.copperOuter} oz outer copper`);
  if (c.layers > 2 && !o.copperInner.includes(c.copperInner)) throw new Error(`${profile.name} does not offer ${c.copperInner} oz inner copper`);
  if (c.stackup && !matchingStackups(profile, c).some((s) => s.id === c.stackup)) {
    throw new Error(`stackup "${c.stackup}" does not fit ${c.layers} layers, ${c.thicknessMm} mm, ${c.copperOuter} oz`);
  }
}
