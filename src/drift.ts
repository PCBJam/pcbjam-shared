/**
 * Drift records (ysync) — the wire shapes for reporting and reading a detected
 * divergence between a doc's Y.Doc representation and what the WASM editor would
 * actually serialize on save. The REPORT body is a generic protocol (the GPL
 * editor posts it without the closed contract); how a backend stores/lists
 * drifts is its own (non-shared) concern — only these shapes are shared.
 */
import { z } from "zod";
import { kicadDeltaSchema } from "./kicad-delta.js";
import { kicadDocSchema } from "./kicad-doc.js";

/**
 * What the editor posts when it detects a drift: the POSIX doc path plus both
 * full `KicadDoc` representations (the one the WASM save produced and the one
 * read from the Y.Doc) and the item-level diff between them. `layoutChanged` /
 * `metaChanged` cover divergence the item diff doesn't (layout order, preamble).
 */
export const driftReportBody = z.object({
  docPath: z.string(),
  wasmDoc: kicadDocSchema,
  ydocDoc: kicadDocSchema,
  diff: kicadDeltaSchema,
  layoutChanged: z.boolean().optional(),
  metaChanged: z.boolean().optional(),
  /** The Y.Doc's s-expr encoding version (`ydocSexprVersion`) — triage aid:
   *  the materialized `KicadDoc`s above are version-blind, so this is the only
   *  place a report says which storage encoding the doc actually used. */
  sexprVersion: z.number().int().positive().optional(),
});
export type DriftReportBody = z.infer<typeof driftReportBody>;

/** A drift as it appears in a listing — index + summary counts, no payloads. */
export const driftSummary = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  docPath: z.string(),
  addedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  layoutChanged: z.boolean(),
  metaChanged: z.boolean(),
  /** Null when the report predates version tracking (or an old client). */
  sexprVersion: z.number().int().nullable(),
  createdAt: z.string(),
});
export type DriftSummary = z.infer<typeof driftSummary>;

/** A single drift with its full payloads, for the detail view. */
export const driftDetail = driftSummary.extend({
  wasmDoc: kicadDocSchema,
  ydocDoc: kicadDocSchema,
  diff: kicadDeltaSchema,
});
export type DriftDetail = z.infer<typeof driftDetail>;
