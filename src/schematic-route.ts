/**
 * Wires for the agent's schematic tools (ai-chat 0008 §2.1): a search on the
 * 1.27 mm grid for a wire that makes no connection nobody asked for. A wire
 * joins whatever lies on its ends and bends (another pin, a label, a wire's
 * end), whatever it runs along (an overlapping wire), and a wire whose middle
 * it bends on; it does not join a wire it crosses. So the route never passes,
 * bends or ends on such a point, never runs along a wire, never bends on one,
 * and goes around parts.
 */

import { GRID, round4, type Box, type Point } from "./schematic-geometry.js";

export const pointKey = (p: Point): string => `${Math.round(p[0] * 10000)},${Math.round(p[1] * 10000)}`;
export const samePoint = (a: Point, b: Point): boolean => pointKey(a) === pointKey(b);

/** Whether `p` lies on segment a-b, ends excluded. */
export function onSegmentInterior(p: Point, a: Point, b: Point): boolean {
  if (samePoint(p, a) || samePoint(p, b)) return false;
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-6) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) - 1e-6 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-6 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-6 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-6
  );
}

/** Whether segment a-z goes through `box` (touching its edge, as a pin end on its part's outline does, is not). */
export function hitsBox(a: Point, z: Point, box: Box): boolean {
  const eps = 0.05;
  const [minX, maxX] = [Math.min(a[0], z[0]), Math.max(a[0], z[0])];
  const [minY, maxY] = [Math.min(a[1], z[1]), Math.max(a[1], z[1])];
  return minX < box.maxX - eps && maxX > box.minX + eps && minY < box.maxY - eps && maxY > box.minY + eps;
}

/** Whether p-q runs along w for some length (collinear and overlapping): KiCad joins the two. */
function runsAlong(p: Point, q: Point, w: { a: Point; b: Point }): boolean {
  const cross = (o: Point) => (w.b[0] - w.a[0]) * (o[1] - w.a[1]) - (w.b[1] - w.a[1]) * (o[0] - w.a[0]);
  if (Math.abs(cross(p)) > 1e-6 || Math.abs(cross(q)) > 1e-6) return false;
  const horizontal = Math.abs(w.b[0] - w.a[0]) >= Math.abs(w.b[1] - w.a[1]);
  const i = horizontal ? 0 : 1;
  const lo = Math.max(Math.min(p[i], q[i]), Math.min(w.a[i], w.b[i]));
  const hi = Math.min(Math.max(p[i], q[i]), Math.max(w.a[i], w.b[i]));
  return hi - lo > 1e-6;
}

export interface RouteObstacles {
  /** Points a wire may not pass, bend or end on: other pins' ends, label anchors, flags, junctions, other wires' ends. */
  points: readonly Point[];
  /** Wires: a new one may not run along them nor bend on their middle. Crossing one is allowed, at a cost. */
  wires: ReadonlyArray<{ a: Point; b: Point }>;
  /** Part bodies (their pins included): a wire does not go through one. */
  bodies: readonly Box[];
  /** Label text: going through it costs a little. */
  soft?: readonly Box[];
}

export interface RouteEnd {
  at: Point;
  /** Unit direction away from its part, for a pin: the wire leaves (or arrives) that way when it can. */
  leave?: Point;
}

export interface RouteOptions {
  /** Go through part bodies when there is no other way, at a high cost (re-routing a moved part's wires). */
  throughBodies?: boolean;
}

/**
 * What is wrong with a wire along `points` (null: nothing). The obstacles must
 * leave out the wire's own two ends.
 */
export function pathProblem(points: readonly Point[], obs: RouteObstacles, opts: RouteOptions = {}): string | null {
  for (let i = 1; i < points.length; i++) {
    const [p, q] = [points[i - 1]!, points[i]!];
    const hit = obs.points.find((o) => samePoint(o, p) || samePoint(o, q) || onSegmentInterior(o, p, q));
    if (hit) return `touches (${round4(hit[0])}, ${round4(hit[1])})`;
    if (obs.wires.some((w) => runsAlong(p, q, w))) return "runs along another wire";
    if (i < points.length - 1 && obs.wires.some((w) => onSegmentInterior(q, w.a, w.b))) return "bends on another wire";
    if (!opts.throughBodies && obs.bodies.some((box) => hitsBox(p, q, box))) return "crosses a part";
  }
  return null;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const STEP = 1;
const BEND = 4;
const CROSS = 6;
const SOFT = 1;
const THROUGH_BODY = 40;
const NOT_OUTWARD = 3;

/** A binary min-heap of state ids by cost. */
class Heap {
  private ids: number[] = [];
  private costs: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, cost: number): void {
    const { ids, costs } = this;
    let i = ids.length;
    ids.push(id);
    costs.push(cost);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (costs[up]! <= cost) break;
      ids[i] = ids[up]!;
      costs[i] = costs[up]!;
      i = up;
    }
    ids[i] = id;
    costs[i] = cost;
  }
  pop(): number {
    const { ids, costs } = this;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastCost = costs.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= ids.length) break;
        const r = l + 1;
        const c = r < ids.length && costs[r]! < costs[l]! ? r : l;
        if (costs[c]! >= lastCost) break;
        ids[i] = ids[c]!;
        costs[i] = costs[c]!;
        i = c;
      }
      ids[i] = lastId;
      costs[i] = lastCost;
    }
    return top;
  }
}

/** Straight, or one of the two L shapes, the first that is clean: for ends off the grid. */
function simpleRoute(a: RouteEnd, z: RouteEnd, obs: RouteObstacles, opts: RouteOptions): Point[] | null {
  const aligned = Math.abs(a.at[0] - z.at[0]) < 1e-6 || Math.abs(a.at[1] - z.at[1]) < 1e-6;
  const tries: Point[][] = aligned
    ? [[a.at, z.at]]
    : [
        [a.at, [z.at[0], a.at[1]], z.at],
        [a.at, [a.at[0], z.at[1]], z.at],
      ];
  return tries.find((t) => !pathProblem(t, obs, opts)) ?? null;
}

/**
 * The cheapest clean wire from `a` to `z` (its points, bends included), or null
 * when there is none near them. Cost: length, bends, crossing other wires and
 * label text; leaving a pin sideways rather than outward. The obstacles must
 * leave out `a` and `z` themselves.
 */
export function routeWire(a: RouteEnd, z: RouteEnd, obs: RouteObstacles, opts: RouteOptions = {}): Point[] | null {
  if (samePoint(a.at, z.at)) return [a.at];
  const onGrid = (v: number) => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-6;
  if (![a.at, z.at].every((p) => onGrid(p[0]) && onGrid(p[1]))) return simpleRoute(a, z, obs, opts);
  for (const margin of [20, 60]) {
    const found = search(a, z, obs, opts, margin);
    if (found) return found;
  }
  return null;
}

function search(a: RouteEnd, z: RouteEnd, obs: RouteObstacles, opts: RouteOptions, margin: number): Point[] | null {
  const cell = (v: number) => Math.round(v / GRID);
  const [ax, ay, zx, zy] = [cell(a.at[0]), cell(a.at[1]), cell(z.at[0]), cell(z.at[1])];
  const x0 = Math.min(ax, zx) - margin;
  const y0 = Math.min(ay, zy) - margin;
  const W = Math.max(ax, zx) + margin - x0 + 1;
  const H = Math.max(ay, zy) + margin - y0 + 1;
  const ix = (i: number, j: number) => (i - x0) * H + (j - y0);
  const inside = (i: number, j: number) => i >= x0 && i < x0 + W && j >= y0 && j < y0 + H;
  const at = (i: number, j: number): Point => [round4(i * GRID), round4(j * GRID)];

  // Points never passed: on the grid as cells, off it checked along each move.
  const blocked = new Uint8Array(W * H);
  const offGrid: Point[] = [];
  for (const p of obs.points) {
    const [i, j] = [cell(p[0]), cell(p[1])];
    if (samePoint(p, at(i, j))) {
      if (inside(i, j)) blocked[ix(i, j)] = 1;
    } else offGrid.push(p);
  }
  // Cells on wires, by direction: a move along one is refused, a bend on one too.
  const hWire = new Uint8Array(W * H);
  const vWire = new Uint8Array(W * H);
  const slanted: Array<{ a: Point; b: Point }> = [];
  for (const w of obs.wires) {
    const horizontal = Math.abs(w.a[1] - w.b[1]) < 1e-6;
    const vertical = Math.abs(w.a[0] - w.b[0]) < 1e-6;
    if (!horizontal && !vertical) {
      slanted.push(w);
      continue;
    }
    const [i1, i2] = [cell(Math.min(w.a[0], w.b[0])), cell(Math.max(w.a[0], w.b[0]))];
    const [j1, j2] = [cell(Math.min(w.a[1], w.b[1])), cell(Math.max(w.a[1], w.b[1]))];
    for (let i = i1; i <= i2; i++) {
      for (let j = j1; j <= j2; j++) {
        if (!inside(i, j) || !samePoint(at(i, j), [horizontal ? i * GRID : w.a[0], horizontal ? w.a[1] : j * GRID])) continue;
        (horizontal ? hWire : vWire)[ix(i, j)] = 1;
      }
    }
  }
  // Part bodies: the cells inside them; a body thinner than two cells is checked along each move.
  const body = new Uint8Array(W * H);
  const thin: Box[] = [];
  const eps = 0.05;
  for (const box of obs.bodies) {
    const [i1, i2] = [Math.ceil((box.minX + eps) / GRID), Math.floor((box.maxX - eps) / GRID)];
    const [j1, j2] = [Math.ceil((box.minY + eps) / GRID), Math.floor((box.maxY - eps) / GRID)];
    if (i2 - i1 < 1 || j2 - j1 < 1) thin.push(box);
    for (let i = Math.max(i1, x0); i <= Math.min(i2, x0 + W - 1); i++) {
      for (let j = Math.max(j1, y0); j <= Math.min(j2, y0 + H - 1); j++) body[ix(i, j)] = 1;
    }
  }
  const soft = new Uint8Array(W * H);
  for (const box of obs.soft ?? []) {
    for (let i = Math.max(Math.ceil(box.minX / GRID), x0); i <= Math.min(Math.floor(box.maxX / GRID), x0 + W - 1); i++) {
      for (let j = Math.max(Math.ceil(box.minY / GRID), y0); j <= Math.min(Math.floor(box.maxY / GRID), y0 + H - 1); j++) soft[ix(i, j)] = 1;
    }
  }

  const leaveDir = a.leave ? DIRS.findIndex((d) => d[0] === a.leave![0] && d[1] === a.leave![1]) : -1;
  const arriveDir = z.leave ? DIRS.findIndex((d) => d[0] === -z.leave![0] && d[1] === -z.leave![1]) : -1;
  // States: cell × the direction it was entered (4 = the start).
  const N = W * H * 5;
  const best = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const heap = new Heap();
  const start = ix(ax, ay) * 5 + 4;
  best[start] = 0;
  heap.push(start, Math.abs(ax - zx) + Math.abs(ay - zy));
  const goal = ix(zx, zy);
  while (heap.size) {
    const s = heap.pop();
    const c = Math.floor(s / 5);
    const dir = s % 5;
    const [ci, cj] = [Math.floor(c / H) + x0, (c % H) + y0];
    if (c === goal) return points(s);
    const g = best[s]!;
    for (let d = 0; d < 4; d++) {
      if (dir !== 4 && d === (dir + 2) % 4) continue;
      const turning = dir !== 4 && d !== dir;
      // A bend joins whatever wire it sits on.
      if (turning && (hWire[c] || vWire[c])) continue;
      const [ni, nj] = [ci + DIRS[d]![0], cj + DIRS[d]![1]];
      if (!inside(ni, nj)) continue;
      const n = ix(ni, nj);
      const isGoal = n === goal;
      if (blocked[n] && !isGoal) continue;
      const along = d % 2 === 0 ? hWire : vWire;
      if (along[c] && along[n]) continue;
      if (body[n] && !isGoal && !opts.throughBodies) continue;
      const [p, q] = [at(ci, cj), at(ni, nj)];
      if (offGrid.some((o) => onSegmentInterior(o, p, q))) continue;
      if (slanted.some((w) => runsAlong(p, q, w))) continue;
      const thinHit = thin.some((box) => hitsBox(p, q, box));
      if (thinHit && !opts.throughBodies) continue;
      let cost = g + STEP;
      if (turning) cost += BEND;
      if (dir === 4 && leaveDir >= 0 && d !== leaveDir) cost += NOT_OUTWARD;
      if (isGoal && arriveDir >= 0 && d !== arriveDir) cost += NOT_OUTWARD;
      const across = d % 2 === 0 ? vWire : hWire;
      if (across[n] && !isGoal) cost += CROSS;
      if (soft[n]) cost += SOFT;
      if ((body[n] && !isGoal) || thinHit) cost += THROUGH_BODY;
      const t = n * 5 + d;
      if (cost < best[t]!) {
        best[t] = cost;
        from[t] = s;
        heap.push(t, cost + Math.abs(ni - zx) + Math.abs(nj - zy));
      }
    }
  }
  return null;

  function points(end: number): Point[] {
    const cells: Array<[number, number, number]> = [];
    for (let s = end; s >= 0; s = from[s]!) {
      const c = Math.floor(s / 5);
      cells.push([Math.floor(c / H) + x0, (c % H) + y0, s % 5]);
    }
    cells.reverse();
    // Keep the ends and the cells where the direction changes.
    const out: Point[] = [a.at];
    for (let k = 1; k < cells.length - 1; k++) {
      if (cells[k + 1]![2] !== cells[k]![2]) out.push(at(cells[k]![0], cells[k]![1]));
    }
    out.push(z.at);
    return out;
  }
}
