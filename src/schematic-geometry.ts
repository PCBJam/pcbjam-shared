/**
 * Schematic geometry for agent edits (ai-chat 0003 step 1), MIT, pure: where a
 * library symbol's pins land on the sheet, how much room a placed symbol
 * takes, and a free grid spot for a new one. Millimetres in sheet coordinates
 * (y down), as the file stores them.
 *
 * The placement transform was checked against KiCad itself (kicad_tools
 * --netlist, 2026-10-14, an asymmetric 3-pin symbol at every angle and mirror):
 * library y points up and the sheet's down; the symbol's angle rotates
 * counter-clockwise on screen; after the rotation, `(mirror x)` flips y and
 * `(mirror y)` flips x, both on screen.
 */
import type { SNode } from "./sexpr.js";
import { isForm, unquote, type Form } from "./symbol-lib.js";

export type Point = readonly [number, number];
export type Mirror = "" | "x" | "y";
export type Angle = 0 | 90 | 180 | 270;
/** An axis-aligned box, absolute or relative to a symbol's anchor. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** KiCad's connection grid (50 mil). */
export const GRID = 1.27;

/** Rounded to the file's precision (0.1 µm), without `-0`. */
export function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}

/**
 * A coordinate as the file may hold it: finite and within a kilometre.
 * `Infinity` (JSON `1e400`) would be written as `(at Infinity 0 0)`, which KiCad
 * cannot load (ai-chat 0006 S18); a library with a pin at 1e300 is refused too.
 */
function finite(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) > 1e6) throw new RangeError(`${v} is not a coordinate on a sheet`);
  return v;
}

/** A number as the file writes it: `2.54`, `-1.27`, `100`. */
export const fmt = (v: number): string => String(round4(finite(v)));

export const snap = (v: number, grid = GRID): number => round4(Math.round(finite(v) / grid) * grid);

export function normalizeAngle(angle: number): Angle {
  // NaN would be written as `(at x y NaN)`, which KiCad cannot load.
  if (!Number.isFinite(angle)) throw new RangeError(`${angle} is not an angle`);
  return ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as Angle;
}

/** A library-space offset (y up) as a sheet offset (y down) for a symbol at `angle` with `mirror`. */
export function toSheet(lx: number, ly: number, angle: number, mirror: Mirror = ""): [number, number] {
  const a = normalizeAngle(angle);
  const c = a === 0 ? 1 : a === 180 ? -1 : 0;
  const s = a === 90 ? 1 : a === 270 ? -1 : 0;
  const y0 = -ly;
  let x = lx * c + y0 * s;
  let y = -lx * s + y0 * c;
  if (mirror === "x") y = -y;
  if (mirror === "y") x = -x;
  return [round4(x), round4(y)];
}

/** The inverse of `toSheet`: a sheet offset back into library space. */
export function fromSheet(dx: number, dy: number, angle: number, mirror: Mirror = ""): [number, number] {
  let x = dx;
  let y = dy;
  if (mirror === "x") y = -y;
  if (mirror === "y") x = -x;
  const a = normalizeAngle(angle);
  const c = a === 0 ? 1 : a === 180 ? -1 : 0;
  const s = a === 90 ? 1 : a === 270 ? -1 : 0;
  // Undo the rotation (its transpose), then the y flip.
  const x0 = x * c - y * s;
  const y0 = x * s + y * c;
  return [round4(x0), round4(-y0)];
}

const num = (node: SNode | undefined, fallback = 0): number => {
  const v = typeof node === "string" ? Number(node) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/** `(at x y a?)` of a form, as numbers. */
export function atOf(form: Form): { x: number; y: number; angle: number } | undefined {
  const at = form.find((n) => isForm(n, "at")) as Form | undefined;
  return at ? { x: num(at[1]), y: num(at[2]), angle: num(at[3]) } : undefined;
}

export interface LibPin {
  number: string;
  name: string;
  /** Electrical type: `passive`, `power_in`, … */
  type: string;
  /** The connection point, library space. */
  at: Point;
  /** Direction from the connection point toward the body, degrees, library space. */
  angle: number;
  length: number;
  /** 0 = common to every unit. */
  unit: number;
}

/** Unit and body style of a sub-symbol `<name>_<unit>_<style>`. */
function unitOf(sub: Form): { unit: number; style: number } | undefined {
  const m = unquote(sub[1])?.match(/_(\d+)_(\d+)$/);
  return m ? { unit: Number(m[1]), style: Number(m[2]) } : undefined;
}

/** The sub-symbols of `def` drawn for `unit` (plus the common unit 0), first body style. */
function unitForms(def: Form, unit: number): Array<{ form: Form; unit: number }> {
  const out: Array<{ form: Form; unit: number }> = [];
  for (const child of def.slice(2)) {
    if (!isForm(child, "symbol")) continue;
    const u = unitOf(child);
    if (!u || u.style > 1) continue;
    if (u.unit === 0 || u.unit === unit) out.push({ form: child, unit: u.unit });
  }
  return out;
}

function pinOf(pin: Form, unit: number): LibPin {
  const at = atOf(pin) ?? { x: 0, y: 0, angle: 0 };
  const sub = (tag: string) => pin.find((n) => isForm(n, tag)) as Form | undefined;
  return {
    number: unquote(sub("number")?.[1]) ?? "",
    name: unquote(sub("name")?.[1]) ?? "",
    type: typeof pin[1] === "string" ? pin[1] : "",
    at: [at.x, at.y],
    angle: at.angle,
    length: num(sub("length")?.[1]),
    unit,
  };
}

/** The pins of a library definition for `unit` (and the common unit 0), first body style. */
export function libPins(def: Form, unit = 1): LibPin[] {
  const out: LibPin[] = [];
  for (const { form, unit: u } of unitForms(def, unit)) {
    for (const child of form.slice(2)) if (isForm(child, "pin")) out.push(pinOf(child, u));
  }
  return out;
}

/** Number of units a definition has (1 for most parts). */
export function unitCount(def: Form): number {
  let max = 1;
  for (const child of def.slice(2)) {
    if (isForm(child, "symbol")) max = Math.max(max, unitOf(child)?.unit ?? 1);
  }
  return max;
}

export interface SheetPin {
  number: string;
  name: string;
  type: string;
  /** The pin end on the sheet: where a wire, label or flag connects. */
  at: [number, number];
  /** Unit direction from the pin end toward the body, sheet space. */
  toward: [number, number];
}

const unitVector = (deg: number): [number, number] => {
  const a = normalizeAngle(deg);
  return a === 0 ? [1, 0] : a === 90 ? [0, 1] : a === 180 ? [-1, 0] : [0, -1];
};

/** Where `def`'s pins end on the sheet for a symbol at `at`, `angle`, `mirror`. */
export function pinPositions(def: Form, at: Point, angle = 0, mirror: Mirror = "", unit = 1): SheetPin[] {
  return libPins(def, unit).map((p) => {
    const [dx, dy] = toSheet(p.at[0], p.at[1], angle, mirror);
    const [tx, ty] = unitVector(p.angle);
    return {
      number: p.number,
      name: p.name,
      type: p.type,
      at: [round4(at[0] + dx), round4(at[1] + dy)],
      toward: toSheet(tx, ty, angle, mirror),
    };
  });
}

/** The angle of a label or flag that points away from the body, given the pin's `toward`. */
export function outwardAngle(toward: Point): Angle {
  const [x, y] = [-toward[0], -toward[1]];
  if (x > 0) return 0;
  if (x < 0) return 180;
  return y < 0 ? 90 : 270;
}

function grow(box: Box, x: number, y: number): void {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
}

/** Library-space points of a drawing form (rectangle, polyline, circle, arc, text, pin). */
function shapePoints(form: Form): Array<[number, number]> {
  const xy = (tag: string): [number, number] | undefined => {
    const f = form.find((n) => isForm(n, tag)) as Form | undefined;
    return f ? [num(f[1]), num(f[2])] : undefined;
  };
  switch (form[0]) {
    case "rectangle":
      return [xy("start"), xy("end")].filter((p): p is [number, number] => !!p);
    case "polyline":
    case "bezier": {
      const pts = form.find((n) => isForm(n, "pts")) as Form | undefined;
      return (pts?.slice(1) ?? []).filter((n) => isForm(n, "xy")).map((n) => [num((n as Form)[1]), num((n as Form)[2])]);
    }
    case "circle": {
      const c = xy("center");
      const r = num((form.find((n) => isForm(n, "radius")) as Form | undefined)?.[1]);
      return c ? [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]] : [];
    }
    case "arc":
      return [xy("start"), xy("mid"), xy("end")].filter((p): p is [number, number] => !!p);
    case "text": {
      const at = atOf(form);
      return at ? [[at.x, at.y]] : [];
    }
    case "pin": {
      const p = pinOf(form, 0);
      const [tx, ty] = unitVector(p.angle);
      // Library space is y up: unitVector's y is in that space too.
      return [[p.at[0], p.at[1]], [p.at[0] + tx * p.length, p.at[1] + ty * p.length]];
    }
    default:
      return [];
  }
}

/** The room a placed symbol takes, relative to its anchor (sheet space). */
export function symbolBox(def: Form, angle = 0, mirror: Mirror = "", unit = 1): Box {
  const box: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (const { form } of unitForms(def, unit)) {
    for (const child of form.slice(2)) {
      if (!Array.isArray(child)) continue;
      for (const [lx, ly] of shapePoints(child as Form)) {
        const [x, y] = toSheet(lx, ly, angle, mirror);
        grow(box, x, y);
      }
    }
  }
  return box;
}

/** Text height and an estimate of its width (KiCad's default 1.27 mm font). */
const textWidth = (text: string): number => (Math.max(1, text.length) + 1) * 1.27 * 0.8;

/** The room a label or text takes on the sheet. */
export function textBox(at: Point, angle: number, text: string): Box {
  const w = textWidth(text);
  const h = 1.27;
  const [x, y] = at;
  switch (normalizeAngle(angle)) {
    case 0:
      return { minX: x, minY: y - h, maxX: x + w, maxY: y };
    case 180:
      return { minX: x - w, minY: y - h, maxX: x, maxY: y };
    case 90:
      return { minX: x - h, minY: y - w, maxX: x, maxY: y };
    default:
      return { minX: x - h, minY: y, maxX: x, maxY: y + w };
  }
}

export const offsetBox = (box: Box, at: Point): Box => ({
  minX: box.minX + at[0],
  minY: box.minY + at[1],
  maxX: box.maxX + at[0],
  maxY: box.maxY + at[1],
});

const overlaps = (a: Box, b: Box): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

export interface FreeSpotOptions {
  /** Search outward from here (e.g. next to a part); otherwise right of all content. */
  near?: Point;
  /** The row to use right of the content (e.g. the middle of the parts); default the content's middle. */
  rowY?: number;
  /** Clearance kept around every box. Default 2.54 mm. */
  margin?: number;
}

/**
 * A grid-snapped anchor where `box` (relative to the anchor) overlaps none of
 * `occupied`: nearest to `near` when given, else right of all the content.
 */
export function freeSpot(occupied: readonly Box[], box: Box, opts: FreeSpotOptions = {}): [number, number] {
  const margin = opts.margin ?? 2.54;
  const fits = (ax: number, ay: number): boolean => {
    const b = { minX: ax + box.minX - margin, minY: ay + box.minY - margin, maxX: ax + box.maxX + margin, maxY: ay + box.maxY + margin };
    return !occupied.some((o) => overlaps(b, o));
  };
  let start: [number, number];
  if (opts.near) {
    start = [snap(opts.near[0]), snap(opts.near[1])];
  } else if (occupied.length === 0) {
    start = [snap(50.8 - box.minX), snap(opts.rowY ?? 50.8)];
  } else {
    const maxX = Math.max(...occupied.map((o) => o.maxX));
    const minY = Math.min(...occupied.map((o) => o.minY));
    const maxY = Math.max(...occupied.map((o) => o.maxY));
    start = [snap(maxX + 2 * margin - box.minX), snap(opts.rowY ?? (minY + maxY) / 2)];
  }
  const step = 2 * GRID;
  for (let ring = 0; ring <= 80; ring++) {
    const candidates: Array<[number, number]> = [];
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        candidates.push([snap(start[0] + i * step), snap(start[1] + j * step)]);
      }
    }
    candidates.sort((a, b) => Math.hypot(a[0] - start[0], a[1] - start[1]) - Math.hypot(b[0] - start[0], b[1] - start[1]) || a[0] - b[0] || a[1] - b[1]);
    for (const [x, y] of candidates) if (fits(x, y)) return [x, y];
  }
  return start;
}
