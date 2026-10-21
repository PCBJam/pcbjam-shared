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
import { fieldValueProblem, INVISIBLE, NAME_LOOKALIKE, REFERENCE, safeLibraryField } from "./kicad-text-safety.js";
import { parseSexpr, printSexpr, type SNode } from "./sexpr.js";
import { buildSymbolClipboard, isForm, quote, safeDefinition, unquote, type Form } from "./symbol-lib.js";
import {
  atOf,
  fieldTextBox,
  fieldTexts,
  fmt,
  freeSpot,
  GRID,
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
import { hitsBox, onSegmentInterior, pathProblem, pointKey, routeWire, samePoint, type RouteObstacles } from "./schematic-route.js";

// ── Results ──────────────────────────────────────────────────────────────────

export interface SchematicEdit {
  /** A short description, e.g. for the undo menu. */
  label: string;
  upsert: { sexpr: string }[];
  remove: string[];
  /** Library definitions the sheet lacks, by lib id, each a `(symbol "<lib id>" …)`. */
  libSymbols: Record<string, string>;
}

export type SchematicOpErrorCode = "NOT_FOUND" | "NO_PIN" | "NO_DEFINITION" | "INVALID" | "NO_ROUTE";

/** A refusal the agent can act on: the message says what to fix. */
export class SchematicOpError extends Error {
  constructor(
    readonly code: SchematicOpErrorCode,
    message: string,
    /** For a `NO_ROUTE`: why, in a few words, for a note ("it would run 52 mm"). */
    readonly why?: string,
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

const key = pointKey;

/**
 * Text from outside as a KiCad string: no control characters (C0, DEL, C1),
 * trimmed, bounded. Invisible characters (zero-width, bidi overrides, blank
 * fillers; `INVISIBLE`) are refused: they make two references or values look
 * the same (ai-chat 0006 S21).
 */
export function cleanText(text: string, what: string, max = 120, allowEmpty = false): string {
  const clean = String(text ?? "").replace(/\p{Cc}/gu, "").trim();
  if (INVISIBLE.test(clean)) throw new SchematicOpError("INVALID", `The ${what} has invisible characters.`);
  if (!clean && !allowEmpty) throw new SchematicOpError("INVALID", `The ${what} is empty.`);
  if (clean.length > max) throw new SchematicOpError("INVALID", `The ${what} is longer than ${max} characters.`);
  return clean;
}

/**
 * A lib id KiCad's parser accepts (`LIB_ID::Parse`, lib_id.cpp): "Lib:Item",
 * the library without a backslash or control characters, the item without a
 * backslash, `<`, `>`, `"`, tabs, line breaks or a second `:`. KiCad refuses
 * the whole sheet otherwise (ai-chat 0006 S20).
 */
export function checkLibId(libId: string): { lib: string; item: string } {
  const at = libId.indexOf(":");
  const lib = libId.slice(0, at);
  const item = libId.slice(at + 1);
  if (at <= 0 || !item) throw new SchematicOpError("INVALID", `A lib id is "Library:Symbol", e.g. "Device:R" (got "${libId}").`);
  // KiCad's rules, plus `"` in the library (the sheet would key the definition by the escaped
  // name and lose its pins) and invisible characters anywhere.
  if (/[\p{Cc}\\"]/u.test(lib) || /[\p{Cc}:\\<>"]/u.test(item) || INVISIBLE.test(libId)) {
    throw new SchematicOpError("INVALID", `KiCad does not accept the lib id "${libId}".`);
  }
  return { lib, item };
}

/** Names KiCad's power library covers: `+3V3`, `-12V`, `GND`, `VCC`, … */
export function isPowerNetName(net: string): boolean {
  return /^[+-]/.test(net) || /^(GND|AGND|DGND|PGND|GNDA|GNDD|GNDPWR|VCC|VDD|VSS|VEE|VBUS|VBAT|VAA|VPP)\w*$/i.test(net);
}

/** Ground nets: GND and its kin. */
const isGroundNet = (net: string): boolean => /^(GND|AGND|DGND|PGND|GNDA|GNDD|GNDPWR|VSS|0V)\w*$/i.test(net);

/** Positive supplies (`+3V3`, `VCC`, `VBUS`, …): drawn on top. */
const isSupplyNet = (net: string): boolean => isPowerNetName(net) && !isGroundNet(net) && !net.startsWith("-") && !/^VEE/i.test(net);

/** The room a placed symbol's visible field text takes on the sheet (0009 §3.5). */
function placedTextBoxes(form: Form, angle: Angle, mirror: Mirror): Box[] {
  return fieldTexts(form).map((f) => fieldTextBox(f, f.at, angle, mirror));
}

/** The room `def`'s visible fields take for a part at `at`, with the texts it will get (Reference, Value, …). */
function defTextBoxes(def: Form, at: Point, angle: Angle, mirror: Mirror, texts: Record<string, string | undefined>): Box[] {
  return fieldTexts(def).flatMap((f) => {
    const text = texts[f.name] ?? f.text;
    if (!text) return [];
    const [dx, dy] = toSheet(f.at[0], f.at[1], angle, mirror);
    return [fieldTextBox({ ...f, text }, [at[0] + dx, at[1] + dy], angle, mirror)];
  });
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
  /** The room each symbol's visible field text takes (0009 §3.5), by symbol uuid; also in `boxes`. */
  readonly texts = new Map<string, Box[]>();

  constructor(readonly sheet: Sheet) {
    for (const s of sheet.symbols) this.refs.add(s.ref);
    for (const s of sheet.symbols) {
      this.boxes.push(s.def ? offsetBox(symbolBox(s.def, s.angle, s.mirror, s.unit), s.at) : offsetBox({ minX: -2.54, minY: -2.54, maxX: 2.54, maxY: 2.54 }, s.at));
      this.setTexts(s.uuid, placedTextBoxes(s.form, s.angle, s.mirror));
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

  /** A symbol's field text boxes, at its (new) place. */
  setTexts(uuid: string, boxes: Box[]): void {
    this.texts.set(uuid, boxes);
    this.boxes.push(...boxes);
  }

  remove(uuid: string): void {
    this.upserts.delete(uuid);
    this.removed.add(uuid);
  }

  /** A wire from `a` to `z`, kept in the sheet view so later steps see it. */
  addWire(a: Point, z: Point): string {
    const uuid = newUuid();
    this.upsert(uuid, wireForm(a, z, uuid));
    this.sheet.wires.push({ uuid, a: [a[0], a[1]], b: [z[0], z[1]] });
    this.boxes.push({ minX: Math.min(a[0], z[0]), minY: Math.min(a[1], z[1]), maxX: Math.max(a[0], z[0]), maxY: Math.max(a[1], z[1]) });
    return uuid;
  }

  /** A junction at `at`, unless one is there. */
  addJunction(at: Point): void {
    if (this.sheet.junctions.some((j) => !this.removed.has(j.uuid) && samePoint(j.at, at))) return;
    const uuid = newUuid();
    this.upsert(uuid, junctionForm(at, uuid));
    this.sheet.junctions.push({ uuid, at: [at[0], at[1]] });
  }

  /** Make sure the sheet will embed `def` as `libId`. */
  embed(libId: string, def: Form): void {
    if (this.sheet.defs.has(libId) || this.libSymbols[libId]) return;
    checkLibId(libId);
    // No library link KiCad should not open goes into the sheet (ai-chat 0006 S4).
    this.libSymbols[libId] = printSexpr(["symbol", quote(libId), ...safeDefinition(def).slice(2)]);
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

const wireForm = (a: Point, z: Point, uuid: string): SNode => [
  "wire",
  ["pts", ["xy", fmt(a[0]), fmt(a[1])], ["xy", fmt(z[0]), fmt(z[1])]],
  ["stroke", ["width", "0"], ["type", "default"]],
  ["uuid", quote(uuid)],
];

const junctionForm = (at: Point, uuid: string): SNode => [
  "junction",
  ["at", fmt(at[0]), fmt(at[1])],
  ["diameter", "0"],
  ["color", "0", "0", "0", "0"],
  ["uuid", quote(uuid)],
];

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
    // The library's text, but no link KiCad should not open (ai-chat 0006 S4).
    let value = safeLibraryField(name, unquote(node[2]) ?? "");
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
  how: "label" | "global_label" | "power" | "no_connect" | "disconnected" | "already" | "wire";
  /** Why it was connected otherwise than asked (a wire with no clean route became labels). */
  note?: string;
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

/** One step of a stub wire taking a label or power symbol out from a pin (two grid steps). */
const STUB = 2.54;

/** A way out of a pin for a label or power symbol: the stub's points from the pin end, and the way its decoration faces. */
interface StubWay {
  path: Array<[number, number]>;
  dir: Point;
}

/**
 * Ways out of `pin` for a label or power symbol, shortest first (ai-chat 0008
 * §2.3): on the pin end, straight out up to four steps, then out and sideways.
 */
function stubWays(pin: SheetPin, opts: { onEnd: boolean; bent: boolean }): StubWay[] {
  const out: Point = [-pin.toward[0], -pin.toward[1]];
  const step = (p: Point, d: Point, n: number): [number, number] => [round4(p[0] + d[0] * STUB * n), round4(p[1] + d[1] * STUB * n)];
  const ways: Array<StubWay & { cost: number }> = [];
  if (opts.onEnd) ways.push({ path: [pin.at], dir: out, cost: 0 });
  for (let k = 1; k <= 4; k++) ways.push({ path: [pin.at, step(pin.at, out, k)], dir: out, cost: k });
  if (opts.bent) {
    const sides: Point[] = [
      [out[1], out[0]],
      [-out[1], -out[0]],
    ];
    for (let k = 1; k <= 2; k++) {
      for (let m = 1; m <= 4; m++) {
        for (const side of sides) {
          const corner = step(pin.at, out, k);
          ways.push({ path: [pin.at, corner, step(corner, side, m)], dir: side, cost: k + m + 1 });
        }
      }
    }
  }
  // Stable: on a tie the straight way (listed first) wins.
  return ways.sort((x, y) => x.cost - y.cost);
}

/**
 * What is wrong with a stub along `path` from a pin end (null: nothing): ai-chat
 * 0008 §2.1's rules, and not ending on a wire. `obs` leaves out the pin's own
 * part, `own`: its first segment leaves the pin end outward, past whatever of
 * the part sticks out beside it (an LED's light arrows); a sideways run after
 * it keeps off the part.
 */
function stubProblem(path: Array<[number, number]>, obs: RouteObstacles, own?: Box): string | null {
  if (path.length < 2) return null;
  const end = path[path.length - 1]!;
  if (own && path.slice(2).some((q, i) => hitsBox(path[i + 1]!, q, own))) return "crosses its own part";
  return pathProblem(path, obs) ?? (obs.wires.some((w) => onSegmentInterior(end, w.a, w.b)) ? "ends on a wire" : null);
}

/** A symbol's body on the sheet, by uuid (undefined: none, or its definition is unknown). */
function bodyOf(b: EditBuilder, uuid: string | undefined): Box | undefined {
  const s = b.sheet.symbols.find((x) => x.uuid === uuid);
  return s?.def ? offsetBox(symbolBox(s.def, s.angle, s.mirror, s.unit), s.at) : undefined;
}

/** The boxes `b` keeps for the wires on `at` (a label may sit on its pin's wire). */
function wireBoxesAt(b: EditBuilder, at: Point): Box[] {
  return b.sheet.wires
    .filter((w) => !b.removed.has(w.uuid) && (samePoint(w.a, at) || samePoint(w.b, at)))
    .map((w) => ({ minX: Math.min(w.a[0], w.b[0]), minY: Math.min(w.a[1], w.b[1]), maxX: Math.max(w.a[0], w.b[0]), maxY: Math.max(w.a[1], w.b[1]) }));
}

/** Whether `box` meets nothing on the sheet but `except` (touching edges do not count, as in the layout check). */
function clearOf(b: EditBuilder, box: Box, except: Box[]): boolean {
  const inset = (x: Box): Box => ({ minX: x.minX + 0.1, minY: x.minY + 0.1, maxX: x.maxX - 0.1, maxY: x.maxY - 0.1 });
  const meet = (p: Box, q: Box) => p.minX < q.maxX && q.minX < p.maxX && p.minY < q.maxY && q.minY < p.maxY;
  const skip = new Set(except.map((x) => JSON.stringify(x)));
  const mine = inset(box);
  return !b.boxes.some((o) => !skip.has(JSON.stringify(o)) && meet(mine, inset(o)));
}

/** Draw a stub from its pin end; a junction where the pin already had a wire (three ends meet). */
function drawStub(b: EditBuilder, path: Array<[number, number]>): void {
  if (path.length < 2) return;
  const had = b.sheet.wires.some((w) => !b.removed.has(w.uuid) && (samePoint(w.a, path[0]!) || samePoint(w.b, path[0]!)));
  for (let i = 1; i < path.length; i++) b.addWire(path[i - 1]!, path[i]!);
  if (had) b.addJunction(path[0]!);
}

/**
 * Where a power symbol goes for `pin` (ai-chat 0003 step 5c, 0008 §2.3). On a
 * sideways pin it keeps its natural orientation (a supply points up, a ground
 * down) on a stub wire: turned sideways, the symbols of neighbouring pins (a
 * connector's +5V and GND, 2.54 mm apart) landed on each other. On a pin that
 * points up or down it sits on the pin end, turned away from the part. Either
 * way it goes out step by step until its box is clear; the stub touches nothing.
 */
function powerSpot(b: EditBuilder, def: Form, pin: SheetPin, owner?: string): { at: [number, number]; angle: Angle } {
  const natural = pinPositions(def, [0, 0], 0)[0]?.toward;
  const out: Point = [-pin.toward[0], -pin.toward[1]];
  const sideways = !!natural && natural[0] === 0 && out[1] === 0 && out[0] !== 0;
  // A pin facing the symbol's own way puts it upright (angle 0).
  const placeAt = (end: [number, number]) => powerPlacement(def, sideways ? { ...pin, at: end, toward: [-natural![0], -natural![1]] } : { ...pin, at: end });
  const obs = obstaclesFor(b, [pin.at], owner);
  const own = bodyOf(b, owner);
  const except = wireBoxesAt(b, pin.at);
  // Where three lines meet already, a stub would make four (0009 §3.2).
  const crowded = armsAt(b, pin.at) >= 3;
  const ways = stubWays(pin, { onEnd: !sideways, bent: false }).filter((w) => !crowded || w.path.length < 2);
  const clean = ways.filter((w) => !stubProblem(w.path, obs, own));
  for (const way of clean) {
    const place = placeAt(way.path[way.path.length - 1]!);
    // Its name too (0009 §3.5).
    const room = [offsetBox(symbolBox(def, place.angle), place.at), ...defTextBoxes(def, place.at, place.angle, "", {})];
    if (!room.every((box) => clearOf(b, box, except))) continue;
    drawStub(b, way.path);
    return place;
  }
  // Nothing clear: the shortest clean way (the layout check names the overlap), else the pin end.
  const way = clean[0];
  if (!way) return powerPlacement(def, pin);
  drawStub(b, way.path);
  return placeAt(way.path[way.path.length - 1]!);
}

/**
 * Where a label goes for `pin` (ai-chat 0008 §2.3): on the pin end, facing away
 * from the part, when its text is clear; else out on a stub, straight then
 * bent, step by step. Nothing clear: the pin end (the layout check names it).
 */
function labelSpot(b: EditBuilder, pin: SheetPin, name: string, owner?: string): { at: [number, number]; angle: Angle } {
  const obs = obstaclesFor(b, [pin.at], owner);
  const own = bodyOf(b, owner);
  const except = wireBoxesAt(b, pin.at);
  const crowded = armsAt(b, pin.at) >= 3;
  for (const way of stubWays(pin, { onEnd: true, bent: true }).filter((w) => !crowded || w.path.length < 2)) {
    const end = way.path[way.path.length - 1]!;
    const angle = outwardAngle([-way.dir[0], -way.dir[1]]);
    if (stubProblem(way.path, obs, own) || !clearOf(b, textBox(end, angle, name), except)) continue;
    drawStub(b, way.path);
    return { at: end, angle };
  }
  return { at: pin.at, angle: outwardAngle(pin.toward) };
}

/**
 * A pin's decoration stub, as `powerSpot` and `labelSpot` draw it: from the pin
 * end (its only wire) through plain bends to one label or power symbol and
 * nothing else. A run going on to more (a branch, another pin, a junction) is
 * not one, so nothing redraws it.
 */
function stubOf(b: EditBuilder, at: Point): { wires: string[]; end: [number, number] } | null {
  const sheet = b.sheet;
  const live = sheet.wires.filter((w) => !b.removed.has(w.uuid));
  const wiresAt = (p: Point) => live.filter((w) => samePoint(w.a, p) || samePoint(w.b, p));
  const has = (p: Point) => ({
    pin: sheet.symbols.some((s) => !s.power && !b.removed.has(s.uuid) && s.pins.some((q) => samePoint(q.at, p))),
    power: sheet.symbols.some((s) => s.power && !b.removed.has(s.uuid) && s.pins.some((q) => samePoint(q.at, p))),
    label: sheet.labels.some((l) => !b.removed.has(l.uuid) && l.kind !== "hierarchical_label" && samePoint(l.at, p)),
    other:
      sheet.labels.some((l) => !b.removed.has(l.uuid) && l.kind === "hierarchical_label" && samePoint(l.at, p)) ||
      [...sheet.junctions, ...sheet.noConnects].some((x) => !b.removed.has(x.uuid) && samePoint(x.at, p)) ||
      live.some((w) => onSegmentInterior(p, w.a, w.b)),
  });
  const first = wiresAt(at);
  if (first.length !== 1) return null;
  const wires: string[] = [];
  let prev: Point = at;
  let w = first[0]!;
  for (let n = 0; n < 3; n++) {
    wires.push(w.uuid);
    const end = samePoint(w.a, prev) ? w.b : w.a;
    const here = has(end);
    if (here.pin || here.other) return null;
    const next = wiresAt(end).filter((x) => x.uuid !== w.uuid);
    if (!next.length) return here.label !== here.power ? { wires, end } : null;
    if (next.length !== 1 || here.label || here.power) return null;
    prev = end;
    w = next[0]!;
  }
  return null;
}

/**
 * The lines meeting at `p` (0009 §3.2): wire ends, wires passing through (two
 * each) and pin ends, power symbols' included. Four read like a crossing.
 */
function armsAt(b: EditBuilder, p: Point): number {
  let n = 0;
  for (const w of b.sheet.wires) {
    if (b.removed.has(w.uuid)) continue;
    if (samePoint(w.a, p) || samePoint(w.b, p)) n += 1;
    else if (onSegmentInterior(p, w.a, w.b)) n += 2;
  }
  for (const s of b.sheet.symbols) if (!b.removed.has(s.uuid)) n += s.pins.filter((q) => samePoint(q.at, p)).length;
  return n;
}

/** The nets named on a pin: labels and power symbols on its end or at the far end of its stub. */
function pinNets(b: EditBuilder, pin: SheetPin): string[] {
  const stub = stubOf(b, pin.at);
  const ends = [pin.at, ...(stub ? [stub.end] : [])];
  return [
    ...b.sheet.labels.filter((l) => !b.removed.has(l.uuid) && ends.some((e) => samePoint(l.at, e))).map((l) => l.name),
    ...b.sheet.symbols.filter((s) => s.power && !b.removed.has(s.uuid) && s.pins.some((p) => ends.some((e) => samePoint(p.at, e)))).map((s) => s.value),
  ];
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
  target: { net: string; labelKind?: "label" | "global_label" } | { noConnect: true } | { disconnect: true },
  ownerUuid: string,
): ConnectReport {
  const { b } = ctx;
  const sheet = b.sheet;
  // What already names this pin: on its end, or at the far end of its stub.
  const ends = [pin.at, ...(stubOf(b, pin.at) ? [stubOf(b, pin.at)!.end] : [])];
  const labelsHere = sheet.labels.filter((l) => !b.removed.has(l.uuid) && ends.some((e) => samePoint(l.at, e)));
  const powerHere = sheet.symbols.filter(
    (s) => s.power && s.uuid !== ownerUuid && !b.removed.has(s.uuid) && s.pins.some((p) => ends.some((e) => samePoint(p.at, e))),
  );

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
  // "VCC 3V3" with a no-break space is another net that looks the same.
  if (NAME_LOOKALIKE.test(net)) throw new SchematicOpError("INVALID", `The net name ${JSON.stringify(net)} has a space other than a plain one, or an invisible character.`);
  if (labelsHere.some((l) => l.name === net) || powerHere.some((s) => s.value === net)) return { pin: pinName, net, how: "already" };

  const power = ctx.powerDefs[net] ?? embeddedPower(sheet, net);
  if (power) {
    b.embed(power.libId, power.def);
    const { at, angle } = powerSpot(b, power.def, pin, ownerUuid);
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
    b.boxes.push(offsetBox(symbolBox(power.def, angle), at));
    b.setTexts(uuid, defTextBoxes(power.def, at, angle, "", {}));
    return { pin: pinName, net, how: "power" };
  }
  const global = isPowerNetName(net) || sheet.labels.some((l) => l.kind === "global_label" && l.name === net);
  const kind = target.labelKind ?? (global ? "global_label" : "label");
  const { at, angle } = labelSpot(b, pin, net, ownerUuid);
  const uuid = newUuid();
  b.upsert(uuid, labelForm(kind, net, at, angle, uuid));
  sheet.labels.push({ uuid, kind, name: net, at, angle });
  b.boxes.push(textBox(at, angle, net));
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
  /** Draw a wire to this pin (`"R2.1"`) instead of a label: for pins near each other. */
  to?: string;
  /** With `to`: when no clean wire exists, put both pins on this net name instead (ai-chat 0008 §2.2). */
  orNet?: string;
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
    if (p.to) {
      const other = pinEnd(b, p.to);
      try {
        wireBetween(b, { at: pin.at, leave: [-pin.toward[0], -pin.toward[1]], name }, other, p.orNet ? { maxLength: LONG_WIRE } : {});
        return { pin: name, net: other.name, how: "wire" as const };
      } catch (error) {
        if (!(error instanceof SchematicOpError && error.code === "NO_ROUTE") || !p.orNet) throw error;
        // No clean wire: both pins on the net's name instead, as for pins far apart.
        const mine = attachPin(ctx, pin, name, { net: p.orNet }, symbol.uuid);
        const [ref, pinText] = [other.name.slice(0, other.name.lastIndexOf(".")), other.name.slice(other.name.lastIndexOf(".") + 1)];
        const otherSymbol = findSymbol(b.sheet, ref);
        attachPin(ctx, findPin(otherSymbol, pinText), other.name, { net: p.orNet }, otherSymbol.uuid);
        const note = `No clean wire to ${other.name} (${error.why ?? "every way crosses a part or touches another pin"}): both pins got the net name ${p.orNet} instead.`;
        return { ...mine, note };
      }
    }
    if (p.noConnect) return attachPin(ctx, pin, name, { noConnect: true }, symbol.uuid);
    if (p.net === null) return attachPin(ctx, pin, name, { disconnect: true }, symbol.uuid);
    if (p.net === undefined) throw new SchematicOpError("INVALID", `Give a net for ${name}, null to disconnect it, or noConnect.`);
    return attachPin(ctx, pin, name, { net: p.net }, symbol.uuid);
  });
  const label = connected.map((c) => (c.how === "no_connect" ? `${c.pin} no-connect` : c.net === null ? `disconnect ${c.pin}` : `${c.pin} to ${c.net}`)).join(", ");
  return { edit: b.edit(`Connect ${label}`), connected };
}

// ── Drawing wires ────────────────────────────────────────────────────────────

/** One end of a wire: a pin end (with the way out of its part) or a point. */
interface WireEnd {
  at: [number, number];
  /** Unit direction away from the part, for a pin. */
  leave?: Point;
  name: string;
}

/** `"R5.1"` as a wire end. */
function pinEnd(b: EditBuilder, text: string): WireEnd {
  const at = text.lastIndexOf(".");
  if (at <= 0 || at === text.length - 1) throw new SchematicOpError("INVALID", `Name a pin as REF.PIN, e.g. "R5.1" (got "${text}").`);
  const symbol = findSymbol(b.sheet, text.slice(0, at));
  const pin = findPin(symbol, text.slice(at + 1));
  return { at: pin.at, leave: [-pin.toward[0], -pin.toward[1]], name: `${symbol.ref}.${pin.number}` };
}

/**
 * What a new wire must keep off (ai-chat 0008 §2.1): every pin end (power
 * symbols' too), label anchor, flag, junction and wire end on the sheet except
 * `ends`; the wires; the parts' bodies; label and field text, at a small cost.
 */
function obstaclesFor(b: EditBuilder, ends: Point[], notBodyOf?: string): RouteObstacles {
  const live = <T extends { uuid: string }>(xs: T[]) => xs.filter((x) => !b.removed.has(x.uuid));
  const symbols = live(b.sheet.symbols);
  const wires = live(b.sheet.wires);
  const labels = live(b.sheet.labels);
  const points: Point[] = [
    ...symbols.flatMap((s) => s.pins.map((p) => p.at)),
    ...labels.map((l) => l.at),
    ...live(b.sheet.noConnects).map((n) => n.at),
    ...live(b.sheet.junctions).map((j) => j.at),
    ...wires.flatMap((w) => [w.a, w.b]),
  ].filter((p) => !ends.some((e) => samePoint(e, p)));
  return {
    points,
    wires: wires.map((w) => ({ a: w.a, b: w.b })),
    bodies: symbols.filter((s) => !s.power && s.def && s.uuid !== notBodyOf).map((s) => offsetBox(symbolBox(s.def!, s.angle, s.mirror, s.unit), s.at)),
    // Text: labels and the parts' own (values, references; 0009 §3.5).
    soft: [...labels.map((l) => textBox(l.at, l.angle, l.name)), ...symbols.flatMap((s) => b.texts.get(s.uuid) ?? [])],
  };
}

/**
 * Points of a wire from `a` to `z` (bends included) that makes no connection
 * nobody asked for: around parts, never on another pin, label, flag, junction
 * or wire end, never along another wire (ai-chat 0008 §2.1). `throughBodies`
 * lets it cross a part when nothing else works (a moved part's wires).
 */
function route(b: EditBuilder, a: WireEnd, z: WireEnd, opts: WireOptions = {}): Array<[number, number]> {
  // A fourth line where three meet reads like a crossing (0009 §3.2); a redrawn wire keeps what was there.
  for (const end of opts.redraw ? [] : [a, z]) {
    if (armsAt(b, end.at) >= 3) {
      throw new SchematicOpError(
        "NO_ROUTE",
        `No wire to ${end.name}: three lines already meet there, and a fourth makes a four-way junction, which reads like a crossing. Connect both pins to one net name instead (connect with a net).`,
        `three lines already meet at ${end.name}`,
      );
    }
  }
  const points = routeWire(a, z, obstaclesFor(b, [a.at, z.at]), opts);
  if (!points) {
    throw new SchematicOpError(
      "NO_ROUTE",
      `No clean wire from ${a.name} to ${z.name}: every way crosses a part or touches another pin. Connect both pins to one net name instead (connect with a net).`,
      "every way crosses a part or touches another pin",
    );
  }
  const mm = pathLength(points);
  if (opts.maxLength !== undefined && mm > opts.maxLength) {
    throw new SchematicOpError(
      "NO_ROUTE",
      `A wire from ${a.name} to ${z.name} would run ${Math.round(mm)} mm around parts. Connect both pins to one net name instead (connect with a net).`,
      `it would run ${Math.round(mm)} mm`,
    );
  }
  return points.map((p): [number, number] => [p[0], p[1]]);
}

/** A wire's length along its points, in mm. */
const pathLength = (points: readonly Point[]): number =>
  points.slice(1).reduce((mm, q, i) => mm + Math.hypot(q[0] - points[i]![0], q[1] - points[i]![1]), 0);

/** Wires longer than this read better as a net name on both ends (0009 §3.1). */
const LONG_WIRE = 38.1;

interface WireOptions {
  /** Cross a part when nothing else works (a moved part's wires). */
  throughBodies?: boolean;
  /** Redrawing a connection that was there (a moved part's wire): ends where three lines meet are kept. */
  redraw?: boolean;
  /** Refuse a longer wire (`NO_ROUTE`), so the caller can use net names. */
  maxLength?: number;
}

/**
 * Wire `a` to `z` and mark the joins KiCad needs: a wire end on the middle of
 * another wire connects only with a junction, and three or more ends at one
 * point get one too.
 */
function wireBetween(b: EditBuilder, a: WireEnd, z: WireEnd, opts: WireOptions = {}): Array<[number, number]> {
  if (samePoint(a.at, z.at)) return [a.at];
  const before = b.sheet.wires.filter((w) => !b.removed.has(w.uuid));
  const points = route(b, a, z, opts);
  for (let i = 1; i < points.length; i++) b.addWire(points[i - 1]!, points[i]!);
  const pinsAt = (p: Point) =>
    b.sheet.symbols.filter((s) => !s.power && !b.removed.has(s.uuid)).reduce((n, s) => n + s.pins.filter((q) => samePoint(q.at, p)).length, 0);
  for (const end of [a.at, z.at]) {
    const tee = before.some((w) => onSegmentInterior(end, w.a, w.b));
    const ends = before.filter((w) => samePoint(w.a, end) || samePoint(w.b, end)).length + pinsAt(end) + 1;
    if (tee || ends >= 3) b.addJunction(end);
  }
  return points;
}

export interface WireRequest {
  /** A pin (`"R5.1"`) or a point in mm (snapped to the grid). */
  from: string | Point;
  to: string | Point;
}

/**
 * Draw wires (ai-chat 0003 step 5c): between two pins, or a pin and a point
 * (an existing wire's middle, say), straight or with one bend, junctions where
 * KiCad needs them. For pins near each other; labels are for far ones.
 */
export function wireEdit(input: { doc: KicadDoc; wires: WireRequest[] }): {
  edit: SchematicEdit;
  wired: Array<{ from: string; to: string; points: Array<[number, number]> }>;
} {
  if (!input.wires.length) throw new SchematicOpError("INVALID", "No wires to draw.");
  const b = new EditBuilder(readSheet(input.doc));
  const end = (e: string | Point): WireEnd =>
    typeof e === "string" ? pinEnd(b, e) : { at: [snap(e[0]), snap(e[1])], name: `(${fmt(snap(e[0]))}, ${fmt(snap(e[1]))})` };
  const wired = input.wires.map((w) => {
    const [a, z] = [end(w.from), end(w.to)];
    if (samePoint(a.at, z.at)) throw new SchematicOpError("INVALID", `${a.name} and ${z.name} are the same point.`);
    return { from: a.name, to: z.name, points: wireBetween(b, a, z) };
  });
  return { edit: b.edit(`Wire ${wired.map((w) => `${w.from} to ${w.to}`).join(", ")}`), wired };
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

/**
 * `box` grown by the part's own text (`texts`, 0009 §3.5) and by the labels
 * `nets` will put on its pins, each facing away from the body (a power symbol
 * takes about as much): parts placed with their nets are not packed so close
 * that their labels run into each other.
 */
function withLabelRoom(box: Box, def: Form, angle: Angle, mirror: Mirror, nets: Record<string, string> | undefined, texts: Box[] = []): Box {
  const room = { ...box };
  const grow = (t: Box) => {
    room.minX = Math.min(room.minX, t.minX);
    room.minY = Math.min(room.minY, t.minY);
    room.maxX = Math.max(room.maxX, t.maxX);
    room.maxY = Math.max(room.maxY, t.maxY);
  };
  texts.forEach(grow);
  if (!nets) return room;
  const pins = pinPositions(def, [0, 0], angle, mirror);
  for (const [which, net] of Object.entries(nets)) {
    const pin = pins.find((p) => p.number === which) ?? pins.find((p) => p.name === which);
    if (!pin || !net) continue;
    grow(textBox(pin.at, outwardAngle(pin.toward), net));
  }
  return room;
}

/**
 * Where a part placed with `nets` should start looking for room: beyond the end
 * of a label already on the sheet for one of its nets, the way that label
 * faces. Power nets are everywhere, so they do not count. None: undefined.
 */
function netAnchor(b: EditBuilder, nets: Record<string, string> | undefined): Point | undefined {
  for (const net of Object.values(nets ?? {})) {
    if (!net || isPowerNetName(net)) continue;
    const label = b.sheet.labels.find((l) => !b.removed.has(l.uuid) && l.name === net);
    if (!label) continue;
    const t = textBox(label.at, label.angle, label.name);
    const gap = 2 * STUB;
    switch (normalizeAngle(label.angle)) {
      case 0:
        return [t.maxX + gap, label.at[1]];
      case 180:
        return [t.minX - gap, label.at[1]];
      case 90:
        return [label.at[0], t.minY - gap];
      default:
        return [label.at[0], t.maxY + gap];
    }
  }
  return undefined;
}

/** A reference prefix from a definition's Reference field: `R`, `U`, `#PWR`. */
const refPrefix = (def: Form): string => (prop(def, "Reference") ?? "U").replace(/[?\d]+$/, "") || "U";

/**
 * The pin that goes on top, for a part drawn upright by convention (0009 §3.3,
 * §3.4): a capacitor between a supply and ground (supply up), a resistor
 * between a supply and a signal (a pull-up: supply up) or between ground and a
 * signal (a pull-down: ground down). Anything else: undefined.
 */
function topPin(def: Form, nets: Record<string, string> | undefined): string | undefined {
  const entries = Object.entries(nets ?? {});
  if (entries.length !== 2) return undefined;
  const supply = entries.find(([, n]) => isSupplyNet(n));
  const ground = entries.find(([, n]) => isGroundNet(n));
  const signal = entries.find(([, n]) => !isPowerNetName(n));
  const prefix = refPrefix(def);
  if (prefix === "C" && supply && ground) return supply[0];
  if (prefix === "R" && supply && signal) return supply[0];
  if (prefix === "R" && ground && signal) return signal[0];
  return undefined;
}

/** The angle that stands a two-pin part upright with `top` (a pin number or name) up; undefined when it has none. */
function uprightAngle(def: Form, top: string, mirror: Mirror): Angle | undefined {
  for (const angle of [0, 180, 90, 270] as const) {
    const pins = pinPositions(def, [0, 0], angle, mirror);
    if (pins.length !== 2) return undefined;
    const t = pins.find((p) => p.number === top) ?? pins.find((p) => p.name === top);
    const o = pins.find((p) => p !== t);
    if (t && o && Math.abs(t.at[0] - o.at[0]) < 1e-6 && t.at[1] < o.at[1]) return angle;
  }
  return undefined;
}

/**
 * Where a decoupling capacitor starts looking for room (0009 §3.3): just out
 * from a chip's power input pin on its supply, the `near` part's first, else
 * the first with no capacitor close. Not a capacitor between a supply and
 * ground, or no such pin: undefined.
 */
function decouplingAnchor(b: EditBuilder, def: Form, nets: Record<string, string> | undefined, near: string | undefined): Point | undefined {
  const names = Object.values(nets ?? {});
  const supply = names.find(isSupplyNet);
  if (refPrefix(def) !== "C" || names.length !== 2 || !supply || !names.some(isGroundNet)) return undefined;
  const live = b.sheet.symbols.filter((s) => !s.power && !b.removed.has(s.uuid));
  const isCap = (s: PlacedSymbol) => /^C\d/.test(s.ref);
  const wanted = near?.trim().toLowerCase();
  const first = (s: PlacedSymbol) => Number(s.ref.toLowerCase() === wanted);
  const chips = live.filter((s) => !isCap(s)).sort((x, y) => first(y) - first(x) || compareRefs(x.ref, y.ref));
  const pins = chips.flatMap((s) => s.pins.filter((p) => p.type === "power_in" && pinNets(b, p).includes(supply)));
  const capped = (p: SheetPin) => live.some((c) => isCap(c) && c.pins.some((q) => Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1]) < 12.7));
  const pin = pins.find((p) => !capped(p)) ?? pins[0];
  return pin && [pin.at[0] - pin.toward[0] * 2 * STUB, pin.at[1] - pin.toward[1] * 2 * STUB];
}

/**
 * Where a pull-up or pull-down starts looking for room (0009 §3.4): above (a
 * pull-up) or below the label of the signal it pulls, `room` clear of it. Not
 * a pull resistor, or no such label: undefined.
 */
function pullAnchor(b: EditBuilder, def: Form, nets: Record<string, string> | undefined, room: Box): Point | undefined {
  const entries = Object.entries(nets ?? {});
  if (refPrefix(def) !== "R" || entries.length !== 2) return undefined;
  const rail = entries.find(([, n]) => isSupplyNet(n) || isGroundNet(n));
  const signal = entries.find(([, n]) => !isPowerNetName(n));
  if (!rail || !signal) return undefined;
  const label = b.sheet.labels.find((l) => !b.removed.has(l.uuid) && l.name === signal[1]);
  if (!label) return undefined;
  const t = textBox(label.at, label.angle, label.name);
  const x = (t.minX + t.maxX) / 2;
  return isSupplyNet(rail[1]) ? [x, t.minY - 2 * STUB - room.maxY] : [x, t.maxY + 2 * STUB - room.minY];
}

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
    checkLibId(libId);
    const def = part.def ?? b.sheet.defs.get(libId);
    if (!def) throw new SchematicOpError("NO_DEFINITION", `The sheet does not embed ${libId}; get it from the library first.`);
    b.embed(libId, def);
    const mirror = part.mirror ?? "";
    // A decoupling capacitor, a pull-up or a pull-down stands upright, supply on top, unless turned on purpose (0009 §3.3, §3.4).
    const top = part.angle === undefined ? topPin(def, part.nets) : undefined;
    const angle = top === undefined ? normalizeAngle(part.angle ?? 0) : (uprightAngle(def, top, mirror) ?? 0);
    const box = symbolBox(def, angle, mirror);
    const value = part.value === undefined ? undefined : cleanText(part.value, "value");
    const footprint = part.footprint === undefined ? undefined : cleanText(part.footprint, "footprint", 200, true);
    for (const [field, text] of [["Value", value], ["Footprint", footprint]] as const) {
      const problem = text === undefined ? null : fieldValueProblem(field, text);
      if (problem) throw new SchematicOpError("INVALID", problem);
    }
    // A "#" reference is virtual in KiCad (no BOM, no board): only a power symbol may have one.
    if (refPrefix(def).startsWith("#") && !isPowerDef(def)) {
      throw new SchematicOpError("INVALID", `${libId} is not a power symbol, but its reference starts with "#": KiCad would leave it off the board.`);
    }
    const ref = b.nextRef(refPrefix(def));
    const texts = (pos: Point) => defTextBoxes(def, pos, angle, mirror, { Reference: ref, Value: value, Footprint: footprint });
    // The room it needs: its body, its text, and the labels its nets will put on its pins (0008 §2.4, 0009 §3.5).
    const room = withLabelRoom(box, def, angle, mirror, part.nets, texts([0, 0]));
    // A decoupling capacitor beside its chip's power pin, a pull-up above its signal (0009 §3.3, §3.4); else
    // next to where its nets already are, on the side their labels face (0008 §2.5); else next to `near`.
    const anchor = decouplingAnchor(b, def, part.nets, part.near) ?? pullAnchor(b, def, part.nets, room) ?? netAnchor(b, part.nets);
    let at: [number, number];
    if (part.at) {
      at = [snap(part.at[0]), snap(part.at[1])];
    } else if (anchor) {
      at = freeSpot(b.boxes, room, { near: anchor });
    } else if (part.near) {
      at = freeSpot(b.boxes, room, { near: findSymbol(b.sheet, part.near).at });
    } else {
      at = freeSpot(b.boxes, room, { rowY: middleY });
    }
    const uuid = newUuid();
    b.upsert(uuid, symbolForm({ libId, def, ref, value, footprint, at, angle, mirror, uuid }, b.sheet.instance));
    b.boxes.push(offsetBox(box, at));
    b.setTexts(uuid, texts(at));
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
  const { lib, item } = checkLibId(input.libId);
  const value = input.value === undefined ? undefined : cleanText(input.value, "value");
  const footprint = input.footprint === undefined ? undefined : cleanText(input.footprint, "footprint", 200, true);
  // The same field rules as placePartEdit: a click placement is the other way in (ai-chat 0006 S4).
  for (const [field, text] of [["Value", value], ["Footprint", footprint]] as const) {
    const problem = text === undefined ? null : fieldValueProblem(field, text);
    if (problem) throw new SchematicOpError("INVALID", problem);
  }
  return buildSymbolClipboard(input.def, lib, item, input.uuid ?? newUuid(), { value, footprint });
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
    // Links KiCad would open in the editor's origin, and text it would expand first (ai-chat 0006 S4).
    const problem = name === "Reference" ? null : fieldValueProblem(name, value);
    if (problem) throw new SchematicOpError("INVALID", problem);
    if (name === "Reference") {
      // ASCII letters, digits and `_ + - . ?`: no spaces, quotes or lookalikes (Update PCB's report
      // quotes names, and an odd reference makes every line of it asked).
      if (!REFERENCE.test(value)) {
        throw new SchematicOpError("INVALID", `A reference is letters, digits and _ + - . ? only, no spaces or quotes (got ${JSON.stringify(value)}).`);
      }
      // KiCad treats "#" references as virtual: left out of the BOM and the board.
      if (value.startsWith("#") && !symbol.power) throw new SchematicOpError("INVALID", `Only power symbols have references starting with "#" (got "${value}").`);
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
 * Wires on its pins are re-routed from their new ends (`rerouted` counts them), so the
 * part stays connected; a power stub is drawn again.
 */
export function movePartEdit(input: { doc: KicadDoc; moves: MovePart[] }): {
  edit: SchematicEdit;
  moved: Array<{ ref: string; at: [number, number]; angle: Angle; followed: number; rerouted: number }>;
} {
  if (!input.moves.length) throw new SchematicOpError("INVALID", "Nothing to move.");
  const sheet = readSheet(input.doc);
  const b = new EditBuilder(sheet);
  const ctx: ConnectContext = { b, powerDefs: {} };
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
    b.setTexts(symbol.uuid, placedTextBoxes(form, angle, mirror));

    let followed = 0;
    let rerouted = 0;
    if (symbol.def) {
      const after = pinPositions(symbol.def, at, angle, mirror, symbol.unit);
      // The sheet view takes the part's new place first: what is drawn again below keeps off it.
      const pinsBefore = symbol.pins;
      Object.assign(symbol, { form, at, angle, mirror, pins: after });
      b.boxes.push(offsetBox(symbolBox(symbol.def, angle, mirror, symbol.unit), at));
      for (const before of pinsBefore) {
        const now = after.find((p) => p.number === before.number);
        if (!now || samePoint(now.at, before.at)) continue;
        for (const l of sheet.labels) {
          if (!samePoint(l.at, before.at)) continue;
          const la = outwardAngle(now.toward);
          b.upsert(l.uuid, relabel(renderForm(sheet.doc, l.uuid), now.at, la));
          Object.assign(l, { at: now.at, angle: la });
          followed++;
        }
        for (const n of sheet.noConnects) {
          if (!samePoint(n.at, before.at)) continue;
          b.upsert(n.uuid, noConnectForm(now.at, n.uuid));
          n.at = now.at;
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
          b.setTexts(s.uuid, placedTextBoxes(f, place.angle, ""));
          Object.assign(s, { form: f, at: place.at, angle: place.angle, pins: pinPositions(s.def, place.at, place.angle) });
          followed++;
        }
        // A stubbed power symbol or label (0003 step 5c, 0008 §2.3) is drawn again from the
        // pin's new end: its way out may have turned, and the old spot may be taken.
        const stub = stubOf(b, before.at);
        if (stub) {
          for (const uuid of stub.wires) b.remove(uuid);
          const name = `${symbol.ref}.${now.number}`;
          for (const s of sheet.symbols.filter((x) => x.power && x.def && !b.removed.has(x.uuid) && x.pins.some((p) => samePoint(p.at, stub.end)))) {
            b.remove(s.uuid);
            ctx.powerDefs[s.value] = { libId: s.libId, def: s.def! };
            attachPin(ctx, now, name, { net: s.value }, symbol.uuid);
          }
          for (const l of sheet.labels.filter((x) => !b.removed.has(x.uuid) && samePoint(x.at, stub.end))) {
            b.remove(l.uuid);
            attachPin(ctx, now, name, { net: l.name, labelKind: l.kind === "global_label" ? "global_label" : "label" }, symbol.uuid);
          }
          followed++;
        }
        // Wires on the pin: re-routed from its new end, so the part stays connected. KiCad's
        // Move would leave them behind; this is its Drag. Through a part only when nothing else works.
        const leave: Point = [-now.toward[0], -now.toward[1]];
        for (const w of sheet.wires.filter((x) => !b.removed.has(x.uuid) && (samePoint(x.a, before.at) || samePoint(x.b, before.at)))) {
          const other = samePoint(w.a, before.at) ? w.b : w.a;
          b.remove(w.uuid);
          try {
            wireBetween(b, { at: now.at, leave, name: `${symbol.ref}.${now.number}` }, { at: other, name: "wire" }, { throughBodies: true, redraw: true });
          } catch (error) {
            if (!(error instanceof SchematicOpError && error.code === "NO_ROUTE")) throw error;
            throw new SchematicOpError(
              "NO_ROUTE",
              `Moving ${symbol.ref} there leaves no clean wire from its pin ${now.number} to (${fmt(other[0])}, ${fmt(other[1])}): every way touches another pin. Move it elsewhere, or connect that pin with a net name.`,
            );
          }
          rerouted++;
        }
      }
    }
    return { ref: symbol.ref, at, angle, followed, rerouted };
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

// ── Layout check ─────────────────────────────────────────────────────────────

export interface LayoutIssue {
  /**
   * `wire_crosses_part`: a wire through a part's body; `wire_touches_pin`: a pin end on a wire's middle,
   * which joins it (0008 §2.6). `long_wire`: a run of new wire longer than 38.1 mm, between `items`;
   * `four_way_junction`: four lines meeting at one dot; `text_overlap`: a value, reference or other
   * field text on something (0009 §3).
   */
  issue: "overlap" | "off_grid" | "wire_crosses_part" | "wire_touches_pin" | "long_wire" | "four_way_junction" | "text_overlap";
  /** What is involved: `R5`, `label SDA`, `+5V symbol`, `wire`, `R5 Value`, `R5.1`. */
  items: string[];
  at: [number, number];
  /** A `long_wire`'s length. */
  mm?: number;
}

/**
 * What an edit made untidy (ai-chat 0003 step 5c): the parts, power symbols
 * and labels it added or moved that overlap another one, or sit off the
 * 1.27 mm grid. Text a model acts on more reliably than a picture, and cheap
 * enough for every edit. Overlaps that were there before the edit stay out.
 */
export function layoutIssues(doc: KicadDoc, edit: SchematicEdit, max = 10): LayoutIssue[] {
  /** `ends`: a part's pin ends; `touch`: where a label or power symbol connects. */
  type Thing = { uuid: string; name: string; box: Box; at: [number, number]; ends: Point[]; touch: Point[] };
  const things = (sheet: Sheet): Thing[] => [
    ...sheet.symbols.flatMap((s): Thing[] =>
      s.def
        ? [
            {
              uuid: s.uuid,
              name: s.power ? `${s.value} symbol` : s.ref,
              box: offsetBox(symbolBox(s.def, s.angle, s.mirror, s.unit), s.at),
              at: s.at,
              ends: s.power ? [] : s.pins.map((p) => p.at),
              touch: s.power ? s.pins.map((p) => p.at) : [],
            },
          ]
        : [],
    ),
    ...sheet.labels.map((l): Thing => ({ uuid: l.uuid, name: `label ${l.name}`, box: textBox(l.at, l.angle, l.name), at: l.at, ends: [], touch: [l.at] })),
  ];
  const before = new Map(things(readSheet(doc)).map((t) => [t.uuid, JSON.stringify(t.box)]));
  const sheetAfter = readSheet(applySchematicEdit(doc, edit));
  const after = things(sheetAfter);
  const changed = after.filter((t) => before.get(t.uuid) !== JSON.stringify(t.box));
  // A label or power symbol on a part's own pin (or on its stub) sits against the part by design:
  // that pair is not an overlap, though their boxes may meet (an LED's light arrows, say).
  const wired = (p: Point, q: Point) => sheetAfter.wires.some((w) => (samePoint(w.a, p) && samePoint(w.b, q)) || (samePoint(w.a, q) && samePoint(w.b, p)));
  const attached = (part: Thing, deco: Thing) => part.ends.some((e) => deco.touch.some((t) => samePoint(e, t) || wired(e, t)));
  // Touching edges (a label on its pin end, at the part's outline) is not overlapping.
  const inset = (box: Box): Box => ({ minX: box.minX + 0.1, minY: box.minY + 0.1, maxX: box.maxX - 0.1, maxY: box.maxY - 0.1 });
  const meet = (p: Box, q: Box) => p.minX < q.maxX && q.minX < p.maxX && p.minY < q.maxY && q.minY < p.maxY;
  const off = (v: number) => Math.abs(v / GRID - Math.round(v / GRID)) > 1e-3;
  const issues: LayoutIssue[] = [];
  const seen = new Set<string>();
  for (const t of changed) {
    if (off(t.at[0]) || off(t.at[1])) issues.push({ issue: "off_grid", items: [t.name], at: t.at });
    for (const u of after) {
      if (u.uuid === t.uuid || !meet(inset(t.box), inset(u.box)) || attached(t, u) || attached(u, t)) continue;
      const pair = [t.uuid, u.uuid].sort().join();
      if (seen.has(pair)) continue;
      seen.add(pair);
      issues.push({ issue: "overlap", items: [t.name, u.name], at: t.at });
    }
  }
  // Wires the edit drew or moved (ai-chat 0008 §2.6): through a part, or over a pin end.
  const sheetBefore = readSheet(doc);
  const wiresBefore = new Map(sheetBefore.wires.map((w) => [w.uuid, key(w.a) + key(w.b)]));
  const parts = sheetAfter.symbols.filter((s) => !s.power && s.def);
  const fresh = sheetAfter.wires.filter((x) => wiresBefore.get(x.uuid) !== key(x.a) + key(x.b));
  // A wire leaving one of the part's own pin ends outward does not cross it, whatever of the
  // part sticks out beside that pin (an LED's light arrows).
  const leavesPinOf = (w: SheetWire, s: PlacedSymbol) =>
    s.pins.some((p) =>
      [
        [w.a, w.b],
        [w.b, w.a],
      ].some(([from, to]) => samePoint(from!, p.at) && Math.sign(to![0] - from![0]) === -p.toward[0] && Math.sign(to![1] - from![1]) === -p.toward[1]),
    );
  for (const w of fresh) {
    for (const s of parts) {
      if (hitsBox(w.a, w.b, offsetBox(symbolBox(s.def!, s.angle, s.mirror, s.unit), s.at)) && !leavesPinOf(w, s)) {
        issues.push({ issue: "wire_crosses_part", items: ["wire", s.ref], at: w.a });
      }
      for (const p of s.pins) {
        if (onSegmentInterior(p.at, w.a, w.b)) issues.push({ issue: "wire_touches_pin", items: ["wire", `${s.ref}.${p.number}`], at: p.at });
      }
    }
  }

  // Field text (0009 §3.5): text the edit placed or moved on something, or something it placed on text.
  type Text = { owner: string; key: string; name: string; box: Box };
  const textsOf = (sheet: Sheet): Text[] =>
    sheet.symbols.flatMap((s) =>
      fieldTexts(s.form).map((f) => ({
        owner: s.uuid,
        key: `${s.uuid}/${f.name}`,
        name: s.power ? `${s.value} symbol` : `${s.ref} ${f.name}`,
        box: fieldTextBox(f, f.at, s.angle, s.mirror),
      })),
    );
  const textBefore = new Map(textsOf(sheetBefore).map((t) => [t.key, JSON.stringify(t.box)]));
  const texts = textsOf(sheetAfter);
  const textMoved = (t: Text) => textBefore.get(t.key) !== JSON.stringify(t.box);
  const thingMoved = new Set(changed.map((t) => t.uuid));
  const textIssue = (t: Text, other: string, otherKey: string) => {
    const pair = [t.key, otherKey].sort().join();
    if (seen.has(pair)) return;
    seen.add(pair);
    issues.push({ issue: "text_overlap", items: [t.name, other], at: [round4((t.box.minX + t.box.maxX) / 2), round4((t.box.minY + t.box.maxY) / 2)] });
  };
  for (const t of texts) {
    const mine = inset(t.box);
    for (const u of after) {
      if (u.uuid !== t.owner && (textMoved(t) || thingMoved.has(u.uuid)) && meet(mine, inset(u.box))) textIssue(t, u.name, u.uuid);
    }
    for (const v of texts) {
      if (v.owner !== t.owner && (textMoved(t) || textMoved(v)) && meet(mine, inset(v.box))) textIssue(t, v.name, v.key);
    }
    for (const w of fresh) if (hitsBox(w.a, w.b, t.box)) textIssue(t, "wire", w.uuid);
  }

  // What sits on a point: pin ends (power symbols' too), or a label.
  const pinNames = (p: Point) => sheetAfter.symbols.flatMap((s) => s.pins.filter((q) => samePoint(q.at, p)).map((q) => (s.power ? `${s.value} symbol` : `${s.ref}.${q.number}`)));
  const nameAt = (p: Point) => {
    const label = sheetAfter.labels.find((l) => samePoint(l.at, p));
    return pinNames(p)[0] ?? (label ? `label ${label.name}` : `(${fmt(p[0])}, ${fmt(p[1])})`);
  };

  // Four lines at one dot (0009 §3.2), where the edit drew a wire or put a part.
  const touched = new Map<string, Point>();
  for (const w of fresh) for (const p of [w.a, w.b]) touched.set(key(p), p);
  for (const s of sheetAfter.symbols) if (thingMoved.has(s.uuid)) for (const p of s.pins) touched.set(key(p.at), p.at);
  for (const p of touched.values()) {
    const ends = sheetAfter.wires.filter((w) => samePoint(w.a, p) || samePoint(w.b, p)).length;
    const through = sheetAfter.wires.filter((w) => onSegmentInterior(p, w.a, w.b)).length;
    if (ends > 0 && ends + 2 * through + pinNames(p).length >= 4) issues.push({ issue: "four_way_junction", items: [nameAt(p)], at: [p[0], p[1]] });
  }

  // Long runs of new wire (0009 §3.1): a net name on both ends reads better. A run goes on through
  // plain bends (two of its wires, nothing else) and stops at anything else.
  const freshIds = new Set(fresh.map((w) => w.uuid));
  const freshAt = (p: Point) => fresh.filter((w) => samePoint(w.a, p) || samePoint(w.b, p));
  const plainBend = (p: Point) =>
    freshAt(p).length === 2 &&
    !sheetAfter.wires.some((w) => !freshIds.has(w.uuid) && (samePoint(w.a, p) || samePoint(w.b, p) || onSegmentInterior(p, w.a, w.b))) &&
    !pinNames(p).length &&
    !sheetAfter.labels.some((l) => samePoint(l.at, p)) &&
    !sheetAfter.junctions.some((j) => samePoint(j.at, p));
  const done = new Set<string>();
  for (const w of fresh) {
    if (done.has(w.uuid)) continue;
    done.add(w.uuid);
    let mm = 0;
    const ends: Point[] = [];
    for (const stack = [w]; stack.length; ) {
      const x = stack.pop()!;
      mm += Math.hypot(x.a[0] - x.b[0], x.a[1] - x.b[1]);
      for (const p of [x.a, x.b]) {
        if (!plainBend(p)) {
          ends.push(p);
          continue;
        }
        for (const y of freshAt(p).filter((y) => !done.has(y.uuid))) {
          done.add(y.uuid);
          stack.push(y);
        }
      }
    }
    if (mm > LONG_WIRE + 1e-6) issues.push({ issue: "long_wire", items: ends.slice(0, 2).map(nameAt), at: [(ends[0] ?? w.a)[0], (ends[0] ?? w.a)[1]], mm: Math.round(mm) });
  }
  return issues.slice(0, max);
}
