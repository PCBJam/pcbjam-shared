/**
 * zod schemas for the JSON exchanged with the KiCad WASM collab bridge — the
 * wasm "from-to" wire data of `kicadCollabSnapshot()` / `kicadCollabApply(json)` /
 * `window.kicadCollab.onDelta(json)` (the contract defined by features/yjs-bridge
 * 0001 §3 and implemented in `pcbjam/wasm/bindings/*_embind.cpp`).
 *
 * Schema-agnostic by design: an item is `{ id, type, …arbitrary fields }`; the
 * delta arrays may be omitted by an emitter and are defaulted to `[]` on parse.
 *
 * Licensing note (checked): these schemas describe a JSON wire format authored in
 * this project — they contain no KiCad (GPL) code, and describing the interface of
 * a GPL program is not a derivative work. The GPL standalone depending on this MIT
 * lib is the safe direction. The rules to keep are: never copy GPL source into
 * shared, and (separately) the GPL editor never imports the CLOSED contract.
 */

import { z } from "zod";

export const collabItemSchema = z
  .object({
    /** Item uuid (KIID). */
    id: z.string(),
    /** Item kind as the bridge names it (e.g. "text", "segment", "SCH_LINE"). */
    type: z.string(),
  })
  .catchall(z.unknown());
export type CollabItem = z.infer<typeof collabItemSchema>;

export const collabDeltaSchema = z.object({
  added: z.array(collabItemSchema).default([]),
  changed: z.array(collabItemSchema).default([]),
  /** uuids. */
  removed: z.array(z.string()).default([]),
});
export type CollabDelta = z.infer<typeof collabDeltaSchema>;

export function emptyCollabDelta(): CollabDelta {
  return { added: [], changed: [], removed: [] };
}

export function isEmptyCollabDelta(d: CollabDelta): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

/** Parse a bridge JSON string into a validated delta; throws on malformed input. */
export function parseCollabDelta(json: string): CollabDelta {
  return collabDeltaSchema.parse(JSON.parse(json));
}
