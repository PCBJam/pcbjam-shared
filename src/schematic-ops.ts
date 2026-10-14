/**
 * Schematic edits for agents (ai-chat 0003 step 1), MIT, pure. An agent names
 * parts ("R5"), pins ("1") and nets ("SDA"); these functions read the sheet
 * (`KicadDoc`), do the geometry, and hand back the items to apply. The model
 * never reads or writes KiCad text.
 *
 * Every edit function returns ONE `SchematicEdit` for the whole request, the
 * shape both the editor's native commit (`kicadPluginEditItems`: one undo
 * step) and the MCP's `apply_edits` take, plus a compact report for the agent.
 * Text from outside (nets, values, fields) only ever becomes a quoted atom
 * (`quote`); items are built as s-expression trees, never by pasting text into
 * templates. Top sheet only for now; hierarchical sheets come later.
 */
import {
  args,
  libSymbolsFromLayout,
  missingRootInsertIndex,
  renderItem,
  scalar,
  sexprToItems,
  slotFromSexpr,
  unquoteAtom,
  type KicadDoc,
  type Slot,
} from "./kicad-doc.js";
import { parseSexpr, printSexpr, type SNode } from "./sexpr.js";
import { buildSymbolClipboard, isForm, quote, unquote, type Form } from "./symbol-lib.js";
import {
  atOf,
  fmt,
  freeSpot,
  fromSheet,
  normalizeAngle,
  offsetBox,
  outwardAngle,
  pinPositions,
  round4,
  snap,
  symbolBox,
  textBox,
  toSheet,
  type Angle,
  type Box,
  type Mirror,
  type Point,
  type SheetPin,
} from "./schematic-geometry.js";

// ── Results ──────────────────────────────────────────────────────────────────

export interface SchematicEdit {
  /** A short description, e.g. for the undo menu. */
  label: string;
  upsert: { sexpr: string }[];
  remove: string[];
  /** Library definitions the sheet lacks, by lib id, each a `(symbol "<lib id>" …)`. */
  libSymbols: Record<string, string>;
}

export type SchematicOpErrorCode = "NOT_FOUND" | "NO_PIN" | "NO_DEFINITION" | "INVALID";

/** A refusal the agent can act on: the message says what to fix. */
export class SchematicOpError extends Error {
  constructor(
    readonly code: SchematicOpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SchematicOpError";
  }
}

export interface PartPin {
  number: string;
  name: string;
  at: [number, number];
}

export interface SheetPart {
  ref: string;
  value: string;
  libId: string;
  footprint: string;
  uuid: string;
  at: [number, number];
  angle: Angle;
  mirror: Mirror;
  unit: number;
  /** A power symbol (`+3V3`, `GND`): it names a net, it is not a part. */
  power: boolean;
  /** Empty when the sheet does not embed the symbol's definition. */
  pins: PartPin[];
}

// ── Reading a sheet ──────────────────────────────────────────────────────────

export interface PlacedSymbol {
  uuid: string;
  form: Form;
  libId: string;
  ref: string;
  value: string;
  footprint: string;
  at: [number, number];
  angle: Angle;
  mirror: Mirror;
  unit: number;
  power: boolean;
  def?: Form;
  pins: SheetPin[];
}

export interface SheetLabel {
  uuid: string;
  kind: "label" | "global_label" | "hierarchical_label";
  name: string;
  at: [number, number];
  angle: number;
}

export interface SheetWire {
  uuid: string;
  a: [number, number];
  b: [number, number];
}

export interface SheetPoint {
  uuid: string;
  at: [number, number];
}

/** What the edit functions need from a sheet, read once. */
export interface Sheet {
  doc: KicadDoc;
  defs: Map<string, Form>;
  symbols: PlacedSymbol[];
  labels: SheetLabel[];
  wires: SheetWire[];
  junctions: SheetPoint[];
  noConnects: SheetPoint[];
  /** Boxes of everything else drawn (sheets, text) for free-space search. */
  other: Box[];
  /** The `(instances (project …) (path …))` new symbols get. */
  instance: { project: string; path: string };
}

const prop = (form: Form, name: string): string | undefined =>
  unquote((form.find((n) => isForm(n, "property") && unquote(n[1]) === name) as Form | undefined)?.[2]);

const child = (form: Form, tag: string): Form | undefined => form.find((n) => isForm(n, tag)) as Form | undefined;

/** `"text"` atoms of a KicadDoc slot list. */
const unquoted = (atom: string | undefined): string | undefined => (atom === undefined ? undefined : unquoteAtom(atom));

const isPowerDef = (def: Form | undefined): boolean => !!def && def.some((n) => isForm(n, "power"));

const mirrorOf = (form: Form): Mirror => {
  const m = child(form, "mirror")?.[1];
  return m === "x" || m === "y" ? m : "";
};

function renderForm(doc: KicadDoc, uuid: string): Form | undefined {
  try {
    const parsed = parseSexpr(renderItem(doc, uuid))[0];
    return Array.isArray(parsed) ? (parsed as Form) : undefined;
  } catch {
    return undefined; // a dangling ref: skip the item, as the renderers do
  }
}

function placedSymbol(uuid: string, form: Form, defs: Map<string, Form>): PlacedSymbol {
  const libId = unquote(child(form, "lib_id")?.[1]) ?? "";
  const at = atOf(form) ?? { x: 0, y: 0, angle: 0 };
  const angle = normalizeAngle(at.angle);
  const mirror = mirrorOf(form);
  const unit = Number(child(form, "unit")?.[1] ?? 1) || 1;
  const def = defs.get(libId);
  const instRef = (() => {
    const inst = child(form, "instances");
    const project = inst?.slice(1).find((n) => isForm(n, "project")) as Form | undefined;
    const path = project?.slice(2).find((n) => isForm(n, "path")) as Form | undefined;
    return unquote((path?.find((n) => isForm(n, "reference")) as Form | undefined)?.[1]);
  })();
  const ref = prop(form, "Reference") ?? instRef ?? "";
  return {
    uuid,
    form,
    libId,
    ref,
    value: prop(form, "Value") ?? "",
    footprint: prop(form, "Footprint") ?? "",
    at: [at.x, at.y],
    angle,
    mirror,
    unit,
    power: isPowerDef(def) || ref.startsWith("#"),
    def,
    pins: def ? pinPositions(def, [at.x, at.y], angle, mirror, unit) : [],
  };
}

/** Read a schematic once for the edit functions. */
export function readSheet(doc: KicadDoc, projectName?: string): Sheet {
  if (doc.root !== "kicad_sch") throw new SchematicOpError("INVALID", `Not a schematic (${doc.root}).`);
  const defs = new Map<string, Form>();
  for (const [libId, text] of Object.entries(libSymbolsFromLayout(doc.layout, doc.items))) {
    const form = parseSexpr(text)[0];
    if (Array.isArray(form)) defs.set(libId, form as Form);
  }
  const sheet: Sheet = {
    doc,
    defs,
    symbols: [],
    labels: [],
    wires: [],
    junctions: [],
    noConnects: [],
    other: [],
    instance: { project: projectName ?? "", path: "" },
  };
  for (const [uuid, item] of Object.entries(doc.items)) {
    if (item.parent !== null) continue;
    switch (item.type) {
      case "symbol": {
        const form = renderForm(doc, uuid);
        if (form && child(form, "lib_id")) sheet.symbols.push(placedSymbol(uuid, form, defs));
        break;
      }
      case "label":
      case "global_label":
      case "hierarchical_label": {
        const form = renderForm(doc, uuid);
        const at = form && atOf(form);
        if (form && at) sheet.labels.push({ uuid, kind: item.type, name: unquote(form[1]) ?? "", at: [at.x, at.y], angle: at.angle });
        break;
      }
      case "wire": {
        const form = renderForm(doc, uuid);
        const pts = (form && child(form, "pts")?.slice(1).filter((n) => isForm(n, "xy"))) as Form[] | undefined;
        if (pts && pts.length >= 2) {
          const p = (f: Form): [number, number] => [Number(f[1]), Number(f[2])];
          sheet.wires.push({ uuid, a: p(pts[0]!), b: p(pts[pts.length - 1]!) });
        }
        break;
      }
      case "junction":
      case "no_connect": {
        const form = renderForm(doc, uuid);
        const at = form && atOf(form);
        if (at) (item.type === "junction" ? sheet.junctions : sheet.noConnects).push({ uuid, at: [at.x, at.y] });
        break;
      }
      case "sheet": {
        const form = renderForm(doc, uuid);
        const at = form && atOf(form);
        const size = form && child(form, "size");
        if (at && size) sheet.other.push({ minX: at.x, minY: at.y, maxX: at.x + Number(size[1]), maxY: at.y + Number(size[2]) });
        break;
      }
      case "text":
      case "text_box": {
        const form = renderForm(doc, uuid);
        const at = form && atOf(form);
        if (form && at) sheet.other.push(textBox([at.x, at.y], at.angle, unquote(form[1]) ?? ""));
        break;
      }
    }
  }
  // New symbols join the project and sheet path the existing ones use.
  for (const s of sheet.symbols) {
    const project = child(s.form, "instances")?.slice(1).find((n) => isForm(n, "project")) as Form | undefined;
    const path = project?.slice(2).find((n) => isForm(n, "path")) as Form | undefined;
    if (project && path) {
      sheet.instance = { project: projectName ?? unquote(project[1]) ?? "", path: unquote(path[1]) ?? "" };
      break;
    }
  }
  if (!sheet.instance.path) {
    const root = unquoted(scalar(doc.layout, "uuid"));
    sheet.instance.path = root ? `/${root}` : "/";
  }
  if (!sheet.instance.project) sheet.instance.project = "project";
  return sheet;
}

/** Placed parts on the sheet, references in natural order. */
export function listParts(doc: KicadDoc, opts: { filter?: string; includePower?: boolean } = {}): SheetPart[] {
  const sheet = readSheet(doc);
  const filter = opts.filter?.trim().toLowerCase();
  return sheet.symbols
    .filter((s) => opts.includePower || !s.power)
    .filter((s) => !filter || [s.ref, s.value, s.libId, s.footprint].some((v) => v.toLowerCase().includes(filter)))
    .map(
      (s): SheetPart => ({
        ref: s.ref,
        value: s.value,
        libId: s.libId,
        footprint: s.footprint,
        uuid: s.uuid,
        at: s.at,
        angle: s.angle,
        mirror: s.mirror,
        unit: s.unit,
        power: s.power,
        pins: s.pins.map((p) => ({ number: p.number, name: p.name, at: p.at })),
      }),
    )
    .sort((a, b) => compareRefs(a.ref, b.ref));
}

/** R2 before R10. */
export function compareRefs(a: string, b: string): number {
  const ma = a.match(/^(.*?)(\d+)$/);
  const mb = b.match(/^(.*?)(\d+)$/);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a.localeCompare(b);
}

// ── Small helpers ────────────────────────────────────────────────────────────

const key = (p: Point): string => `${Math.round(p[0] * 10000)},${Math.round(p[1] * 10000)}`;
const samePoint = (a: Point, b: Point): boolean => key(a) === key(b);

/** Whether `p` lies on segment a-b, ends excluded. */
function onSegmentInterior(p: Point, a: Point, b: Point): boolean {
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

/** Text from outside as a KiCad string: no control characters, trimmed, bounded. */
export function cleanText(text: string, what: string, max = 120, allowEmpty = false): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean && !allowEmpty) throw new SchematicOpError("INVALID", `The ${what} is empty.`);
  if (clean.length > max) throw new SchematicOpError("INVALID", `The ${what} is longer than ${max} characters.`);
  return clean;
}

/** Names KiCad's power library covers: `+3V3`, `-12V`, `GND`, `VCC`, … */
export function isPowerNetName(net: string): boolean {
  return /^[+-]/.test(net) || /^(GND|AGND|DGND|PGND|GNDA|GNDD|GNDPWR|VCC|VDD|VSS|VEE|VBUS|VBAT|VAA|VPP)\w*$/i.test(net);
}

const newUuid = (): string => crypto.randomUUID();
const font = (): SNode => ["font", ["size", "1.27", "1.27"]];

function findSymbol(sheet: Sheet, ref: string): PlacedSymbol {
  const want = ref.trim().toLowerCase();
  const hit = sheet.symbols.find((s) => s.ref.toLowerCase() === want);
  if (!hit) {
    const some = sheet.symbols.filter((s) => !s.power).map((s) => s.ref).sort(compareRefs).slice(0, 30);
    throw new SchematicOpError("NOT_FOUND", `There is no ${ref.trim()} on this sheet.${some.length ? ` Parts: ${some.join(", ")}.` : ""}`);
  }
  return hit;
}

function findPin(symbol: PlacedSymbol, pin: string): SheetPin {
  if (!symbol.def) {
    throw new SchematicOpError("NO_DEFINITION", `The sheet does not embed ${symbol.ref}'s symbol (${symbol.libId}), so its pins are unknown.`);
  }
  const want = String(pin).trim();
  const byNumber = symbol.pins.filter((p) => p.number === want);
  if (byNumber.length) return byNumber[0]!;
  const byName = symbol.pins.filter((p) => p.name.toLowerCase() === want.toLowerCase() && p.name !== "~");
  if (byName.length === 1) return byName[0]!;
  const list = symbol.pins.map((p) => (p.name && p.name !== "~" ? `${p.number} (${p.name})` : p.number)).join(", ");
  throw new SchematicOpError(
    "NO_PIN",
    byName.length > 1 ? `${symbol.ref} has several pins named ${want}; use a pin number: ${list}.` : `${symbol.ref} has no pin ${want}. Pins: ${list}.`,
  );
}

/** Bounded edit label. */
const labelOf = (text: string): string => (text.length > 100 ? `${text.slice(0, 97)}...` : text);

// ── The edit builder ─────────────────────────────────────────────────────────

/**
 * Collects one edit across several operations, keeping the sheet view current:
 * references handed out and room taken by earlier steps of the same request
 * count for the later ones.
 */
class EditBuilder {
  readonly upserts = new Map<string, string>();
  readonly removed = new Set<string>();
  readonly libSymbols: Record<string, string> = {};
  readonly refs = new Set<string>();
  readonly boxes: Box[] = [];

  constructor(readonly sheet: Sheet) {
    for (const s of sheet.symbols) this.refs.add(s.ref);
    for (const s of sheet.symbols) {
      this.boxes.push(s.def ? offsetBox(symbolBox(s.def, s.angle, s.mirror, s.unit), s.at) : offsetBox({ minX: -2.54, minY: -2.54, maxX: 2.54, maxY: 2.54 }, s.at));
    }
    for (const l of sheet.labels) this.boxes.push(textBox(l.at, l.angle, l.name));
    for (const w of sheet.wires) {
      this.boxes.push({ minX: Math.min(w.a[0], w.b[0]), minY: Math.min(w.a[1], w.b[1]), maxX: Math.max(w.a[0], w.b[0]), maxY: Math.max(w.a[1], w.b[1]) });
    }
    for (const p of [...sheet.junctions, ...sheet.noConnects]) this.boxes.push({ minX: p.at[0] - 0.635, minY: p.at[1] - 0.635, maxX: p.at[0] + 0.635, maxY: p.at[1] + 0.635 });
    this.boxes.push(...sheet.other);
  }

  /** The first free `<prefix><n>` (power symbols: `#PWR0<n>`, as KiCad numbers them). */
  nextRef(prefix: string): string {
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")}(\\d+)$`);
    let max = 0;
    for (const r of this.refs) {
      const m = r.match(re);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const ref = prefix === "#PWR" ? `#PWR0${max + 1}` : `${prefix}${max + 1}`;
    this.refs.add(ref);
    return ref;
  }

  upsert(uuid: string, form: SNode): void {
    this.upserts.set(uuid, printSexpr(form));
  }

  remove(uuid: string): void {
    this.upserts.delete(uuid);
    this.removed.add(uuid);
  }

  /** Make sure the sheet will embed `def` as `libId`. */
  embed(libId: string, def: Form): void {
    if (this.sheet.defs.has(libId) || this.libSymbols[libId]) return;
    this.libSymbols[libId] = printSexpr(["symbol", quote(libId), ...def.slice(2)]);
    this.sheet.defs.set(libId, def);
  }

  edit(label: string): SchematicEdit {
    return {
      label: labelOf(label),
      upsert: [...this.upserts.values()].map((sexpr) => ({ sexpr })),
      remove: [...this.removed],
      libSymbols: this.libSymbols,
    };
  }
}

// ── Building items ───────────────────────────────────────────────────────────

const LABEL_JUSTIFY: Record<Angle, string> = { 0: "left", 90: "left", 180: "right", 270: "right" };

function labelForm(kind: "label" | "global_label", name: string, at: Point, angle: Angle, uuid: string): SNode {
  const effects: SNode = ["effects", font(), kind === "label" ? ["justify", LABEL_JUSTIFY[angle], "bottom"] : ["justify", LABEL_JUSTIFY[angle]]];
  const pos: SNode = ["at", fmt(at[0]), fmt(at[1]), String(angle)];
  return kind === "label"
    ? ["label", quote(name), pos, effects, ["uuid", quote(uuid)]]
    : ["global_label", quote(name), ["shape", "passive"], pos, effects, ["uuid", quote(uuid)]];
}

const noConnectForm = (at: Point, uuid: string): SNode => ["no_connect", ["at", fmt(at[0]), fmt(at[1])], ["uuid", quote(uuid)]];

interface InstanceSpec {
  libId: string;
  def: Form;
  ref: string;
  value?: string;
  footprint?: string;
  at: Point;
  angle: Angle;
  mirror: Mirror;
  uuid: string;
}

/** A placed symbol: the definition's fields (positions transformed), one pin entry per pin, the sheet instance. */
function symbolForm(spec: InstanceSpec, instance: Sheet["instance"]): SNode {
  const { def, at, angle, mirror } = spec;
  const flag = (tag: string, fallback: string): SNode => [tag, typeof child(def, tag)?.[1] === "string" ? (child(def, tag)![1] as string) : fallback];
  const properties: SNode[] = [];
  for (const node of def.slice(2)) {
    if (!isForm(node, "property")) continue;
    const name = unquote(node[1]) ?? "";
    if (name.startsWith("ki_")) continue;
    let value = unquote(node[2]) ?? "";
    if (name === "Reference") value = spec.ref;
    if (name === "Value" && spec.value !== undefined) value = spec.value;
    if (name === "Footprint" && spec.footprint !== undefined) value = spec.footprint;
    const lat = atOf(node as Form) ?? { x: 0, y: 0, angle: 0 };
    const [dx, dy] = toSheet(lat.x, lat.y, angle, mirror);
    const rest = node.slice(3).filter((n) => !isForm(n, "at"));
    properties.push(["property", quote(name), quote(value), ["at", fmt(at[0] + dx), fmt(at[1] + dy), fmt(lat.angle)], ...rest]);
  }
  if (spec.footprint !== undefined && !properties.some((p) => (p as SNode[])[1] === quote("Footprint"))) {
    properties.push(["property", quote("Footprint"), quote(spec.footprint), ["at", fmt(at[0]), fmt(at[1]), "0"], ["effects", font(), ["hide", "yes"]]]);
  }
  const numbers = [...new Set(pinPositions(def, at, angle, mirror).map((p) => p.number))];
  return [
    "symbol",
    ["lib_id", quote(spec.libId)],
    ["at", fmt(at[0]), fmt(at[1]), String(angle)],
    ...(mirror ? [["mirror", mirror] as SNode] : []),
    ["unit", "1"],
    flag("exclude_from_sim", "no"),
    flag("in_bom", "yes"),
    flag("on_board", "yes"),
    ["dnp", "no"],
    ["uuid", quote(spec.uuid)],
    ...properties,
    ...numbers.map((n): SNode => ["pin", quote(n), ["uuid", quote(newUuid())]]),
    ["instances", ["project", quote(instance.project), ["path", quote(instance.path), ["reference", quote(spec.ref)], ["unit", "1"]]]],
  ];
}

// ── Connecting pins ──────────────────────────────────────────────────────────

/** A power symbol's definition, by the net it names. */
export interface PowerDef {
  libId: string;
  def: Form;
}

export interface ConnectReport {
  pin: string;
  net: string | null;
  how: "label" | "global_label" | "power" | "no_connect" | "disconnected" | "already";
}

/** The embedded power symbol whose value is `net`, if the sheet has one. */
function embeddedPower(sheet: Sheet, net: string): PowerDef | undefined {
  for (const [libId, def] of sheet.defs) {
    if (isPowerDef(def) && (prop(def, "Value") === net || libId.split(":").pop() === net)) return { libId, def };
  }
  return undefined;
}

/** Rotation and anchor that put a power symbol's pin on `pin.at` with its body pointing away from the part. */
function powerPlacement(def: Form, pin: SheetPin): { at: [number, number]; angle: Angle } {
  const want = [-pin.toward[0], -pin.toward[1]];
  for (const angle of [0, 90, 180, 270] as const) {
    const p = pinPositions(def, [0, 0], angle)[0];
    if (!p) break;
    if (p.toward[0] === want[0] && p.toward[1] === want[1]) {
      return { at: [round4(pin.at[0] - p.at[0]), round4(pin.at[1] - p.at[1])], angle };
    }
  }
  return { at: pin.at, angle: 0 };
}

interface ConnectContext {
  b: EditBuilder;
  powerDefs: Record<string, PowerDef>;
}

/** Attach one pin end to a net, a no-connect flag, or nothing. */
function attachPin(
  ctx: ConnectContext,
  pin: SheetPin,
  pinName: string,
  target: { net: string } | { noConnect: true } | { disconnect: true },
  ownerUuid: string,
): ConnectReport {
  const { b } = ctx;
  const sheet = b.sheet;
  const labelsHere = sheet.labels.filter((l) => !b.removed.has(l.uuid) && samePoint(l.at, pin.at));
  const powerHere = sheet.symbols.filter((s) => s.power && s.uuid !== ownerUuid && !b.removed.has(s.uuid) && s.pins.some((p) => samePoint(p.at, pin.at)));

  if ("disconnect" in target) {
    const run = wireRun(sheet, [pin.at], new Set([ownerUuid]), b.removed);
    for (const uuid of run) b.remove(uuid);
    for (const uuid of decorationsLeftOnNothing(sheet, [pin.at], b.removed, new Set([ownerUuid]))) b.remove(uuid);
    return { pin: pinName, net: null, how: "disconnected" };
  }
  if ("noConnect" in target) {
    if (sheet.noConnects.some((n) => !b.removed.has(n.uuid) && samePoint(n.at, pin.at))) return { pin: pinName, net: null, how: "already" };
    const uuid = newUuid();
    b.upsert(uuid, noConnectForm(pin.at, uuid));
    sheet.noConnects.push({ uuid, at: pin.at });
    return { pin: pinName, net: null, how: "no_connect" };
  }

  const net = cleanText(target.net, "net name");
  if (labelsHere.some((l) => l.name === net) || powerHere.some((s) => s.value === net)) return { pin: pinName, net, how: "already" };

  const power = ctx.powerDefs[net] ?? embeddedPower(sheet, net);
  if (power) {
    b.embed(power.libId, power.def);
    const { at, angle } = powerPlacement(power.def, pin);
    const uuid = newUuid();
    const ref = b.nextRef("#PWR");
    b.upsert(uuid, symbolForm({ libId: power.libId, def: power.def, ref, at, angle, mirror: "", uuid }, sheet.instance));
    sheet.symbols.push({
      uuid,
      form: ["symbol"],
      libId: power.libId,
      ref,
      value: prop(power.def, "Value") ?? net,
      footprint: "",
      at,
      angle,
      mirror: "",
      unit: 1,
      power: true,
      def: power.def,
      pins: pinPositions(power.def, at, angle),
    });
    return { pin: pinName, net, how: "power" };
  }
  const global = isPowerNetName(net) || sheet.labels.some((l) => l.kind === "global_label" && l.name === net);
  const kind = global ? "global_label" : "label";
  const angle = outwardAngle(pin.toward);
  const uuid = newUuid();
  b.upsert(uuid, labelForm(kind, net, pin.at, angle, uuid));
  sheet.labels.push({ uuid, kind, name: net, at: pin.at, angle });
  b.boxes.push(textBox(pin.at, angle, net));
  return { pin: pinName, net, how: kind };
}

export interface ConnectPin {
  ref: string;
  /** Pin number, or a unique pin name. */
  pin: string;
  /** The net to join; `null` disconnects the pin (its label, flag, power symbol and wire run). */
  net?: string | null;
  /** Mark the pin as intentionally unconnected (KiCad's X flag). */
  noConnect?: boolean;
}

/**
 * Connect pins to nets: a local label on the pin end pointing away from the
 * body; a power symbol for power nets when one is available (given in
 * `powerDefs` or embedded in the sheet), else a global label; a no-connect
 * flag; or, for `net: null`, remove what connects the pin.
 */
export function connectEdit(input: { doc: KicadDoc; pins: ConnectPin[]; powerDefs?: Record<string, PowerDef>; projectName?: string }): {
  edit: SchematicEdit;
  connected: ConnectReport[];
} {
  if (!input.pins.length) throw new SchematicOpError("INVALID", "No pins to connect.");
  const b = new EditBuilder(readSheet(input.doc, input.projectName));
  const ctx: ConnectContext = { b, powerDefs: input.powerDefs ?? {} };
  const connected = input.pins.map((p) => {
    const symbol = findSymbol(b.sheet, p.ref);
    const pin = findPin(symbol, p.pin);
    const name = `${symbol.ref}.${pin.number}`;
    if (p.noConnect) return attachPin(ctx, pin, name, { noConnect: true }, symbol.uuid);
    if (p.net === null) return attachPin(ctx, pin, name, { disconnect: true }, symbol.uuid);
    if (p.net === undefined) throw new SchematicOpError("INVALID", `Give a net for ${name}, null to disconnect it, or noConnect.`);
    return attachPin(ctx, pin, name, { net: p.net }, symbol.uuid);
  });
  const label = connected.map((c) => (c.how === "no_connect" ? `${c.pin} no-connect` : c.net === null ? `disconnect ${c.pin}` : `${c.pin} to ${c.net}`)).join(", ");
  return { edit: b.edit(`Connect ${label}`), connected };
}

// ── Wires: what a removed pin leaves behind ──────────────────────────────────

/**
 * Wires reached from `starts` (pin ends going away) up to the next junction,
 * branch, other part's pin, or another wire: the run to delete. Bends (exactly
 * one more wire, nothing else there) are followed.
 */
function wireRun(sheet: Sheet, starts: Point[], goingAway: Set<string>, alreadyRemoved: Set<string>): Set<string> {
  const live = sheet.wires.filter((w) => !alreadyRemoved.has(w.uuid));
  const at = new Map<string, SheetWire[]>();
  for (const w of live) {
    for (const p of [w.a, w.b]) at.set(key(p), [...(at.get(key(p)) ?? []), w]);
  }
  const junctions = new Set(sheet.junctions.filter((j) => !alreadyRemoved.has(j.uuid)).map((j) => key(j.at)));
  const stayingPins = new Set(
    sheet.symbols.filter((s) => !s.power && !goingAway.has(s.uuid) && !alreadyRemoved.has(s.uuid)).flatMap((s) => s.pins.map((p) => key(p.at))),
  );
  const removed = new Set<string>();
  const startKeys = new Set(starts.map(key));
  const queue = [...starts];
  const seen = new Set<string>();
  while (queue.length) {
    const p = queue.shift()!;
    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);
    const here = (at.get(k) ?? []).filter((w) => !removed.has(w.uuid));
    if (!startKeys.has(k)) {
      const stop =
        junctions.has(k) ||
        stayingPins.has(k) ||
        here.length >= 2 ||
        live.some((w) => !removed.has(w.uuid) && onSegmentInterior(p, w.a, w.b));
      if (stop) continue;
    }
    for (const w of here) {
      removed.add(w.uuid);
      queue.push(samePoint(w.a, p) ? w.b : w.a);
    }
  }
  return removed;
}

/**
 * Labels, power symbols, no-connect flags and junctions that touch nothing
 * once `removed` (and the `goingAway` symbols) are gone, looked for at the
 * `points` and along the removed wires.
 */
function decorationsLeftOnNothing(sheet: Sheet, points: Point[], removed: Set<string>, goingAway: Set<string>): string[] {
  const gone = (uuid: string) => removed.has(uuid) || goingAway.has(uuid);
  const removedWires = sheet.wires.filter((w) => removed.has(w.uuid));
  const liveWires = sheet.wires.filter((w) => !removed.has(w.uuid));
  const touched = [...points, ...removedWires.flatMap((w) => [w.a, w.b])];
  const isTouched = (p: Point) => touched.some((t) => samePoint(t, p)) || removedWires.some((w) => onSegmentInterior(p, w.a, w.b));
  const livePins = sheet.symbols.filter((s) => !s.power && !gone(s.uuid)).flatMap((s) => s.pins.map((p) => p.at));
  const connections = (p: Point): number =>
    liveWires.filter((w) => samePoint(w.a, p) || samePoint(w.b, p)).length +
    liveWires.filter((w) => onSegmentInterior(p, w.a, w.b)).length * 2 +
    livePins.filter((q) => samePoint(q, p)).length;
  const out: string[] = [];
  for (const l of sheet.labels) if (!gone(l.uuid) && isTouched(l.at) && connections(l.at) === 0) out.push(l.uuid);
  for (const n of sheet.noConnects) if (!gone(n.uuid) && isTouched(n.at) && connections(n.at) === 0) out.push(n.uuid);
  for (const s of sheet.symbols) {
    if (!s.power || gone(s.uuid)) continue;
    if (s.pins.some((p) => isTouched(p.at)) && s.pins.every((p) => connections(p.at) === 0)) out.push(s.uuid);
  }
  for (const j of sheet.junctions) if (!gone(j.uuid) && isTouched(j.at) && connections(j.at) < 3) out.push(j.uuid);
  return out;
}

// ── Placing parts ────────────────────────────────────────────────────────────

export interface PlacePart {
  libId: string;
  /** The library definition (`resolveSymbolDefinition`); omit to use the one the sheet embeds for `libId`. */
  def?: Form;
  value?: string;
  footprint?: string;
  /** Anchor in mm; snapped to the grid. Without it the part goes to a free spot. */
  at?: Point;
  /** Put it in a free spot next to this part (a reference). */
  near?: string;
  angle?: number;
  mirror?: Mirror;
  /** Pin number (or unique name) → net, connected in the same edit. */
  nets?: Record<string, string>;
}

export interface PlacedReport {
  ref: string;
  uuid: string;
  libId: string;
  value: string;
  at: [number, number];
  angle: Angle;
  pins: PartPin[];
  connected: ConnectReport[];
}

/** A reference prefix from a definition's Reference field: `R`, `U`, `#PWR`. */
const refPrefix = (def: Form): string => (prop(def, "Reference") ?? "U").replace(/[?\d]+$/, "") || "U";

/**
 * Place parts: references continue the sheet's numbering, each part goes to a
 * free spot (or where asked), definitions the sheet lacks are embedded, and
 * `nets` are connected in the same edit (one undo step for the request).
 */
export function placePartEdit(input: { doc: KicadDoc; parts: PlacePart[]; powerDefs?: Record<string, PowerDef>; projectName?: string }): {
  edit: SchematicEdit;
  placed: PlacedReport[];
} {
  if (!input.parts.length) throw new SchematicOpError("INVALID", "No parts to place.");
  const b = new EditBuilder(readSheet(input.doc, input.projectName));
  const ctx: ConnectContext = { b, powerDefs: input.powerDefs ?? {} };
  const middleY = (() => {
    const ys = b.sheet.symbols.filter((s) => !s.power).map((s) => s.at[1]).sort((x, y) => x - y);
    return ys.length ? ys[Math.floor(ys.length / 2)] : undefined;
  })();
  const placed = input.parts.map((part): PlacedReport => {
    const libId = cleanText(part.libId, "lib id", 200);
    if (!libId.includes(":")) throw new SchematicOpError("INVALID", `A lib id is "Library:Symbol", e.g. "Device:R" (got "${libId}").`);
    const def = part.def ?? b.sheet.defs.get(libId);
    if (!def) throw new SchematicOpError("NO_DEFINITION", `The sheet does not embed ${libId}; get it from the library first.`);
    b.embed(libId, def);
    const angle = normalizeAngle(part.angle ?? 0);
    const mirror = part.mirror ?? "";
    const box = symbolBox(def, angle, mirror);
    let at: [number, number];
    if (part.at) {
      at = [snap(part.at[0]), snap(part.at[1])];
    } else if (part.near) {
      at = freeSpot(b.boxes, box, { near: findSymbol(b.sheet, part.near).at });
    } else {
      at = freeSpot(b.boxes, box, { rowY: middleY });
    }
    const value = part.value === undefined ? undefined : cleanText(part.value, "value");
    const footprint = part.footprint === undefined ? undefined : cleanText(part.footprint, "footprint", 200, true);
    const ref = b.nextRef(refPrefix(def));
    const uuid = newUuid();
    b.upsert(uuid, symbolForm({ libId, def, ref, value, footprint, at, angle, mirror, uuid }, b.sheet.instance));
    b.boxes.push(offsetBox(box, at));
    const pins = pinPositions(def, at, angle, mirror);
    const symbol: PlacedSymbol = {
      uuid,
      form: ["symbol"],
      libId,
      ref,
      value: value ?? prop(def, "Value") ?? "",
      footprint: footprint ?? prop(def, "Footprint") ?? "",
      at,
      angle,
      mirror,
      unit: 1,
      power: isPowerDef(def),
      def,
      pins,
    };
    b.sheet.symbols.push(symbol);
    const connected = Object.entries(part.nets ?? {}).map(([pinId, net]) => {
      const pin = findPin(symbol, pinId);
      return attachPin(ctx, pin, `${ref}.${pin.number}`, { net }, uuid);
    });
    return { ref, uuid, libId, value: symbol.value, at, angle, pins: pins.map((p) => ({ number: p.number, name: p.name, at: p.at })), connected };
  });
  return { edit: b.edit(`Place ${placed.map((p) => p.ref).join(", ")}`), placed };
}

/**
 * The text KiCad's own Place Symbol tool takes (the part follows the cursor,
 * the person clicks): the definition plus one instance, with Value and
 * Footprint set when given.
 */
export function placementBlob(input: { def: Form; libId: string; value?: string; footprint?: string; uuid?: string }): { label: string; sexpr: string } {
  const at = input.libId.indexOf(":");
  if (at <= 0 || at === input.libId.length - 1) throw new SchematicOpError("INVALID", `A lib id is "Library:Symbol" (got "${input.libId}").`);
  return buildSymbolClipboard(input.def, input.libId.slice(0, at), input.libId.slice(at + 1), input.uuid ?? newUuid(), {
    value: input.value === undefined ? undefined : cleanText(input.value, "value"),
    footprint: input.footprint === undefined ? undefined : cleanText(input.footprint, "footprint", 200, true),
  });
}

// ── Removing parts ───────────────────────────────────────────────────────────

/**
 * Remove parts. With `withWires`, also the wires from their pins up to the next
 * junction or other part, and the labels, power symbols, flags and junctions
 * that are then left on nothing.
 */
export function removePartEdit(input: { doc: KicadDoc; refs: string[]; withWires?: boolean }): {
  edit: SchematicEdit;
  removed: string[];
  alsoRemoved: { wires: number; labels: number; powerSymbols: number; other: number };
} {
  if (!input.refs.length) throw new SchematicOpError("INVALID", "No parts to remove.");
  const sheet = readSheet(input.doc);
  const b = new EditBuilder(sheet);
  const symbols = [...new Map(input.refs.map((r) => findSymbol(sheet, r)).map((s) => [s.uuid, s])).values()];
  for (const s of symbols) b.remove(s.uuid);
  const also = { wires: 0, labels: 0, powerSymbols: 0, other: 0 };
  if (input.withWires !== false) {
    const goingAway = new Set(symbols.map((s) => s.uuid));
    const starts = symbols.flatMap((s) => s.pins.map((p) => p.at));
    const run = wireRun(sheet, starts, goingAway, new Set());
    for (const uuid of run) b.remove(uuid);
    also.wires = run.size;
    for (const uuid of decorationsLeftOnNothing(sheet, starts, run, goingAway)) {
      b.remove(uuid);
      if (sheet.labels.some((l) => l.uuid === uuid)) also.labels++;
      else if (sheet.symbols.some((s) => s.uuid === uuid)) also.powerSymbols++;
      else also.other++;
    }
  }
  const refs = symbols.map((s) => s.ref);
  return { edit: b.edit(`Remove ${refs.join(", ")}`), removed: refs, alsoRemoved: also };
}

// ── Fields ───────────────────────────────────────────────────────────────────

export interface FieldChange {
  ref: string;
  /** `Value`, `Footprint`, `Datasheet`, `Reference`, or any custom field (`MPN`, …). */
  field: string;
  value: string;
}

const KNOWN_FIELDS = ["Reference", "Value", "Footprint", "Datasheet", "Description"];

/** Set fields on placed parts (a new custom field is added hidden). */
export function setFieldEdit(input: { doc: KicadDoc; changes: FieldChange[] }): {
  edit: SchematicEdit;
  changed: Array<{ ref: string; field: string; value: string }>;
} {
  if (!input.changes.length) throw new SchematicOpError("INVALID", "No fields to set.");
  const sheet = readSheet(input.doc);
  const b = new EditBuilder(sheet);
  const forms = new Map<string, Form>();
  const changed: Array<{ ref: string; field: string; value: string }> = [];
  for (const change of input.changes) {
    const symbol = findSymbol(sheet, change.ref);
    const form = forms.get(symbol.uuid) ?? (structuredClone(symbol.form) as Form);
    forms.set(symbol.uuid, form);
    const asked = cleanText(change.field, "field name", 60);
    const name = KNOWN_FIELDS.find((f) => f.toLowerCase() === asked.toLowerCase()) ?? asked;
    const value = name === "Reference" ? cleanText(change.value, "reference", 30) : cleanText(change.value, `${name} value`, 500, true);
    if (name === "Reference") {
      if (/\s/.test(value)) throw new SchematicOpError("INVALID", `A reference has no spaces (got "${value}").`);
      if (sheet.symbols.some((s) => s.uuid !== symbol.uuid && s.ref.toLowerCase() === value.toLowerCase())) {
        throw new SchematicOpError("INVALID", `${value} is already used on this sheet.`);
      }
      // The sheet instance carries the reference too.
      const walk = (node: SNode): void => {
        if (!Array.isArray(node)) return;
        if (node[0] === "reference" && node.length === 2) node[1] = quote(value);
        node.forEach(walk);
      };
      walk(child(form, "instances") ?? []);
    }
    const existing = form.findIndex((n) => isForm(n, "property") && unquote(n[1])?.toLowerCase() === name.toLowerCase());
    if (existing >= 0) {
      (form[existing] as SNode[])[2] = quote(value);
    } else {
      let last = 0;
      form.forEach((n, i) => {
        if (isForm(n, "property")) last = i;
      });
      form.splice(last + 1, 0, ["property", quote(name), quote(value), ["at", fmt(symbol.at[0]), fmt(symbol.at[1]), "0"], ["effects", font(), ["hide", "yes"]]]);
    }
    if (name === "Reference") symbol.ref = value;
    changed.push({ ref: symbol.ref, field: name, value });
  }
  for (const [uuid, form] of forms) b.upsert(uuid, form);
  return { edit: b.edit(`Set ${changed.map((c) => `${c.ref} ${c.field}`).join(", ")}`), changed };
}

// ── Moving parts ─────────────────────────────────────────────────────────────

export interface MovePart {
  ref: string;
  /** New anchor in mm (snapped to the grid); omit to keep the position. */
  at?: Point;
  angle?: number;
  mirror?: Mirror;
}

/**
 * Move or rotate parts. Fields keep their place relative to the part; labels,
 * power symbols and no-connect flags sitting on a pin end move with the pin.
 * Wires are not dragged: `wiresLeft` counts the pins a wire still ends on.
 */
export function movePartEdit(input: { doc: KicadDoc; moves: MovePart[] }): {
  edit: SchematicEdit;
  moved: Array<{ ref: string; at: [number, number]; angle: Angle; followed: number; wiresLeft: number }>;
} {
  if (!input.moves.length) throw new SchematicOpError("INVALID", "Nothing to move.");
  const sheet = readSheet(input.doc);
  const b = new EditBuilder(sheet);
  const moved = input.moves.map((m) => {
    const symbol = findSymbol(sheet, m.ref);
    const at: [number, number] = m.at ? [snap(m.at[0]), snap(m.at[1])] : symbol.at;
    const angle = m.angle === undefined ? symbol.angle : normalizeAngle(m.angle);
    const mirror = m.mirror ?? symbol.mirror;
    const form = structuredClone(symbol.form) as Form;
    const reposition = (node: SNode[], x: number, y: number): void => {
      const i = node.findIndex((n) => isForm(n, "at"));
      if (i >= 0) {
        const old = node[i] as SNode[];
        node[i] = ["at", fmt(x), fmt(y), ...old.slice(3)];
      }
    };
    reposition(form, at[0], at[1]);
    const atForm = form.find((n) => isForm(n, "at")) as SNode[];
    atForm[3] = String(angle);
    const mi = form.findIndex((n) => isForm(n, "mirror"));
    if (mi >= 0) form.splice(mi, 1);
    if (mirror) form.splice(form.indexOf(atForm) + 1, 0, ["mirror", mirror]);
    for (const node of form) {
      if (!isForm(node, "property")) continue;
      const p = atOf(node as Form);
      if (!p) continue;
      const [lx, ly] = fromSheet(p.x - symbol.at[0], p.y - symbol.at[1], symbol.angle, symbol.mirror);
      const [dx, dy] = toSheet(lx, ly, angle, mirror);
      reposition(node as SNode[], at[0] + dx, at[1] + dy);
    }
    b.upsert(symbol.uuid, form);

    let followed = 0;
    let wiresLeft = 0;
    if (symbol.def) {
      const after = pinPositions(symbol.def, at, angle, mirror, symbol.unit);
      for (const before of symbol.pins) {
        const now = after.find((p) => p.number === before.number);
        if (!now || samePoint(now.at, before.at)) continue;
        for (const l of sheet.labels) {
          if (!samePoint(l.at, before.at)) continue;
          const la = outwardAngle(now.toward);
          b.upsert(l.uuid, relabel(renderForm(sheet.doc, l.uuid), now.at, la));
          followed++;
        }
        for (const n of sheet.noConnects) {
          if (!samePoint(n.at, before.at)) continue;
          b.upsert(n.uuid, noConnectForm(now.at, n.uuid));
          followed++;
        }
        for (const s of sheet.symbols) {
          if (!s.power || !s.def || !s.pins.some((p) => samePoint(p.at, before.at))) continue;
          const place = powerPlacement(s.def, now);
          const f = structuredClone(s.form) as Form;
          const sa = f.find((n) => isForm(n, "at")) as SNode[];
          f[f.indexOf(sa)] = ["at", fmt(place.at[0]), fmt(place.at[1]), String(place.angle)];
          // Its fields turn with it around the anchor, like the part's own.
          for (const node of f) {
            if (!isForm(node, "property")) continue;
            const p = atOf(node as Form);
            if (!p) continue;
            const [lx, ly] = fromSheet(p.x - s.at[0], p.y - s.at[1], s.angle, s.mirror);
            const [dx, dy] = toSheet(lx, ly, place.angle);
            reposition(node as SNode[], place.at[0] + dx, place.at[1] + dy);
          }
          b.upsert(s.uuid, f);
          followed++;
        }
        if (sheet.wires.some((w) => samePoint(w.a, before.at) || samePoint(w.b, before.at))) wiresLeft++;
      }
    }
    return { ref: symbol.ref, at, angle, followed, wiresLeft };
  });
  return { edit: b.edit(`Move ${moved.map((m) => m.ref).join(", ")}`), moved };
}

/** A label form at a new place and angle (its kind, text, shape and fields kept). */
function relabel(form: Form | undefined, at: Point, angle: Angle): SNode {
  if (!form) throw new SchematicOpError("INVALID", "A label could not be read.");
  const out = structuredClone(form) as SNode[];
  const i = out.findIndex((n) => isForm(n, "at"));
  if (i >= 0) out[i] = ["at", fmt(at[0]), fmt(at[1]), String(angle)];
  const effects = out.find((n) => isForm(n, "effects")) as SNode[] | undefined;
  if (effects) {
    const j = effects.findIndex((n) => isForm(n, "justify"));
    const justify: SNode = form[0] === "label" ? ["justify", LABEL_JUSTIFY[angle], "bottom"] : ["justify", LABEL_JUSTIFY[angle]];
    if (j >= 0) effects[j] = justify;
  }
  return out;
}

// ── Netlist ──────────────────────────────────────────────────────────────────

export interface NetlistNet {
  /** KiCad's net name: `/SDA` (a local label on the root sheet), `+3V3`, `Net-(R1-Pad1)`, … */
  net: string;
  pins: Array<{ ref: string; pin: string; name?: string; type?: string }>;
}

/** KiCad's netlist (`kicad_tools --netlist`, the s-expression `export` format) as nets and their pins. */
export function parseNetlist(text: string): NetlistNet[] {
  let root: SNode | undefined;
  try {
    root = parseSexpr(text)[0];
  } catch (error) {
    throw new SchematicOpError("INVALID", `Not a KiCad netlist: ${(error as Error).message}`);
  }
  if (!isForm(root, "export")) throw new SchematicOpError("INVALID", "Not a KiCad netlist (expected (export ...)).");
  const nets = child(root, "nets");
  return (nets?.slice(1) ?? [])
    .filter((n): n is Form => isForm(n, "net"))
    .map((n) => ({
      net: unquote(child(n, "name")?.[1]) ?? "",
      pins: n
        .slice(1)
        .filter((x): x is Form => isForm(x, "node"))
        .map((node) => {
          const pin = unquote(child(node, "pin")?.[1]) ?? "";
          // KiCad 10 writes the pin's name with its number appended
          // (`(pin "2") (pinfunction "PM_2")`); keep the name the symbol shows.
          const fn = unquote(child(node, "pinfunction")?.[1]);
          const name = fn?.endsWith(`_${pin}`) && fn.length > pin.length + 1 ? fn.slice(0, -(pin.length + 1)) : fn;
          const type = unquote(child(node, "pintype")?.[1]);
          return {
            ref: unquote(child(node, "ref")?.[1]) ?? "",
            pin,
            ...(name ? { name } : {}),
            ...(type ? { type } : {}),
          };
        }),
    }));
}

// ── Joining a net by a pin or by KiCad's automatic name ─────────────────────

/** KiCad's automatic name for a net no label names: `Net-(R1-Pad1)`, `unconnected-(U1-NC-Pad4)`. */
export function isAutoNetName(net: string): boolean {
  return /^\/?(Net-\(|unconnected-\()/.test(net.trim());
}

/** A net as KiCad's netlist names it → the label name that joins it (`/SDA` → `SDA`; top sheet only). */
const joinName = (net: string): string => (/^\/[^/]+$/.test(net) ? net.slice(1) : net);

/** `"P3.1"` when P3 is a part on the sheet (a pin whose net to join), else null. */
function pinTarget(sheet: Sheet, s: string): { ref: string; pin: string } | null {
  const m = /^([^.\s]+)\.([^.\s]+)$/.exec(s.trim());
  return m && sheet.symbols.some((x) => !x.power && x.ref === m[1]) ? { ref: m[1]!, pin: m[2]! } : null;
}

/**
 * The asked nets that are not label names: a pin (`"P3.1"`, join whatever it
 * is on) or KiCad's automatic name of an unnamed net (`"Net-(P3-P1)"`, as
 * list_nets shows it). Resolving them needs KiCad's netlist
 * ({@link resolveNetJoins}); none → no netlist needed.
 */
export function netJoinTargets(doc: KicadDoc, asked: Array<string | null | undefined>): string[] {
  const sheet = readSheet(doc);
  return [...new Set(asked.filter((s): s is string => !!s?.trim()).map((s) => s.trim()))].filter((s) => isAutoNetName(s) || pinTarget(sheet, s));
}

export interface NetJoins {
  /** The label or power net an asked net becomes. */
  name(asked: string): string;
  /** Labels that pins already on a joined net need (nets that had no name), connected in the same edit. */
  anchors: ConnectPin[];
  /** What was joined, for the result: `labelled` names the existing pin that got the label too. */
  joined: Array<{ asked: string; net: string; labelled?: string }>;
}

/**
 * Turn pins and KiCad's automatic net names into label names. A label named
 * `Net-(P3-P1)` would start a new net beside KiCad's unnamed one (Claude did
 * exactly that, ai-chat 0003 step 3), so: a named net is joined by its name;
 * an unnamed one gets a name (`P3_1`, after the pin it is joined at) and a
 * label on one of its existing pins as well. `nets` is KiCad's netlist
 * (`parseNetlist`), needed only when {@link netJoinTargets} is not empty.
 */
export function resolveNetJoins(doc: KicadDoc, asked: Array<string | null | undefined>, nets: NetlistNet[]): NetJoins {
  const sheet = readSheet(doc);
  const byAsked = new Map<string, string>();
  const anchors: ConnectPin[] = [];
  const joined: NetJoins["joined"] = [];
  const taken = new Set([...nets.map((n) => joinName(n.net)), ...sheet.labels.map((l) => l.name)]);
  const named = new Map<string, string>(); // KiCad's net name → the label name it is joined by
  for (const s of netJoinTargets(doc, asked)) {
    const pin = pinTarget(sheet, s);
    const onPin = (p: NetlistNet["pins"][number]) => !!pin && p.ref === pin.ref && (p.pin === pin.pin || p.name === pin.pin);
    const net = pin ? nets.find((n) => n.pins.some(onPin)) : nets.find((n) => n.net === s || joinName(n.net) === joinName(s));
    if (!net) {
      throw new SchematicOpError(
        "NOT_FOUND",
        pin
          ? `KiCad's netlist has no pin ${s} (it reflects the saved sheet, a few seconds behind live edits).`
          : `KiCad's netlist has no net ${s}; list_nets shows the names (a few seconds behind live edits).`,
      );
    }
    let name = named.get(net.net);
    if (name === undefined) {
      if (!isAutoNetName(net.net)) {
        name = joinName(net.net);
        joined.push({ asked: s, net: name });
      } else {
        const anchor = net.pins.find(onPin) ?? net.pins.find((p) => sheet.symbols.some((x) => !x.power && x.ref === p.ref)) ?? net.pins[0];
        if (!anchor) throw new SchematicOpError("NOT_FOUND", `Net ${net.net} has no pins to join.`);
        const base = `${anchor.ref}_${anchor.pin}`.replace(/[^A-Za-z0-9_+-]/g, "_");
        name = base;
        for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
        taken.add(name);
        anchors.push({ ref: anchor.ref, pin: anchor.pin, net: name });
        joined.push({ asked: s, net: name, labelled: `${anchor.ref}.${anchor.pin}` });
      }
      named.set(net.net, name);
    } else {
      joined.push({ asked: s, net: name });
    }
    byAsked.set(s, name);
  }
  return { name: (s) => byAsked.get(s.trim()) ?? joinName(s.trim()), anchors, joined };
}

/**
 * `edit` carrying the definition of every library symbol its upserts place,
 * the ones `doc` already embeds included. An editor's own document can lack a
 * definition the shared document still has (KiCad drops it when an Undo takes
 * the last symbol using it), and KiCad refuses a symbol it cannot resolve
 * (ai-chat 0003 step 6); a definition it already has does no harm.
 */
export function withDefinitions(doc: KicadDoc, edit: SchematicEdit): SchematicEdit {
  const defs = readSheet(doc).defs;
  const libSymbols = { ...edit.libSymbols };
  for (const { sexpr } of edit.upsert) {
    const form = parseSexpr(sexpr)[0];
    if (!isForm(form, "symbol")) continue;
    const libId = unquote(child(form, "lib_id")?.[1]);
    const def = libId ? defs.get(libId) : undefined;
    if (!libId || !def || libSymbols[libId]) continue;
    libSymbols[libId] = printSexpr(["symbol", quote(libId), ...def.slice(2)]);
  }
  return { ...edit, libSymbols };
}

/** Two edits as one (one undo step): `b` was computed on the document with `a` applied. */
export function mergeSchematicEdits(a: SchematicEdit, b: SchematicEdit): SchematicEdit {
  return { label: a.label, upsert: [...a.upsert, ...b.upsert], remove: [...a.remove, ...b.remove], libSymbols: { ...a.libSymbols, ...b.libSymbols } };
}

// ── Applying an edit to a document ───────────────────────────────────────────

/**
 * `doc` with `edit` applied (a new document; `doc` is not changed): what the
 * room or the editor ends up with. For tests, previews and checking an edit
 * with KiCad (`kicad_tools --lint`) before it is written.
 */
export function applySchematicEdit(doc: KicadDoc, edit: SchematicEdit): KicadDoc {
  const out = structuredClone(doc) as KicadDoc;
  const dropTree = (uuid: string): void => {
    for (const [id, item] of Object.entries(out.items)) if (item.parent === uuid) dropTree(id);
    delete out.items[uuid];
  };
  for (const uuid of edit.remove) {
    if (!out.items[uuid]) continue;
    dropTree(uuid);
    out.layout = out.layout.filter((s) => !("item" in s && s.item === uuid));
  }
  for (const { sexpr } of edit.upsert) {
    const { uuid, items } = sexprToItems(sexpr, null);
    const existed = !!out.items[uuid];
    if (existed) {
      for (const [id, item] of Object.entries(out.items)) if (item.parent === uuid) dropTree(id);
    }
    Object.assign(out.items, items);
    if (!existed) out.layout.splice(missingRootInsertIndex(out.layout), 0, { item: uuid });
  }
  const libIds = Object.keys(edit.libSymbols);
  if (libIds.length) {
    let slot = out.layout.find((s): s is Extract<Slot, { k: string }> => "k" in s && s.k === "lib_symbols");
    if (!slot) {
      slot = { k: "lib_symbols", v: [] };
      const firstItem = out.layout.findIndex((s) => "item" in s);
      out.layout.splice(firstItem < 0 ? out.layout.length : firstItem, 0, slot);
    }
    const have = new Set(slot.v.flatMap((d) => ("k" in d && d.k === "symbol" ? [unquoteAtom(args(d.v)[0] ?? "")] : [])));
    for (const libId of libIds) {
      if (!have.has(libId)) slot.v.push(slotFromSexpr(edit.libSymbols[libId]!, out.items));
    }
  }
  return out;
}
