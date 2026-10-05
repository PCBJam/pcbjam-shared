import { formatKicadText } from "../kicad-format.js";
import { KICAD_GITIGNORE } from "../kicad-gitignore.js";
import {
  assertChoicesFit,
  matchingStackups,
  resolveFabRules,
  type FabProfile,
  type FabStackupLayer,
  type KicadProjectChoices,
  type ResolvedFabRules,
} from "./fab-profile.js";

/**
 * The New KiCad project generator (new-kicad-project 0001): a fab profile and
 * the user's choices in, the files of a KiCad project out. Pure and
 * deterministic (uuids come from a seeded hash), so the same input always
 * gives the same bytes.
 *
 * Format versions are the ones the editor writes today. `.kicad_pro` keys
 * follow the fork's `BOARD_DESIGN_SETTINGS` / `NET_SETTINGS` JSON parameters
 * (pcbnew/board_design_settings.cpp, common/project/net_settings.cpp); the
 * nested `meta.version` values match their schema versions there, without
 * which KiCad ignores the section.
 */

export const KICAD_SCH_VERSION = 20250114;
export const KICAD_PCB_VERSION = 20241229;
export const KICAD_GENERATOR_VERSION = "9.0";
/** projectFileSchemaVersion (common/project/project_file.cpp). */
export const KICAD_PRO_VERSION = 3;
/** bdsSchemaVersion (pcbnew/board_design_settings.cpp). */
const BDS_SCHEMA_VERSION = 2;
/** netSettingsSchemaVersion (common/project/net_settings.cpp). */
const NET_SETTINGS_SCHEMA_VERSION = 5;

/** KiCad's own Default net class sizes (common/netclass.cpp). */
const KICAD_NETCLASS = { clearance: 0.2, track: 0.2, viaDiameter: 0.6, viaDrill: 0.3 };
const COPPER_MM_PER_OZ = 0.035;
const MASK_MM = 0.01;

export interface GenerateKicadProjectOptions {
  /** File stem: `<name>.kicad_pro`. */
  name: string;
  /** Folder relative to the PCBJam project root ("" = the root). */
  dir: string;
  /** YYYY-MM-DD for the title block. */
  date: string;
  company?: string;
  /** Also write the KiCad `.gitignore` at the PCBJam project root. */
  gitignore?: boolean;
  /** Seed for the deterministic uuids; defaults to name + profile + date. */
  seed?: string;
}

export interface GeneratedFile {
  /** Relative to the PCBJam project root. */
  path: string;
  text: string;
}

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/** Null when `name` is a usable KiCad project stem, else the reason. */
export function validateKicadProjectName(name: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (name !== name.trim()) return "The name can't start or end with a space.";
  if (name.length > 100) return "Use 100 characters or fewer.";
  if (BAD_NAME.test(name)) return 'The name can\'t contain / \\ : * ? " < > |.';
  if (name.startsWith(".")) return "The name can't start with a dot.";
  return null;
}

/** Null when `dir` is a usable relative folder ("" allowed), else the reason. */
export function validateKicadProjectDir(dir: string): string | null {
  if (dir === "") return null;
  if (dir.startsWith("/") || dir.endsWith("/")) return "The folder path can't start or end with /.";
  for (const part of dir.split("/")) {
    if (!part || part === "." || part === "..") return "The folder path has an empty or relative part.";
    const bad = validateKicadProjectName(part);
    if (bad) return `Folder "${part}": ${bad}`;
  }
  return null;
}

/** The paths a KiCad project `name` in `dir` occupies. */
export function kicadProjectPaths(name: string, dir: string) {
  const base = dir ? `${dir}/${name}` : name;
  return {
    pro: `${base}.kicad_pro`,
    sch: `${base}.kicad_sch`,
    pcb: `${base}.kicad_pcb`,
    dru: `${base}.kicad_dru`,
  };
}

// --- deterministic uuids --------------------------------------------------

/** cyrb128: four 32-bit hashes of a string. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** A v4-shaped uuid derived from `seed`. */
export function seededUuid(seed: string): string {
  const hex = cyrb128(seed).map((n) => n.toString(16).padStart(8, "0")).join("");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// --- helpers --------------------------------------------------------------

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
/** Millimetres as KiCad writes them: no trailing zeros, at most 4 decimals. */
const n = (mm: number) => `${Number(mm.toFixed(4))}`;
const mmv = (rules: ResolvedFabRules, k: keyof ResolvedFabRules) => rules[k]?.mm;

/** The Default net class: KiCad's sizes, raised to the fab's minimums. */
function netclassSizes(rules: ResolvedFabRules) {
  const viaDrill = Math.max(KICAD_NETCLASS.viaDrill, mmv(rules, "viaDrill") ?? 0, mmv(rules, "holeMin") ?? 0);
  const ring = mmv(rules, "viaAnnular") ?? 0;
  const viaDiameter = Math.max(KICAD_NETCLASS.viaDiameter, mmv(rules, "viaDiameter") ?? 0, viaDrill + 2 * ring);
  return {
    clearance: Math.max(KICAD_NETCLASS.clearance, mmv(rules, "clearance") ?? 0),
    track: Math.max(KICAD_NETCLASS.track, mmv(rules, "trackWidth") ?? 0),
    viaDiameter: Number(viaDiameter.toFixed(4)),
    viaDrill: Number(viaDrill.toFixed(4)),
  };
}

// --- .kicad_pro ------------------------------------------------------------

function kicadPro(profile: FabProfile, choices: KicadProjectChoices, rules: ResolvedFabRules, fileName: string): string {
  const r: Record<string, number> = {};
  const set = (key: string, v: number | undefined) => {
    if (v !== undefined) r[key] = v;
  };
  set("min_clearance", mmv(rules, "clearance"));
  set("min_track_width", mmv(rules, "trackWidth"));
  set("min_via_annular_width", mmv(rules, "viaAnnular"));
  set("min_via_diameter", mmv(rules, "viaDiameter"));
  set("min_through_hole_diameter", mmv(rules, "holeMin") ?? mmv(rules, "viaDrill"));
  set("min_hole_to_hole", mmv(rules, "holeToHole"));
  set("min_hole_clearance", mmv(rules, "holeClearance"));
  set("min_copper_edge_clearance", mmv(rules, "copperEdge"));
  set("min_silk_clearance", mmv(rules, "silkClearance"));
  set("min_text_height", mmv(rules, "silkTextHeight"));
  set("min_text_thickness", mmv(rules, "silkWidth"));

  const nc = netclassSizes(rules);
  const pro: Record<string, unknown> = {
    board: {
      design_settings: {
        meta: { version: BDS_SCHEMA_VERSION },
        rules: r,
        track_widths: [0],
        via_dimensions: [{ diameter: 0, drill: 0 }],
      },
    },
    meta: { filename: fileName, version: KICAD_PRO_VERSION },
    net_settings: {
      classes: [
        {
          name: "Default",
          priority: 2147483647,
          clearance: nc.clearance,
          track_width: nc.track,
          via_diameter: nc.viaDiameter,
          via_drill: nc.viaDrill,
          microvia_diameter: 0.3,
          microvia_drill: 0.1,
          diff_pair_width: 0.2,
          diff_pair_gap: 0.25,
          diff_pair_via_gap: 0.25,
          wire_width: 6,
          bus_width: 12,
          line_style: 0,
        },
      ],
      meta: { version: NET_SETTINGS_SCHEMA_VERSION },
    },
  };
  if (profile.kind === "fab") {
    pro.text_variables = { FAB: profile.name, FAB_PROFILE: `${profile.id} v${profile.version} (${choices.tier}${choices.smallest ? ", smallest" : ""})` };
  }
  return `${JSON.stringify(pro, null, 2)}\n`;
}

// --- .kicad_pcb ------------------------------------------------------------

/** The technical layers of KiCad's new board (same set as the editor's template). */
const TECH_LAYERS = [
  '(9 "F.Adhes" user "F.Adhesive")',
  '(11 "B.Adhes" user "B.Adhesive")',
  '(13 "F.Paste" user)',
  '(15 "B.Paste" user)',
  '(5 "F.SilkS" user "F.Silkscreen")',
  '(7 "B.SilkS" user "B.Silkscreen")',
  '(1 "F.Mask" user)',
  '(3 "B.Mask" user)',
  '(17 "Dwgs.User" user "User.Drawings")',
  '(19 "Cmts.User" user "User.Comments")',
  '(21 "Eco1.User" user "User.Eco1")',
  '(23 "Eco2.User" user "User.Eco2")',
  '(25 "Edge.Cuts" user)',
  '(27 "Margin" user)',
  '(31 "F.CrtYd" user "F.Courtyard")',
  '(29 "B.CrtYd" user "B.Courtyard")',
  '(35 "F.Fab" user)',
  '(33 "B.Fab" user)',
];

/** Copper layer names top to bottom: F.Cu, In1.Cu … B.Cu. */
function copperNames(layers: number): string[] {
  const inner = Array.from({ length: layers - 2 }, (_, i) => `In${i + 1}.Cu`);
  return ["F.Cu", ...inner, "B.Cu"];
}

/** KiCad 9 layer ids: F.Cu 0, B.Cu 2, InN.Cu 2N+2. */
function copperId(name: string): number {
  if (name === "F.Cu") return 0;
  if (name === "B.Cu") return 2;
  return 2 * Number(/^In(\d+)\.Cu$/.exec(name)![1]) + 2;
}

/** A generic FR4 build: thin prepregs outside, cores share the rest (KiCad's default shape). */
function genericBuild(choices: KicadProjectChoices): FabStackupLayer[] {
  const { layers } = choices;
  const outer = COPPER_MM_PER_OZ * choices.copperOuter;
  const inner = COPPER_MM_PER_OZ * choices.copperInner;
  const copperTotal = 2 * outer + (layers - 2) * inner;
  const dielectricCount = layers - 1;
  const prepregs = layers === 2 ? 0 : layers / 2;
  const cores = dielectricCount - prepregs;
  const prepregMm = 0.1;
  const coreMm = Math.max(0.05, (choices.thicknessMm - 2 * MASK_MM - copperTotal - prepregs * prepregMm) / cores);
  const build: FabStackupLayer[] = [];
  for (let i = 0; i < layers; i++) {
    build.push({ kind: "copper", mm: i === 0 || i === layers - 1 ? outer : inner });
    if (i === layers - 1) break;
    // Dielectric i: even index = prepreg (for multilayer), odd = core.
    const isPrepreg = layers > 2 && i % 2 === 0;
    build.push(
      isPrepreg
        ? { kind: "prepreg", mm: prepregMm, material: "FR4", er: 4.5, lossTangent: 0.02 }
        : { kind: "core", mm: Number(coreMm.toFixed(4)), material: "FR4", er: 4.5, lossTangent: 0.02 },
    );
  }
  return build;
}

function stackupSexpr(build: FabStackupLayer[], layers: number): string {
  const names = copperNames(layers);
  const out: string[] = [
    '(layer "F.SilkS" (type "Top Silk Screen"))',
    '(layer "F.Paste" (type "Top Solder Paste"))',
    `(layer "F.Mask" (type "Top Solder Mask") (thickness ${n(MASK_MM)}))`,
  ];
  let cu = 0;
  let diel = 0;
  for (const item of build) {
    if (item.kind === "copper") {
      out.push(`(layer ${q(names[cu]!)} (type "copper") (thickness ${n(item.mm)}))`);
      cu++;
    } else {
      diel++;
      const loss = item.lossTangent !== undefined ? ` (loss_tangent ${n(item.lossTangent)})` : "";
      out.push(
        `(layer "dielectric ${diel}" (type ${q(item.kind)}) (thickness ${n(item.mm)}) (material ${q(item.material)}) (epsilon_r ${n(item.er)})${loss})`,
      );
    }
  }
  out.push(
    `(layer "B.Mask" (type "Bottom Solder Mask") (thickness ${n(MASK_MM)}))`,
    '(layer "B.Paste" (type "Bottom Solder Paste"))',
    '(layer "B.SilkS" (type "Bottom Silk Screen"))',
    '(copper_finish "None")',
    "(dielectric_constraints no)",
  );
  return `(stackup ${out.join(" ")})`;
}

function kicadPcb(profile: FabProfile, choices: KicadProjectChoices, rules: ResolvedFabRules): string {
  const stackup = choices.stackup ? profile.stackups.find((s) => s.id === choices.stackup) : undefined;
  const build = stackup?.build ?? genericBuild(choices);
  const copperCount = build.filter((b) => b.kind === "copper").length;
  if (copperCount !== choices.layers) throw new Error(`stackup ${stackup?.id} has ${copperCount} copper layers, not ${choices.layers}`);
  const thickness = build.reduce((sum, b) => sum + b.mm, 2 * MASK_MM);
  const copper = copperNames(choices.layers).map((name) => `(${copperId(name)} ${q(name)} signal)`);
  const maskWeb = mmv(rules, "maskWeb");
  const text = `(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator "pcbnew") (generator_version ${q(KICAD_GENERATOR_VERSION)})
    (general (thickness ${n(thickness)}) (legacy_teardrops no))
    (paper "A4")
    (layers ${copper.join(" ")} ${TECH_LAYERS.join(" ")})
    (setup ${stackupSexpr(build, choices.layers)}
      (pad_to_mask_clearance 0)${maskWeb !== undefined ? ` (solder_mask_min_width ${n(maskWeb)})` : ""}
      (allow_soldermask_bridges_in_footprints no)
      (tenting front back))
    (net 0 ""))`;
  return formatKicadText(text, "normal");
}

// --- .kicad_sch ------------------------------------------------------------

function kicadSch(profile: FabProfile, choices: KicadProjectChoices, opts: GenerateKicadProjectOptions, uuid: string): string {
  const comment =
    profile.kind === "fab"
      ? ` (comment 1 ${q(`${profile.name} ${profile.tiers[choices.tier]?.label ?? choices.tier} rules, ${choices.layers} layers`)})`
      : "";
  const company = opts.company ? ` (company ${q(opts.company)})` : "";
  const text = `(kicad_sch (version ${KICAD_SCH_VERSION}) (generator "eeschema") (generator_version ${q(KICAD_GENERATOR_VERSION)})
    (uuid ${q(uuid)})
    (paper "A4")
    (title_block (title ${q(opts.name)}) (date ${q(opts.date)}) (rev "A")${company}${comment})
    (lib_symbols)
    (sheet_instances (path "/" (page "1"))))`;
  return formatKicadText(text, "normal");
}

// --- .kicad_dru ------------------------------------------------------------

/**
 * Custom rules for what board setup can't say, plus the fab-named copies of
 * the hole and edge minimums so a DRC error names the fab. Track width and
 * clearance stay in board setup only: an unconditional custom clearance rule
 * would override the net classes.
 */
function kicadDru(profile: FabProfile, rules: ResolvedFabRules): string | null {
  if (profile.kind !== "fab") return null;
  const lines: string[] = ["(version 1)"];
  const rule = (label: string, constraint: string, condition?: string) => {
    const name = `${profile.name}: ${label}`;
    lines.push(`(rule ${q(name)}`, `\t(constraint ${constraint})${condition ? "" : ")"}`);
    if (condition) lines.push(`\t(condition ${q(condition)}))`);
  };
  const v = (k: keyof ResolvedFabRules) => rules[k]?.mm;
  const mm = (x: number) => `${n(x)}mm`;
  if (v("holeMin") !== undefined) rule("smallest hole", `hole_size (min ${mm(v("holeMin")!)})`);
  if (v("viaDiameter") !== undefined) rule("via diameter", `via_diameter (min ${mm(v("viaDiameter")!)})`, "A.Type == 'Via'");
  if (v("viaAnnular") !== undefined) rule("via annular ring", `annular_width (min ${mm(v("viaAnnular")!)})`, "A.Type == 'Via'");
  if (v("pthAnnular") !== undefined) {
    rule("plated hole annular ring", `annular_width (min ${mm(v("pthAnnular")!)})`, "A.Type == 'Pad' && A.Pad_Type == 'Through-hole'");
  }
  if (v("holeToHole") !== undefined) rule("hole to hole", `hole_to_hole (min ${mm(v("holeToHole")!)})`);
  if (v("padHoleToHole") !== undefined) {
    rule("pad hole to pad hole", `hole_to_hole (min ${mm(v("padHoleToHole")!)})`, "A.Type == 'Pad' && B.Type == 'Pad'");
  }
  if (v("pthToTrack") !== undefined) {
    rule("plated hole to track", `hole_clearance (min ${mm(v("pthToTrack")!)})`, "A.Type == 'Pad' && A.Pad_Type == 'Through-hole' && B.Type == 'Track'");
  }
  if (v("copperEdge") !== undefined) rule("copper to board edge", `edge_clearance (min ${mm(v("copperEdge")!)})`);
  if (v("silkTextHeight") !== undefined) {
    rule("silkscreen text height", `text_height (min ${mm(v("silkTextHeight")!)})`, "A.Layer == 'F.SilkS' || A.Layer == 'B.SilkS'");
  }
  if (v("silkWidth") !== undefined) {
    rule("silkscreen text thickness", `text_thickness (min ${mm(v("silkWidth")!)})`, "A.Layer == 'F.SilkS' || A.Layer == 'B.SilkS'");
  }
  return `${lines.join("\n")}\n`;
}

// --- entry point -----------------------------------------------------------

/** Generate every file of a new KiCad project. Throws on unusable input. */
export function generateKicadProject(profile: FabProfile, choices: KicadProjectChoices, opts: GenerateKicadProjectOptions): GeneratedFile[] {
  const badName = validateKicadProjectName(opts.name);
  if (badName) throw new Error(badName);
  const badDir = validateKicadProjectDir(opts.dir);
  if (badDir) throw new Error(badDir);
  assertChoicesFit(profile, choices);
  if (!choices.stackup && choices.layers > 2) {
    // Explicit null = generic build; undefined = the fab's first matching stackup.
    if (choices.stackup === undefined) choices = { ...choices, stackup: matchingStackups(profile, choices)[0]?.id ?? null };
  }
  const rules = resolveFabRules(profile, choices);
  const paths = kicadProjectPaths(opts.name, opts.dir);
  const seed = opts.seed ?? `${opts.dir}/${opts.name}|${profile.id}|${opts.date}`;
  const files: GeneratedFile[] = [
    { path: paths.pro, text: kicadPro(profile, choices, rules, `${opts.name}.kicad_pro`) },
    { path: paths.sch, text: kicadSch(profile, choices, opts, seededUuid(`${seed}|sch`)) },
    { path: paths.pcb, text: kicadPcb(profile, choices, rules) },
  ];
  const dru = kicadDru(profile, rules);
  if (dru) files.push({ path: paths.dru, text: dru });
  if (opts.gitignore) files.push({ path: ".gitignore", text: KICAD_GITIGNORE });
  return files;
}
