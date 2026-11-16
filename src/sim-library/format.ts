// The part file format of the simulation library, version 1 (simulation 0004).
//
// A part is DATA: a description (part.json), a SPICE subcircuit (the analog half) and, for a
// chip that runs code, a WebAssembly module or an emulator (the digital half). It names the
// overlay widgets it wants; the widgets themselves live in the app.
//
// These types say what a part.json may hold. The library's publish step is the judge: it
// also checks the things a type cannot say (the pins are the subcircuit's pins, and so on).
// A change that old readers cannot ignore gets a higher `schema` number.

export const PART_SCHEMA = 1;
export const INDEX_SCHEMA = 1;
export const POINTER_SCHEMA = 1;

/**
 * How the part's pins find the symbol's pins: "number" (the part's pin names are the symbol's
 * pin numbers, the default), "name" (they are the symbol's pin names), or a table
 * { part pin: symbol pin number }.
 */
export type PinStyle = "number" | "name" | Record<string, string>;

/** One line of "fits": a symbol ("Library:Name", * and ? allowed), a value, or both. */
export interface PartFit {
  symbol?: string;
  value?: string;
  pins?: PinStyle;
}

/** Something the user may change on a placed part. Its value goes into the SPICE deck. */
export interface PartSetting {
  name: string;
  label?: string;
  unit?: string;
  default: string;
  /** The values that are allowed, as a list ... */
  options?: string[];
  /** ... or as a pattern the whole value must match. One of the two is required. */
  accept?: string;
  /** The symbol's Value field sets this setting when it passes the rule above. */
  fromValue?: boolean;
  /**
   * Other ways the symbol's Value can say this setting, tried in order when the Value itself
   * is not an allowed value: a pattern over the Value, and the setting's value it stands for
   * ("$1", "$2" are the pattern's groups). For a Zener diode "BZX84C5V1" stands for 5.1.
   * Only with `fromValue`.
   */
  valueForms?: { match: string; value: string }[];
}

export interface PartAnalog {
  file: string;
  subckt: string;
  /** Subcircuit parameter -> a fixed text, or "$name" for the setting of that name. */
  params?: Record<string, string>;
}

/**
 * A value the user sets while the simulation runs. `source` is a voltage source in the
 * subcircuit. Three kinds: held down (a push button), a value in a range (a knob), and one
 * that stays where it was put (a switch).
 */
export type PartInput =
  | { name: string; type: "momentary"; source: string; released: number; held: number }
  | { name: string; type: "range"; source: string; min: number; max: number; default: number }
  | { name: string; type: "toggle"; source: string; off: number; on: number; default: "off" | "on" };

/** A value the overlay shows: the current through a voltage source in the subcircuit. */
export interface PartSignal {
  name: string;
  current: string;
}

/** Our own code, compiled to WebAssembly when the library is published. */
export interface DigitalWasm {
  kind: "part-wasm";
  file: string;
  abi: 1;
  source: string;
  language: "c" | "verilog";
  orderParam: string;
}

/** A chip emulator the library carries, running the user's firmware. */
export interface DigitalEmulator {
  kind: "emulator";
  emulator: string;
  chip: string;
  cores?: 1 | 2;
  /** Part pin -> GPIO number. */
  pads: Record<string, number>;
  enable?: string;
  padRegisters?: { base: number; count: number; pullUpBit: number; pullDownBit: number };
  orderParam: string;
}

export type PartDigital = DigitalWasm | DigitalEmulator;

/** One widget on the schematic. Other keys are the widget's own options; "$name" reads a setting. */
export interface OverlayEntry {
  widget: string;
  place: Record<string, unknown>;
  input?: string;
  signal?: string;
  signals?: string[];
  [option: string]: unknown;
}

export interface PartManifest {
  schema: 1;
  id: string;
  version: number;
  title: string;
  description?: string;
  fits: PartFit[];
  pins: string[];
  /**
   * The pins on which this part is a source of power (a battery: both). A supply wire on
   * such a pin has its power from the part, so it is not powered by its name.
   */
  supplies?: string[];
  settings?: PartSetting[];
  analog: PartAnalog;
  digital?: PartDigital;
  inputs?: PartInput[];
  signals?: PartSignal[];
  overlay?: OverlayEntry[];
}

/** A published file: its name inside the part's folder, its checksum and its size. */
export interface IndexFile {
  name: string;
  sha256: string;
  bytes: number;
}

/** A part as the index lists it: enough to match symbols without loading the part. */
export interface IndexPart {
  id: string;
  version: number;
  title: string;
  description: string;
  fits: PartFit[];
  pins: string[];
  /** True when the part has a digital half. */
  code: boolean;
  emulator?: string;
  files: IndexFile[];
}

export interface IndexEmulator {
  id: string;
  version: string;
  title: string;
  licence: string;
  origin: string;
  files: IndexFile[];
}

/** <snapshot>/index.json */
export interface LibraryIndex {
  schema: 1;
  version: string;
  parts: IndexPart[];
  emulators: IndexEmulator[];
}

/** current.json: which snapshot is the current one. */
export interface LibraryPointer {
  schema: 1;
  version: string;
}

/** A snapshot is named after a checksum of everything in it: 12 hex digits. */
export const SNAPSHOT_NAME = /^[0-9a-f]{12}$/;
