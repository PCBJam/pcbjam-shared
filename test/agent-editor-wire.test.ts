import { describe, expect, it } from "vitest";
import {
  agentEditorFrame,
  parseAgentEditorToChat,
  parseAgentEditorToPanel,
  approvalOrder,
  pcbUpdateNeedsApproval,
  sameChanges,
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

  it("carries Update PCB: the exec and each outcome", () => {
    const exec: AgentEditorExec = { type: "pcbjam.editor.exec", id: "u1", file: "b.kicad_pcb", op: "update_pcb", dryRun: true, deleteUnused: false };
    expect(parseAgentEditorToPanel(agentEditorFrame(exec))).toEqual(exec);
    expect(parseAgentEditorToPanel('{"type":"pcbjam.editor.exec","id":"u1","file":"b.kicad_pcb","op":"update_pcb","dryRun":"no","deleteUnused":false}')).toBeNull();
    const report = [{ severity: "action" as const, text: "Add D1 (footprint 'LED_SMD:LED_0603_1608Metric')." }];
    for (const result of [
      { status: "previewed" as const, report, needsApproval: [] },
      { status: "applied" as const, report, added: ["D1"], approved: [] },
      { status: "declined" as const, needsApproval: ["Remove unused footprint R9."] },
      { error: "Open the board", code: "NO_EDITOR" },
    ]) {
      const frame: AgentEditorResult = { type: "pcbjam.editor.result", id: "u1", result };
      expect(parseAgentEditorToChat(agentEditorFrame(frame))).toEqual(frame);
    }
  });
});

describe("pcbUpdateNeedsApproval", () => {
  const action = (text: string) => ({ severity: "action" as const, text });

  it("lets additions, new connections and carried-over fields through", () => {
    expect(
      pcbUpdateNeedsApproval([
        { severity: "info", text: "Processing symbol 'D1:LED_SMD:LED_0603_1608Metric'." },
        action("Add D1 (footprint 'LED_SMD:LED_0603_1608Metric')."),
        action("Add net /LED_A."),
        action("Connect R1 pin 2 to /LED_A."),
        action("Change R1 value from 10k to 330."),
        action("Update R1 fields."),
        action("Update R1 symbol association from /a to /b."),
        { severity: "error", text: "Cannot add C3 (footprint 'Capacitor_SMD:C_0603' not found)." },
        { severity: "info", text: "Total warnings: 0, errors: 1." },
        action(""),
      ]),
    ).toEqual([]);
  });

  it("asks for removals, swapped footprints, moved connections and anything it does not know", () => {
    expect(
      pcbUpdateNeedsApproval([
        action("Remove unused footprint R9."),
        action("Change R1 footprint from 'Resistor_SMD:R_0603' to 'Resistor_SMD:R_0805'."),
        action("Reconnect R1 pin 1 from /SDA to /SCL."),
        action("Disconnect R1 pin 2."),
        action("Reconnect via from /SDA to /SCL."),
        action("Reconnect copper zone 'GND' from GND to GNDA."),
        action("D1 hinzufügen (Footprint 'LED_SMD:LED_0603_1608Metric')."),
      ]),
    ).toHaveLength(7);
  });

  it("never lets a name make a change look safe: names with spaces or quotes are asked", () => {
    const forged = [
      // a fabrication attribute on a footprint referenced "net"
      action("Add net 'exclude from BOM' fabrication attribute."),
      action("Add net to group 'G'."),
      // a reference "R9 pin 1 to GND." ahead of a removal
      action("Connect R9 pin 1 to GND. Remove unused footprint R9."),
      action("Add D1 (footprint 'X')' (footprint 'Y')."),
      action("Update R1 fields. Remove unused footprint R9."),
    ];
    expect(pcbUpdateNeedsApproval(forged)).toHaveLength(forged.length);
    // A reference with a space reads as a safe line ("R1 value from x" before a footprint swap):
    // the editor hook names such references, and then every change is asked.
    const swap = action("Change R1 value from x footprint from 'Resistor_SMD:R_0603' to 'Resistor_SMD:R_0805'.");
    expect(pcbUpdateNeedsApproval([swap, action("Add net /SDA.")], ["R1 value from x"])).toEqual([swap.text, "Add net /SDA."]);
    expect(pcbUpdateNeedsApproval([action("Update D1 symbol association from  to /bb4d141c-29d1-427b-9cf5-3ac587c1756f."), action("Update D1 sheetname to '/'.")])).toEqual([]);
  });
});

describe("approving Update PCB (ai-chat 0006 A7)", () => {
  const action = (text: string) => ({ severity: "action" as const, text });

  it("asks before a rename: U1 renamed TP1 and then removed must not read as a test point (S6)", () => {
    expect(pcbUpdateNeedsApproval([action("Change U1 reference designator to TP1."), action("Add net /SDA.")])).toEqual([
      "Change U1 reference designator to TP1.",
    ]);
    // A value that names footprints does not rank as a swap.
    expect(approvalOrder(["Change R2 value from footprint from to x.", "Disconnect R1 pin 2."]).lines[0]).toBe("Disconnect R1 pin 2.");
  });

  it("asks every change when the editor build does not report odd names", () => {
    expect(pcbUpdateNeedsApproval([action("Add net /SDA."), action("Remove unused footprint U1.")], null)).toEqual([
      "Add net /SDA.",
      "Remove unused footprint U1.",
    ]);
  });

  it("matches exactly: the same lines, each as many times", () => {
    expect(sameChanges(["Remove unused footprint R9.", "Add net X."], ["Add net X.", "Remove unused footprint R9."])).toBe(true);
    expect(sameChanges(["Remove unused footprint R9.", "Remove unused footprint R9."], ["Remove unused footprint R9."])).toBe(false);
    expect(sameChanges(["Remove unused footprint R9."], ["Remove unused footprint R9.", "Remove unused footprint R9."])).toBe(false);
    expect(sameChanges([], [])).toBe(true);
  });

  it("lists what can break a layout first, with counts", () => {
    const { lines, counts } = approvalOrder([
      "Add net /A.",
      "Add net /B.",
      "Disconnect R1 pin 2.",
      "Reconnect via from /SDA to /SCL.",
      "Change R1 footprint from 'R_0603' to 'R_0805'.",
      "Remove unused footprint U1.",
    ]);
    expect(lines).toEqual([
      "Remove unused footprint U1.",
      "Change R1 footprint from 'R_0603' to 'R_0805'.",
      "Reconnect via from /SDA to /SCL.",
      "Disconnect R1 pin 2.",
      "Add net /A.",
      "Add net /B.",
    ]);
    expect(counts).toEqual([
      { kind: "footprints removed", count: 1 },
      { kind: "footprints swapped", count: 1 },
      { kind: "reconnected", count: 1 },
      { kind: "disconnected", count: 1 },
      { kind: "other changes", count: 2 },
    ]);
  });
});
