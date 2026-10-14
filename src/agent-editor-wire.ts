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
 *   exec     chat → panel   carry out an edit, a placement or a read
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

export const agentEditorExecSchema = z.discriminatedUnion("op", [
  z.object({ type: z.literal("pcbjam.editor.exec"), id, file: path, op: z.literal("apply"), edit: agentEditSchema }),
  z.object({ type: z.literal("pcbjam.editor.exec"), id, file: path, op: z.literal("place"), blob: z.object({ sexpr: z.string() }) }),
  z.object({ type: z.literal("pcbjam.editor.exec"), id, file: path, op: z.literal("read") }),
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

export const agentEditorResultSchema = z.object({
  type: z.literal("pcbjam.editor.result"),
  id,
  result: z.union([agentApplyResultSchema, agentPlaceResultSchema, agentReadResultSchema]),
});

export type AgentEdit = z.infer<typeof agentEditSchema>;
export type AgentEditorAttach = z.infer<typeof agentEditorAttachSchema>;
export type AgentEditorExec = z.infer<typeof agentEditorExecSchema>;
export type AgentEditorCancel = z.infer<typeof agentEditorCancelSchema>;
export type AgentEditorResult = z.infer<typeof agentEditorResultSchema>;
export type AgentApplyResult = z.infer<typeof agentApplyResultSchema>;
export type AgentPlaceResult = z.infer<typeof agentPlaceResultSchema>;
export type AgentReadResult = z.infer<typeof agentReadResultSchema>;

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
