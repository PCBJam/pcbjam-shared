import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { directUuid, type SNode } from "../src/sexpr.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Auto-discovered real-KiCad fixture root (see fixtures/kicad/PROVENANCE.md). */
export const FIXTURES = path.join(here, "fixtures", "kicad");

const KICAD_EXT = /\.(kicad_pcb|kicad_sch|kicad_wks|kicad_sym)$/;

/** Recursively collect every KiCad file under `dir` (drop a file in → tested). */
export function listFixtures(dir: string = FIXTURES): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFixtures(full));
    else if (KICAD_EXT.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/** Every uuid that appears as a direct (uuid "X") child of a list node, anywhere. */
export function allUuids(node: SNode, acc: Set<string> = new Set()): Set<string> {
  if (!Array.isArray(node)) return acc;
  const id = directUuid(node);
  if (id !== null) acc.add(id);
  for (const c of node) allUuids(c, acc);
  return acc;
}
