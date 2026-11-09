import { describe, expect, it } from "vitest";
import { approvalOrder, pcbUpdateNeedsApproval, sameChanges } from "../src/editor-ops.js";

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
    // the editor names such references, and then every change is asked.
    const swap = action("Change R1 value from x footprint from 'Resistor_SMD:R_0603' to 'Resistor_SMD:R_0805'.");
    expect(pcbUpdateNeedsApproval([swap, action("Add net /SDA.")], ["R1 value from x"])).toEqual([swap.text, "Add net /SDA."]);
    expect(pcbUpdateNeedsApproval([action("Update D1 symbol association from  to /bb4d141c-29d1-427b-9cf5-3ac587c1756f."), action("Update D1 sheetname to '/'.")])).toEqual([]);
  });
});

describe("approving Update PCB", () => {
  const action = (text: string) => ({ severity: "action" as const, text });

  it("asks before a rename: U1 renamed TP1 and then removed must not read as a test point", () => {
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
