import { describe, expect, it } from "vitest";
import { CODE_MODEL_LINE_MAX, chipFile, chipModel, codeModelLines, findSource, hasElement, subcircuits, withExternalSources } from "../src/sim-library/index.js";
import { BUTTON_MODEL, LED_MODEL, POT_MODEL } from "./sim-library-fixtures.js";

describe("reading a model file", () => {
  it("finds a subcircuit with its pins and parameters", () => {
    const { subs, outside } = subcircuits("* a comment\n" + POT_MODEL);
    expect(outside).toEqual([]);
    expect(subs.get("t_pot")).toMatchObject({ name: "T_POT", pins: ["1", "2", "3"], params: ["RTOT"] });
  });
  it("reads a .subckt line that goes on over several lines", () => {
    const { subs } = subcircuits(".subckt BIG a b\n+ c d\n+ params: GAIN=2 OFFSET=0\nR1 a b 1k\n.ends\n");
    expect(subs.get("big")).toMatchObject({ pins: ["a", "b", "c", "d"], params: ["GAIN", "OFFSET"] });
  });
  it("reports what stands outside a subcircuit", () => {
    expect(subcircuits(LED_MODEL + ".model LOOSE D(IS=1e-14)\n").outside).toEqual([".model LOOSE D(IS=1e-14)"]);
  });
  it("finds an input source and its starting value", () => {
    const sub = subcircuits(POT_MODEL).subs.get("t_pot");
    expect(sub && findSource(sub, "Vpos")).toEqual({ name: "Vpos", plus: "pos", minus: "0", dc: 0.5 });
    expect(sub && findSource(sub, "Vnone")).toBeNull();
    expect(sub && hasElement(sub, "r2")).toBe(true);
  });
  it("counts the pieces of a code-model line", () => {
    const line = `atap [${Array.from({ length: 30 }, (_, i) => `%vd(n${i},0)`).join(" ")}] tap`;
    expect(codeModelLines(`R1 a b 1k\n${line}\n`)).toEqual([{ name: "atap", pieces: 4 + 30 * 4 }]);
    expect(CODE_MODEL_LINE_MAX).toBeLessThan(254);
  });
});

describe("turning an input into a source the app drives", () => {
  it("changes only the named source of the named subcircuit", () => {
    const text = BUTTON_MODEL + POT_MODEL;
    const live = withExternalSources(text, "T_BUTTON", ["Vctl"]);
    expect(live).toContain("Vctl ctl 0 dc 0 external");
    expect(live).toContain("Vpos pos 0 dc 0.5\n");
  });
  it("refuses when a source is not there", () => {
    expect(() => withExternalSources(BUTTON_MODEL, "T_BUTTON", ["Vctl", "Vnone"])).toThrow("T_BUTTON: not every input source was found (Vctl, Vnone)");
  });
});

describe("the model of one placed chip that runs firmware", () => {
  const MODEL = [
    "* the chip; its code is asked for as simulation=\"demo-mcu\"",
    ".subckt T_MCU 3V3 VSS IO0 ORDER=1",
    "Rsupply 3V3 VSS 150",
    "aemu [i_0] [v_0] emu",
    ".model emu d_cosim(simulation=\"demo-mcu\" delay=1u irreversible={ORDER})",
    ".ends T_MCU",
    "",
  ].join("\n");

  it("has its subcircuit and its code under a name of its own", () => {
    const text = chipModel(MODEL, "T_MCU", "demo-mcu", "_2");
    expect(text.split("\n")).toEqual([
      "* the chip; its code is asked for as simulation=\"demo-mcu\"",
      ".subckt T_MCU_2 3V3 VSS IO0 ORDER=1",
      "Rsupply 3V3 VSS 150",
      "aemu [i_0] [v_0] emu",
      ".model emu d_cosim(simulation=\"demo-mcu_2\" delay=1u irreversible={ORDER})",
      ".ends T_MCU_2",
      "",
    ]);
    const { subs, outside } = subcircuits(text);
    expect([...subs.keys()]).toEqual(["t_mcu_2"]);
    expect(outside).toEqual([]);
  });
  it("takes the subcircuit's name in any case, and an .ends without a name", () => {
    const text = chipModel(MODEL.replace(".ends T_MCU", ".ends"), "t_mcu", "demo-mcu", "_1");
    expect(text).toContain(".subckt T_MCU_1 3V3");
    expect(text).toContain("\n.ends\n");
  });
  it("refuses a file that holds more than the chip's one subcircuit", () => {
    expect(() => chipModel(MODEL + ".model LOOSE D(IS=1e-14)\n", "T_MCU", "demo-mcu", "_1")).toThrow("may hold only its one subcircuit");
    expect(() => chipModel(MODEL + ".subckt HELPER a b\nR1 a b 1k\n.ends\n", "T_MCU", "demo-mcu", "_1")).toThrow("may hold only its one subcircuit");
    expect(() => chipModel(MODEL, "T_OTHER", "demo-mcu", "_1")).toThrow("may hold only its one subcircuit");
  });
  it("refuses a model that does not ask for the part's code, or asks twice", () => {
    expect(() => chipModel(MODEL, "T_MCU", "other-part", "_1")).toThrow('must ask for its code once, as simulation="other-part"');
    const twice = MODEL.replace("aemu [i_0] [v_0] emu", "aemu [i_0] [v_0] emu\n.model emu2 d_cosim(simulation=\"demo-mcu\")");
    expect(() => chipModel(twice, "T_MCU", "demo-mcu", "_1")).toThrow("must ask for its code once");
  });
  it("names each chip's file after the part's", () => {
    expect(chipFile("model.lib", 2)).toBe("model.2.lib");
    expect(chipFile("models/chip.sub", 11)).toBe("models/chip.11.sub");
    expect(chipFile("model", 1)).toBe("model.1");
    expect(chipFile("v1.2/model", 3)).toBe("v1.2/model.3");
  });
});
