import type { SNode } from '../../src/sexpr';

/**
 * Fields that can name a file on the person's machine or project: a SPICE model library
 * (`Sim.Library`, KiCad ≤ 6's `Spice_Lib_File`), any simulation field KiCad doesn't define as
 * inert, and anything called a model, include, path or file. KiCad reads such a file when the
 * person simulates. A placed part arrives without them: its inert simulation fields
 * (`Sim.Device`, `Sim.Type`, `Sim.Pins`, `Sim.Params`, `Sim.Name`, `Sim.Enable`) stay, so it
 * still simulates with KiCad's built-in models.
 */
const INERT_SIM = /^sim\.(?:device|type|pins|params|name|enable)$/i;
const NAMES_FILE = /^(?:simulation|include|model|path|file|spice_lib_file$)/i;
export const namesFile = (name: string): boolean => NAMES_FILE.test(name) || (/^sim\./i.test(name) && !INERT_SIM.test(name));

type Form = SNode[];
const isProperty = (node: SNode): node is Form => Array.isArray(node) && node[0] === 'property';
/** `(property "Name" …)` or KiCad 9/10's `(property private "Name" …)`. */
const nameSlot = (node: Form) => (node[1] === 'private' ? 2 : 1);
const unquoted = (atom: SNode | undefined) => (typeof atom === 'string' && atom.startsWith('"') && atom.endsWith('"') ? atom.slice(1, -1).replace(/\\(["\\])/g, '$1') : '');

/**
 * The forms without their file references, at any depth: those properties dropped (and a
 * `Sim.Name`, which only names a model inside the dropped library). With `footprints`, a
 * Footprint value that isn't a plain `Library:Name` is blanked, so the part places with no
 * footprint instead of being refused.
 */
export function stripFileReferences(node: SNode, opts: { footprints?: boolean } = {}): SNode {
  if (!Array.isArray(node)) return node;
  const names = node.filter(isProperty).map((p) => unquoted(p[nameSlot(p)]));
  const droppedLibrary = names.some((n) => /^sim\.library$/i.test(n));
  const kept: SNode[] = [];
  for (const child of node) {
    if (isProperty(child)) {
      const slot = nameSlot(child);
      const name = unquoted(child[slot]);
      if (namesFile(name) || (droppedLibrary && /^sim\.name$/i.test(name))) continue;
      if (opts.footprints && name === 'Footprint' && !/^[A-Za-z0-9_.:+ -]*$/.test(unquoted(child[slot + 1]))) {
        kept.push([...child.slice(0, slot + 1), '""', ...child.slice(slot + 2)]);
        continue;
      }
    }
    kept.push(stripFileReferences(child, opts));
  }
  return kept;
}
