import { z } from "zod";

/**
 * What an editor operation run for an agent answers: a schematic edit applied as one
 * KiCad commit, a part placed at the person's click, the shown sheet's parts and nets,
 * and KiCad's Update PCB from Schematic (a dry run, or applied). Also the rules for which
 * Update PCB changes the person must approve first. Shapes only: the editor runs the
 * operations, and whoever asks for them (an agent's tools, a plugin) reads these.
 */

const errorResult = z.object({ error: z.string(), code: z.string() });
const point = z.tuple([z.number(), z.number()]);

/** One outcome per operation. */
export const agentApplyResultSchema = z.union([
  z.object({ status: z.literal("applied"), added: z.array(z.string()), changed: z.array(z.string()), removed: z.array(z.string()) }),
  errorResult,
]);
export const agentPlaceResultSchema = z.union([
  z.object({ status: z.literal("placed"), ref: z.string(), uuid: z.string(), at: point }),
  z.object({ status: z.literal("placed"), note: z.string() }),
  z.object({ status: z.literal("cancelled") }),
  errorResult,
]);
export const agentReadResultSchema = z.union([
  z.object({
    parts: z.array(
      z.object({ ref: z.string(), value: z.string(), libId: z.string(), footprint: z.string(), uuid: z.string(), at: point, angle: z.number(), mirror: z.string() }),
    ),
    nets: z.array(z.object({ net: z.string(), pins: z.array(z.object({ ref: z.string(), pin: z.string(), name: z.string().optional() })) })),
  }),
  errorResult,
]);

/** One line of KiCad's Update PCB report, as its dialog lists it. */
export const pcbUpdateLineSchema = z.object({ severity: z.enum(["error", "warning", "action", "info"]), text: z.string() });
export const agentUpdatePcbResultSchema = z.union([
  /** A dry run: what KiCad would change, and the lines the person must approve first. */
  z.object({ status: z.literal("previewed"), report: z.array(pcbUpdateLineSchema), needsApproval: z.array(z.string()) }),
  /** Applied as one undo step; `approved` lists what the person agreed to (empty when nothing needed it). */
  z.object({ status: z.literal("applied"), report: z.array(pcbUpdateLineSchema), added: z.array(z.string()), approved: z.array(z.string()) }),
  /** The person said no: nothing changed. */
  z.object({ status: z.literal("declined"), needsApproval: z.array(z.string()) }),
  errorResult,
]);

export type AgentApplyResult = z.infer<typeof agentApplyResultSchema>;
export type AgentPlaceResult = z.infer<typeof agentPlaceResultSchema>;
export type AgentReadResult = z.infer<typeof agentReadResultSchema>;
export type PcbUpdateLine = z.infer<typeof pcbUpdateLineSchema>;
export type AgentUpdatePcbResult = z.infer<typeof agentUpdatePcbResultSchema>;

/**
 * The changes an Update PCB would make on its own, without asking: footprints and nets
 * added, new pins connected, a symbol's fields, value or links carried over. Not a
 * reference change: renaming a placed footprint is how a later "Remove unused footprint
 * TP1." hides that TP1 is the MCU, so a rename is asked.
 * KiCad's English report lines (pcbnew/netlist_reader/board_netlist_updater.cpp, dry run),
 * matched WHOLE. The names in them (references, pins, nets) come from the schematic, which
 * the agent edits: a name may not hold a space or a quote here, so it cannot make another
 * line look like one of these. A line with such a name is asked. A reference is the one
 * name a line cannot bound (a reference "R1 value from x" turns a footprint swap into
 * "Change R1 value from x footprint from …"), so the editor hook reports references with a
 * space or a quote (`oddNames`), and then every change is asked.
 */
const NAME = String.raw`[^\s'"]+`;
const QUOTED = String.raw`'[^']*'`;
const SAFE_CHANGES = [
  `Add ${NAME} \\(footprint ${QUOTED}\\)`,
  `Add net ${NAME}`,
  `Connect ${NAME} pin ${NAME} to ${NAME}`,
  `Change ${NAME} value from .* to .*`,
  `Update ${NAME} (fields|unit metadata)`,
  `Update ${NAME} symbol association from (?:${NAME})? to ${NAME}`,
  `Update ${NAME} (sheetname|sheetfile|footprint filters) to ${QUOTED}`,
].map((line) => new RegExp(`^${line}\\.$`));

/** The report's change lines (KiCad's `action` lines), as the editor hook compares them. */
export function pcbUpdateActions(report: PcbUpdateLine[]): string[] {
  return report.filter((line) => line.severity === "action" && line.text.trim()).map((line) => line.text);
}

/**
 * The report's changes the person must approve before they are applied: everything that
 * is not on the safe list. Removing footprints, swapping them, and moving pins, vias or
 * zones to other nets can break what someone laid out; so does a line this list does not
 * know (a newer KiCad, another language, a name with a space): asked, never assumed safe.
 * With `oddNames` (references holding a space or a quote) every change is asked, and so
 * with `null`: an editor build too old to report them.
 */
export function pcbUpdateNeedsApproval(report: PcbUpdateLine[], oddNames: string[] | null = []): string[] {
  const actions = pcbUpdateActions(report);
  return oddNames === null || oddNames.length ? actions : actions.filter((text) => !SAFE_CHANGES.some((safe) => safe.test(text)));
}

/**
 * The same change lines, each the same number of times. Approval is bound to exactly
 * what the person saw: a set check let a second "Remove unused footprint R9." through
 * on one approved line.
 */
export function sameChanges(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((line, i) => line === y[i]);
}

/** What can break a layout, most first: how the approval card orders and counts the changes. */
const RISK_KINDS: ReadonlyArray<{ kind: string; test: RegExp }> = [
  { kind: "footprints removed", test: /^Remove unused footprint\b/ },
  // KiCad's "Change %s footprint from '%s' to '%s'.", anchored: a value line can hold the words too.
  { kind: "footprints swapped", test: /^Change [^\s'"]+ footprint from '/ },
  { kind: "renamed", test: /^Change [^\s'"]+ reference designator to / },
  { kind: "reconnected", test: /^Reconnect\b/ },
  { kind: "disconnected", test: /^Disconnect\b/ },
  { kind: "other removals", test: /^Remove\b/ },
];

/**
 * The changes to approve, riskiest first (KiCad lists removals last), with a count per
 * kind; the card shows every line.
 */
export function approvalOrder(changes: readonly string[]): { lines: string[]; counts: Array<{ kind: string; count: number }> } {
  const rank = (line: string) => {
    const i = RISK_KINDS.findIndex((k) => k.test.test(line));
    return i < 0 ? RISK_KINDS.length : i;
  };
  const ranked = changes.map((line, i) => ({ line, i, r: rank(line) })).sort((a, b) => a.r - b.r || a.i - b.i);
  const counts = [...RISK_KINDS.map((k) => k.kind), "other changes"]
    .map((kind, r) => ({ kind, count: ranked.filter((x) => x.r === r).length }))
    .filter((c) => c.count > 0);
  return { lines: ranked.map((x) => x.line), counts };
}

