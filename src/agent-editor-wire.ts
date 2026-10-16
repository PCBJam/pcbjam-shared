import { z } from "zod";

/**
 * The AI chat's editor bridge (ai-chat 0003 step 5): the chat, which runs the
 * agent's tools server-side, asks the person's OPEN editor to carry out an
 * edit with KiCad itself (the agent executor, step 4), so the edit is one undo
 * step there and a placement follows their cursor. JSON text frames on the
 * chat's own WebSocket, beside the chat protocol's:
 *
 *   attach   panel → chat   this tab shows `file` (of this project and copy) in `tool`
 *   detach   panel → chat   it no longer does (or the socket closes)
 *   exec     chat → panel   carry out an edit, a placement, a read or Update PCB
 *   cancel   chat → panel   the turn was stopped: withdraw that exec
 *   result   panel → chat   the executor's outcome for an exec
 *
 * Transport-unaware (as presence-wire.ts): shapes and parsing only.
 */

export const AGENT_EDITOR_PREFIX = "pcbjam.editor.";

const id = z.string().min(1).max(64);
const path = z.string().min(1).max(500);

/** A `SchematicEdit` (schematic-ops): the items to write and remove, and missing definitions. */
export const agentEditSchema = z.object({
  label: z.string().max(300),
  upsert: z.array(z.object({ sexpr: z.string() })).max(2000),
  remove: z.array(z.string()).max(2000),
  libSymbols: z.record(z.string()),
});

export const agentEditorAttachSchema = z.object({
  type: z.literal("pcbjam.editor.attach"),
  scope: z.string().min(1),
  project: z.string().min(1),
  /** The working copy's room segment: null for the project's default copy. */
  copy: z.string().nullable(),
  /** The open file, project-relative. */
  file: path,
  /** The editor: eeschema, pcbnew, … */
  tool: z.string().min(1).max(40),
});

export const agentEditorDetachSchema = z.object({ type: z.literal("pcbjam.editor.detach") });

/**
 * Where an exec is meant to run: the tab refuses it unless it shows exactly
 * this project, working copy (room segment, null = default) and file
 * (ai-chat 0006 A3). Optional on the wire only so an older host's frames
 * still parse; the tab refuses a frame without them.
 */
const execTarget = {
  type: z.literal("pcbjam.editor.exec"),
  id,
  scope: z.string().min(1).max(200).optional(),
  project: z.string().min(1).max(200).optional(),
  copy: z.string().max(100).nullable().optional(),
  file: path,
};

export const agentEditorExecSchema = z.discriminatedUnion("op", [
  z.object({ ...execTarget, op: z.literal("apply"), edit: agentEditSchema }),
  z.object({ ...execTarget, op: z.literal("place"), blob: z.object({ sexpr: z.string() }) }),
  z.object({ ...execTarget, op: z.literal("read") }),
  // KiCad's Update PCB from Schematic on the open board (step 5b): a dry run, or the real one.
  z.object({ ...execTarget, op: z.literal("update_pcb"), dryRun: z.boolean(), deleteUnused: z.boolean() }),
]);

export const agentEditorCancelSchema = z.object({ type: z.literal("pcbjam.editor.cancel"), id });

const errorResult = z.object({ error: z.string(), code: z.string() });
const point = z.tuple([z.number(), z.number()]);

/** The executor's outcomes (pcbjam/web/standalone/src/agent/executor.ts), one per op. */
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

export const agentEditorResultSchema = z.object({
  type: z.literal("pcbjam.editor.result"),
  id,
  result: z.union([agentApplyResultSchema, agentPlaceResultSchema, agentReadResultSchema, agentUpdatePcbResultSchema]),
});

export type AgentEdit = z.infer<typeof agentEditSchema>;
export type AgentEditorAttach = z.infer<typeof agentEditorAttachSchema>;
export type AgentEditorExec = z.infer<typeof agentEditorExecSchema>;
export type AgentEditorCancel = z.infer<typeof agentEditorCancelSchema>;
export type AgentEditorResult = z.infer<typeof agentEditorResultSchema>;
export type AgentApplyResult = z.infer<typeof agentApplyResultSchema>;
export type AgentPlaceResult = z.infer<typeof agentPlaceResultSchema>;
export type AgentReadResult = z.infer<typeof agentReadResultSchema>;
export type PcbUpdateLine = z.infer<typeof pcbUpdateLineSchema>;
export type AgentUpdatePcbResult = z.infer<typeof agentUpdatePcbResultSchema>;

/**
 * The changes an Update PCB would make on its own, without asking: footprints and nets
 * added, new pins connected, a symbol's fields, value or links carried over. Not a
 * reference change: renaming a placed footprint is how a later "Remove unused footprint
 * TP1." hides that TP1 is the MCU (ai-chat 0006 S6), so a rename is asked.
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
 * with `null`: an editor build too old to report them (ai-chat 0006 S9).
 */
export function pcbUpdateNeedsApproval(report: PcbUpdateLine[], oddNames: string[] | null = []): string[] {
  const actions = pcbUpdateActions(report);
  return oddNames === null || oddNames.length ? actions : actions.filter((text) => !SAFE_CHANGES.some((safe) => safe.test(text)));
}

/**
 * The same change lines, each the same number of times. Approval is bound to exactly
 * what the person saw: a set check let a second "Remove unused footprint R9." through
 * on one approved line (ai-chat 0006 S6).
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
 * kind; the card shows every line (ai-chat 0006 S5).
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

const toChat = z.discriminatedUnion("type", [agentEditorAttachSchema, agentEditorDetachSchema, agentEditorResultSchema]);
export type AgentEditorToChat = z.infer<typeof toChat>;

const toPanel = z.union([agentEditorExecSchema, agentEditorCancelSchema]);
export type AgentEditorToPanel = z.infer<typeof toPanel>;

function parseFrame<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (typeof raw !== "string" || !raw.startsWith(`{"type":"${AGENT_EDITOR_PREFIX}`)) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** A frame the chat reads from a panel; null for anything else (chat protocol frames included). */
export const parseAgentEditorToChat = (raw: unknown): AgentEditorToChat | null => parseFrame(toChat, raw);

/** A frame the panel reads from the chat; null for anything else. */
export const parseAgentEditorToPanel = (raw: unknown): AgentEditorToPanel | null => parseFrame(toPanel, raw);

/** A frame as text: `type` first, which is what the parsers look for. */
export function agentEditorFrame(message: AgentEditorToChat | AgentEditorToPanel): string {
  const { type, ...rest } = message;
  return JSON.stringify({ type, ...rest });
}
