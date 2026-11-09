/**
 * The shapes an agent's schematic edits travel in: an edit for the open editor to
 * apply as one KiCad commit, and KiCad's netlist as nets. Types only.
 */

export interface SchematicEdit {
  /** A short description, e.g. for the undo menu. */
  label: string;
  upsert: { sexpr: string }[];
  remove: string[];
  /** Library definitions the sheet lacks, by lib id, each a `(symbol "<lib id>" …)`. */
  libSymbols: Record<string, string>;
}

export interface NetlistNet {
  /** KiCad's net name: `/SDA` (a local label on the root sheet), `+3V3`, `Net-(R1-Pad1)`, … */
  net: string;
  pins: Array<{ ref: string; pin: string; name?: string; type?: string }>;
}
