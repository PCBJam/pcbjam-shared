// The clock of a chip without a board: read from the crystal on its clock pins, assumed
// when there is none, overruled by a setting; and what a run says about it.
import { describe, expect, it } from "vitest";
import { chipClock, clockSentence, clockSource, crystalOn, frequencyText, isCrystal, readFrequency } from "../src/sim-library/index.js";

const sym = (ref: string, libId: string, value: string, ...nets: string[]) => ({
  ref, libId, value, pins: Object.fromEntries(nets.map((node, i) => [String(i + 1), { name: String(i + 1), node }])),
});

describe("a frequency as it is written", () => {
  it("reads what stands on a crystal", () => {
    expect([
      "16MHz", "16 MHz", "16M", "16.000MHz", "16,000 MHz", "7.3728MHz", "32.768kHz", "32.768k", "8000000", "ABM3-16.000MHZ-B2-T", "8MHz 18pF", "HC49 20MHz", "400kHz", "16000000Hz",
    ].map(readFrequency)).toEqual([16e6, 16e6, 16e6, 16e6, 16e6, 7372800, 32768, 32768, 8e6, 16e6, 8e6, 20e6, 400e3, 16e6]);
  });

  it("reads nothing out of a Value that says no frequency", () => {
    for (const text of ["", "Crystal", "16", "16.000", "Y1", "18pF", "X322516MLB4SI", "100"]) expect([text, readFrequency(text)]).toEqual([text, null]);
  });

  it("writes one the short way", () => {
    expect([16e6, 8e6, 7372800, 32768, 1e6, 400e3, 50].map(frequencyText)).toEqual(["16 MHz", "8 MHz", "7.3728 MHz", "32.768 kHz", "1 MHz", "400 kHz", "50 Hz"]);
  });
});

describe("the crystal on a chip's clock pins", () => {
  it("is a crystal or a resonator by its symbol or by its reference", () => {
    for (const [ref, libId] of [["Y1", "Device:Crystal"], ["Y2", "Device:Crystal_GND24"], ["Y3", "Device:Resonator"], ["X1", "my-parts:HC49"], ["Q7", "Own:XTAL_3225"], ["Y?", "Device:Crystal"]])
      expect([ref, isCrystal({ ref: ref!, libId: libId! })]).toEqual([ref, true]);
    for (const [ref, libId] of [["R1", "Device:R"], ["C3", "Device:C"], ["Q1", "Transistor_BJT:BC547"], ["XA1", "Connector:Conn_01x02"], ["U2", "Oscillator:ACO-xxxMHz"]])
      expect([ref, isCrystal({ ref: ref!, libId: libId! })]).toEqual([ref, false]);
  });

  it("sits with a pin on each of the two nets; its load capacitors and a resistor across do not count", () => {
    const board = [
      sym("U1", "MCU_Microchip_ATmega:ATmega328P-A", "ATmega328P-A", "/X1", "/X2"),
      sym("C1", "Device:C", "22p", "/X1", "GND"), sym("C2", "Device:C", "22p", "/X2", "GND"), sym("R1", "Device:R", "1M", "/X1", "/X2"),
      sym("Y1", "Device:Crystal_GND24", "16MHz", "/X1", "GND", "/X2", "GND"),
    ];
    expect(crystalOn(["/X1", "/X2"], board, "U1")).toEqual({ ref: "Y1", value: "16MHz" });
    expect(crystalOn(["/X1", "/X2"], board.slice(0, 4), "U1")).toBeNull();
    // a crystal on one of the pins only, pins with no wire, the two pins shorted
    expect(crystalOn(["/X1", "/OTHER"], board, "U1")).toBeNull();
    expect(crystalOn(["unconnected-(U1-XTAL1-Pad7)", "unconnected-(U1-XTAL2-Pad8)"], board, "U1")).toBeNull();
    expect(crystalOn([undefined, "/X2"], board, "U1")).toBeNull();
    expect(crystalOn(["/X1", "/X1"], [sym("Y1", "Device:Crystal", "16MHz", "/X1", "/X1")], "U1")).toBeNull();
  });
});

describe("the clock of a placed chip", () => {
  const part = { clock: 8_000_000 };
  const y = (value: string) => ({ ref: "Y1", value });

  it("is the crystal's, else the chip's own oscillator, assumed", () => {
    expect(chipClock(part, "auto", y("16MHz"))).toEqual({ hz: 16e6, from: "crystal", crystal: "Y1" });
    expect(chipClock(part, "auto", null)).toEqual({ hz: 8e6, from: "assumed" });
    expect(chipClock(part, undefined, null)).toEqual({ hz: 8e6, from: "assumed" });
    expect(chipClock({}, "auto", null)).toEqual({ hz: 8e6, from: "assumed" });
  });

  it("stays the chip's own with a crystal that cannot clock it, and says why", () => {
    expect(chipClock(part, "auto", y("Crystal"))).toEqual({ hz: 8e6, from: "assumed", crystal: "Y1", why: "no-value" });
    // a watch crystal on these pins clocks a timer
    expect(chipClock(part, "auto", y("32.768kHz"))).toEqual({ hz: 8e6, from: "assumed", crystal: "Y1", why: "too-slow" });
    expect(chipClock(part, "auto", y("25MHz"))).toEqual({ hz: 8e6, from: "assumed", crystal: "Y1", why: "too-fast" });
  });

  it("is the setting's when one is set, whatever the schematic has", () => {
    expect(chipClock(part, "1MHz", y("16MHz"))).toEqual({ hz: 1e6, from: "setting", crystal: "Y1" });
    expect(chipClock(part, "128kHz", null)).toEqual({ hz: 128e3, from: "setting" });
    // a speed the chip cannot have is not used, and is kept to be said
    expect(chipClock(part, "99MHz", y("16MHz"))).toEqual({ hz: 16e6, from: "crystal", crystal: "Y1", refused: "99MHz" });
    expect(chipClock(part, "50kHz", null)).toEqual({ hz: 8e6, from: "assumed", refused: "50kHz" });
  });
});

describe("what a run says about a chip's clock", () => {
  const FIX = 'A sketch built for another speed runs at the wrong pace: the setting "Clock" on the chip\'s line in the Simulation parts list says the speed.';

  it("says nothing when the schematic or the user says the speed", () => {
    expect(clockSentence("U1", { hz: 16e6, from: "crystal", crystal: "Y1" })).toBeNull();
    expect(clockSentence("U1", { hz: 1e6, from: "setting" })).toBeNull();
  });

  it("says the assumed speed, why it is assumed and where to change it", () => {
    expect(clockSentence("U1", { hz: 8e6, from: "assumed" })).toBe(`U1 runs at 8 MHz: no crystal is on its clock pins, so the chip's own oscillator is assumed. ${FIX}`);
    expect(clockSentence("U1", { hz: 8e6, from: "assumed", crystal: "Y1", why: "no-value" }))
      .toBe(`U1 runs at 8 MHz, the chip's own oscillator: the Value of its crystal Y1 says no frequency (16MHz). ${FIX}`);
    expect(clockSentence("U1", { hz: 8e6, from: "assumed", crystal: "Y1", why: "too-slow" }))
      .toBe(`U1 runs at 8 MHz, the chip's own oscillator: its crystal Y1 is too slow to clock the chip (it can clock a timer). ${FIX}`);
    expect(clockSentence("U1", { hz: 8e6, from: "assumed", crystal: "Y1", why: "too-fast" }))
      .toBe(`U1 runs at 8 MHz, the chip's own oscillator: its crystal Y1 is faster than the chip can run. ${FIX}`);
  });

  it("says a setting that was not used", () => {
    expect(clockSentence("U1", { hz: 16e6, from: "crystal", crystal: "Y1", refused: "99MHz" })).toBe('U1 runs at 16 MHz, from its crystal Y1. Its setting "99MHz" is not a clock this chip takes.');
    expect(clockSentence("U1", { hz: 8e6, from: "assumed", refused: "50kHz" })).toContain('Its setting "50kHz" is not a clock this chip takes.');
  });

  it("has a short form for the chip's line in the parts list", () => {
    expect(clockSource({ hz: 16e6, from: "crystal", crystal: "Y1" })).toBe("16 MHz, from its crystal Y1");
    expect(clockSource({ hz: 1e6, from: "setting" })).toBe("1 MHz, by its setting");
    expect(clockSource({ hz: 8e6, from: "assumed" })).toBe("8 MHz, its own oscillator (assumed)");
  });
});
