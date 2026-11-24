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
  /**
   * Where the part's overlay sits on this symbol: a point of the symbol's own drawing (mm,
   * Y up) that the overlay's places are measured from. Left out: the symbol's origin. For a
   * part that fits symbols which draw the same thing at different spots (the digit of a
   * 7-segment display).
   */
  origin?: [number, number];
  /**
   * The part's settings as this symbol has them: { setting: value }. One part stands for
   * a family of types, and the symbol's name says which (an op-amp: how close its output
   * gets to the supply). It comes after the part's default and before the symbol's Value
   * and the settings field.
   */
  set?: Record<string, string>;
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
  /**
   * The symbol's Value field sets this setting when it passes the rule above. When several
   * settings say so, the Value as it is goes to the first that allows it; the others can
   * only be read out of it by their `valueForms`.
   */
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
  /**
   * "gear": a live run with this part is computed by Gear's method. For a model that
   * switches hard inside (an op-amp that hits its limits): at the step ceiling of a live run
   * the usual method (trapezoidal) rings, and a circuit that flips by itself then flips
   * early. Left out: the usual method.
   */
  method?: "gear";
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
  /** The chip's clock in Hz, for an emulator that has to be told (an AVR chip on a board with a crystal). */
  clock?: number;
  /** Part pin -> GPIO number. */
  pads: Record<string, number>;
  enable?: string;
  padRegisters?: { base: number; count: number; pullUpBit: number; pullDownBit: number };
  /**
   * The voltages the chip's program may ask the engine for (an analog input, the supply, a
   * reference pin), by the names the emulator's adapter knows them by, in the order of the
   * inputs of the model's voltage tap (a `pj_vtap` line). Left out: the chip measures nothing.
   */
  taps?: string[];
  orderParam: string;
}

export type PartDigital = DigitalWasm | DigitalEmulator;

/**
 * A contact that moves, as a line of the symbol's own drawing (x0, y0, x1, y1 in mm, Y up):
 * where it is while the input is off (a button: released) and while it is on (held).
 */
export interface OverlayLine {
  off: [number, number, number, number];
  on: [number, number, number, number];
}

/** What a part can do with heat: give it off, be as warm as its wire, move air. */
export type ThermalRole = "heat" | "temperature" | "air";

/**
 * What a part does with heat (thermal.ts). Heat is drawn as a circuit: on a wire that
 * carries heat 1 V is 1 degree Celsius and 1 A is 1 W. A part with this has thermal pins,
 * which the user joins to such wires by naming them on the symbol. A part without it has
 * nothing to do with heat. A part may be several of the three.
 */
export interface PartThermal {
  /**
   * The part is as warm as the wire its thermal pin is on: the name of a range input
   * that is its temperature in degrees Celsius. On a wire the input is not the user's
   * any more, and the part's widgets for it are left out.
   */
  temperature?: string;
  /**
   * The part gives off heat into the wire its thermal pin is on: the name of a signal
   * that is that heat, in watts.
   */
  heat?: string;
  /**
   * The part moves air between the wires its two air pins are on: a signal that is 1 at
   * its full speed, and how much heat the air carries then, in watts for every degree
   * the one wire is warmer than the other (a number as text, or "$name" for a setting).
   */
  air?: { signal: string; full: string };
  /**
   * Widgets the part has only while it is on its wires, after its own. With a thermal
   * pin for its own temperature they may show the signal "wire" too: the temperature
   * of that pin's wire in degrees Celsius.
   */
  overlay?: OverlayEntry[];
}

/** One widget on the schematic. Other keys are the widget's own options; "$name" reads a setting. */
export interface OverlayEntry {
  widget: string;
  place: Record<string, unknown>;
  input?: string;
  signal?: string;
  signals?: string[];
  /**
   * A zone only (press-zone, toggle-zone): the contacts that move with it. The zone draws
   * each where it is now, so a changeover switch shows which way it is thrown.
   */
  lines?: OverlayLine[];
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
  /**
   * The pins through which the part takes the power it passes on (a regulator: its input).
   * Only with `supplies`. Such a part is a source only when a source of the schematic
   * reaches one of these pins: a battery, a voltage source, a wire powered by its name or
   * another such part, on the pin's wire or behind parts that are not chips (a switch, a
   * diode, a resistor). When none does, the part gives nothing: the wires on `supplies` are
   * powered by their names as if the part were not there, and the run says so.
   */
  suppliesFrom?: string[];
  /**
   * The pins a symbol may lack: the pins of a unit that is not placed (one half of a dual
   * op-amp). Such a pin is left open. A pin that is not listed here and has no pin of the
   * symbol refuses the part.
   */
  mayLack?: string[];
  /**
   * The pins the part takes its power through. With nothing connected to one of them the
   * part does nothing, and the run says so.
   */
  powered?: string[];
  /**
   * Pins that are one net inside the part: a board's three ground pins, an Arduino's A4 and
   * its SDA pin. The model joins them. Where a rule asks whether a pin has something
   * connected (`powered`, the wired pads of a chip), a wire on any pin of its group counts.
   */
  joined?: string[][];
  settings?: PartSetting[];
  analog: PartAnalog;
  digital?: PartDigital;
  inputs?: PartInput[];
  signals?: PartSignal[];
  overlay?: OverlayEntry[];
  thermal?: PartThermal;
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
  /** The pins a symbol may lack (see PartManifest). */
  mayLack?: string[];
  /** True when the part has a digital half. */
  code: boolean;
  /** The emulator a chip part runs its firmware in (an id of `LibraryIndex.emulators`). */
  emulator?: string;
  /** What the part does with heat (see PartThermal). Missing: nothing. */
  thermal?: ThermalRole[];
  files: IndexFile[];
}

/**
 * A chip emulator the library carries: somebody else's program that runs the user's firmware.
 * Its files sit beside the snapshots, at emulators/<id>/<version>/<file>, and are pinned by
 * their checksums here; a new release is a new version, decided by us.
 */
export interface IndexEmulator {
  id: string;
  version: string;
  title: string;
  licence: string;
  origin: string;
  /** Which of its files is the emulator itself, a WebAssembly module. Left out when the emulator is all JavaScript. */
  program?: string;
  /** Which of its files is the JavaScript that loads the program, or that is the emulator. */
  loader: string;
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
