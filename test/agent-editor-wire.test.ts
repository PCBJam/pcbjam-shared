import { describe, expect, it } from "vitest";
import {
  agentEditorFrame,
  parseAgentEditorToChat,
  parseAgentEditorToPanel,
  type AgentEditorAttach,
  type AgentEditorExec,
  type AgentEditorResult,
} from "../src/agent-editor-wire.js";

describe("agent editor wire", () => {
  it("round-trips every frame, type first", () => {
    const attach: AgentEditorAttach = { type: "pcbjam.editor.attach", scope: "s", project: "p", copy: null, file: "a.kicad_sch", tool: "eeschema" };
    expect(agentEditorFrame(attach).startsWith('{"type":"pcbjam.editor.attach"')).toBe(true);
    expect(parseAgentEditorToChat(agentEditorFrame(attach))).toEqual(attach);
    const exec: AgentEditorExec = {
      type: "pcbjam.editor.exec",
      id: "e1",
      file: "a.kicad_sch",
      op: "apply",
      edit: { label: "Place R1", upsert: [{ sexpr: "(symbol)" }], remove: [], libSymbols: { "Device:R": "(symbol \"Device:R\")" } },
    };
    expect(parseAgentEditorToPanel(agentEditorFrame(exec))).toEqual(exec);
    const result: AgentEditorResult = { type: "pcbjam.editor.result", id: "e1", result: { status: "placed", ref: "R2", uuid: "u", at: [1.27, 2.54] } };
    expect(parseAgentEditorToChat(agentEditorFrame(result))).toEqual(result);
    expect(parseAgentEditorToPanel(agentEditorFrame({ type: "pcbjam.editor.cancel", id: "e1" }))).toEqual({ type: "pcbjam.editor.cancel", id: "e1" });
  });

  it("ignores the chat protocol's frames, other directions and malformed ones", () => {
    expect(parseAgentEditorToChat('{"type":"cf_agent_use_chat_request","id":"x"}')).toBeNull();
    expect(parseAgentEditorToChat(agentEditorFrame({ type: "pcbjam.editor.cancel", id: "e1" }))).toBeNull();
    expect(parseAgentEditorToPanel('{"type":"pcbjam.editor.exec","id":"e1","file":"a","op":"delete_everything"}')).toBeNull();
    expect(parseAgentEditorToPanel('{"type":"pcbjam.editor.exec",')).toBeNull();
    expect(parseAgentEditorToChat(new ArrayBuffer(4))).toBeNull();
  });
});
