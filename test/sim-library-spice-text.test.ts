import { describe, expect, it } from "vitest";
import { CODE_MODEL_LINE_MAX, codeModelLines, findSource, hasElement, subcircuits, withExternalSources } from "../src/sim-library/index.js";
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
