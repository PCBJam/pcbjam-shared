import { describe, expect, it } from "vitest";
import { parseSexpr } from "../src/sexpr.js";
import type { Form } from "../src/symbol-lib.js";
import {
  fmt,
  freeSpot,
  fromSheet,
  libPins,
  offsetBox,
  outwardAngle,
  pinPositions,
  snap,
  symbolBox,
  toSheet,
  type Box,
  type Mirror,
} from "../src/schematic-geometry.js";

const F = "(effects (font (size 1.27 1.27)))";

/** An asymmetric 3-pin symbol (ours, written for these tests): every rotation and mirror looks different. */
const Q: Form = parseSexpr(`(symbol "Q" (pin_names (offset 0))
  (property "Reference" "Q" (at 0 0 0) ${F})
  (symbol "Q_0_1" (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "Q_1_1"
    (pin passive line (at -5.08 0 0) (length 2.54) (name "A" ${F}) (number "1" ${F}))
    (pin passive line (at 2.54 5.08 270) (length 2.54) (name "B" ${F}) (number "2" ${F}))
    (pin passive line (at 5.08 -2.54 180) (length 2.54) (name "C" ${F}) (number "3" ${F}))))`)[0] as Form;

describe("toSheet / fromSheet", () => {
  it("are inverses for every angle and mirror", () => {
    for (const angle of [0, 90, 180, 270]) {
      for (const mirror of ["", "x", "y"] as Mirror[]) {
        const [dx, dy] = toSheet(2.54, -5.08, angle, mirror);
        expect(fromSheet(dx, dy, angle, mirror)).toEqual([2.54, -5.08]);
      }
    }
  });

  it("flips library y (up) to sheet y (down)", () => {
    expect(toSheet(0, 3.81, 0)).toEqual([0, -3.81]);
  });
});

describe("pinPositions", () => {
  // Pin end offsets from the anchor, sheet space, for Q at each angle and
  // mirror. The transform behind them was checked against KiCad: labels put
  // at these points joined their pins in `kicad_tools --netlist`, 36/36
  // (2026-10-14).
  const EXPECTED: Record<string, [number, number][]> = {
    "0": [[-5.08, 0], [2.54, -5.08], [5.08, 2.54]],
    "0x": [[-5.08, 0], [2.54, 5.08], [5.08, -2.54]],
    "0y": [[5.08, 0], [-2.54, -5.08], [-5.08, 2.54]],
    "90": [[0, 5.08], [-5.08, -2.54], [2.54, -5.08]],
    "90x": [[0, -5.08], [-5.08, 2.54], [2.54, 5.08]],
    "90y": [[0, 5.08], [5.08, -2.54], [-2.54, -5.08]],
    "180": [[5.08, 0], [-2.54, 5.08], [-5.08, -2.54]],
    "180x": [[5.08, 0], [-2.54, -5.08], [-5.08, 2.54]],
    "180y": [[-5.08, 0], [2.54, 5.08], [5.08, -2.54]],
    "270": [[0, -5.08], [5.08, 2.54], [-2.54, 5.08]],
    "270x": [[0, 5.08], [5.08, -2.54], [-2.54, -5.08]],
    "270y": [[0, -5.08], [-5.08, 2.54], [2.54, 5.08]],
  };

  for (const [name, offsets] of Object.entries(EXPECTED)) {
    it(`angle ${name}`, () => {
      const angle = Number(name.replace(/[xy]$/, ""));
      const mirror = (name.match(/[xy]$/)?.[0] ?? "") as Mirror;
      const pins = pinPositions(Q, [50.8, 50.8], angle, mirror);
      expect(pins.map((p) => p.number)).toEqual(["1", "2", "3"]);
      expect(pins.map((p) => [Number(fmt(p.at[0] - 50.8)), Number(fmt(p.at[1] - 50.8))])).toEqual(offsets);
    });
  }

  it("points each pin from its end toward the body", () => {
    const [a, b, c] = pinPositions(Q, [0, 0]);
    expect(a!.toward).toEqual([1, 0]); // left pin, body to the right
    expect(b!.toward).toEqual([0, 1]); // top pin, body below (sheet y down)
    expect(c!.toward).toEqual([-1, 0]);
    expect(pinPositions(Q, [0, 0], 90)[0]!.toward).toEqual([0, -1]);
  });

  it("reads names, numbers and the common unit", () => {
    expect(libPins(Q).map((p) => [p.number, p.name, p.type])).toEqual([
      ["1", "A", "passive"],
      ["2", "B", "passive"],
      ["3", "C", "passive"],
    ]);
  });
});

describe("outwardAngle", () => {
  it("points labels away from the body", () => {
    expect(outwardAngle([1, 0])).toBe(180);
    expect(outwardAngle([-1, 0])).toBe(0);
    expect(outwardAngle([0, 1])).toBe(90);
    expect(outwardAngle([0, -1])).toBe(270);
  });
});

describe("symbolBox", () => {
  it("covers the body and the pins, and turns with the symbol", () => {
    expect(symbolBox(Q)).toEqual({ minX: -5.08, minY: -5.08, maxX: 5.08, maxY: 2.54 });
    expect(symbolBox(Q, 90)).toEqual({ minX: -5.08, minY: -5.08, maxX: 2.54, maxY: 5.08 });
  });
});

describe("snap and fmt", () => {
  it("snap to the 1.27 mm grid without float noise or -0", () => {
    expect(snap(3.8)).toBe(3.81);
    expect(snap(-0.1)).toBe(0);
    expect(fmt(-0)).toBe("0");
    expect(fmt(50.8 + 2.54)).toBe("53.34");
  });
});

describe("freeSpot", () => {
  const box: Box = { minX: -2.54, minY: -5.08, maxX: 2.54, maxY: 5.08 };
  const overlaps = (a: Box, b: Box) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

  it("starts right of all content", () => {
    const occupied: Box[] = [
      { minX: 10, minY: 10, maxX: 30, maxY: 20 },
      { minX: 40, minY: 30, maxX: 60, maxY: 40 },
    ];
    const [x, y] = freeSpot(occupied, box);
    expect(x + box.minX).toBeGreaterThan(60);
    expect(occupied.some((o) => overlaps(offsetBox(box, [x, y]), o))).toBe(false);
    expect(x).toBe(snap(x));
    expect(y).toBe(snap(y));
  });

  it("finds the nearest gap next to a part on a crowded sheet", () => {
    const occupied: Box[] = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) occupied.push({ minX: i * 12, minY: j * 12, maxX: i * 12 + 8, maxY: j * 12 + 8 });
    const near: [number, number] = [28, 28];
    const [x, y] = freeSpot(occupied, box, { near });
    const placed = offsetBox(box, [x, y]);
    expect(occupied.some((o) => overlaps(placed, o))).toBe(false);
    expect(Math.hypot(x - near[0], y - near[1])).toBeLessThan(40);
  });

  it("uses a default spot on an empty sheet", () => {
    expect(freeSpot([], box)).toEqual([snap(50.8 + 2.54), 50.8]);
  });
});
