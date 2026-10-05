import { z } from "zod";
import { kicadProjectChoicesSchema } from "./kicad-project/fab-profile.js";

/**
 * `pcbjam.lock.json` (git-integration 0003, design-libraries §6, L-D4): a
 * DESCRIPTIVE record, written by pcbjam at the project root on every export
 * (and, later, at commit), of which library revisions the design used.
 * Never hand-edited; read on import and zip update to relink bundled
 * libraries to their pcbjam ids (L-D13). The runtime keeps serving latest —
 * enforcement is designed for, not implemented.
 *
 * MIT wire so the GPL example backend can read it; the writer, the estimate
 * and the relink live in the closed core.
 */

export const LOCKFILE_NAME = "pcbjam.lock.json";
export const LOCKFILE_VERSION = 1;

export const lockfileKindSchema = z.enum(["symbol", "footprint", "model"]);
export type LockfileKind = z.infer<typeof lockfileKindSchema>;

/** `false` = not bundled; `used-items` = a SUBSET, never the whole library. */
export const lockfileBundledSchema = z.union([z.literal(false), z.literal("used-items"), z.literal("whole")]);
export type LockfileBundled = z.infer<typeof lockfileBundledSchema>;

export const lockfileLibSchema = z.object({
  /** The mounted nickname the design files name (`Device`). */
  nickname: z.string().min(1),
  kinds: z.array(lockfileKindSchema),
  /** The pcbjam library id (uuid). */
  libId: z.string().min(1),
  type: z.enum(["origin", "mirror", "team"]),
  /** `sha256:<hex>` tree hash of the revision used, or null when unknown. */
  revision: z.string().nullable(),
  /** Origin provenance: where the snapshot came from. */
  source: z
    .object({
      provenance: z.string().optional(),
      repoUrl: z.string().optional(),
      /** Upstream ref, e.g. `kicad-symbols@10.0.3`. */
      ref: z.string().optional(),
    })
    .optional(),
  /** Mirrors: the origin they overlay and the owning scope. */
  originLibId: z.string().optional(),
  overlayScopeId: z.string().optional(),
  /** Lib-git connection (git-integration 0008), when one exists. */
  git: z
    .object({
      repoUrl: z.string(),
      ref: z.string(),
      subdir: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
  bundled: lockfileBundledSchema,
  /** Path of the bundled library FOLDER relative to the project root (`libs/Device`). */
  path: z.string().optional(),
  /** Bundled item names per kind (used-items grain) — what a re-import may update. */
  items: z.record(lockfileKindSchema, z.array(z.string())).optional(),
  /** SPDX-ish license of the data, for the notices. */
  license: z.string().nullable().optional(),
});
export type LockfileLib = z.infer<typeof lockfileLibSchema>;

/**
 * What generated a KiCad project (new-kicad-project 0001): the fab profile,
 * its version and the dialog choices, so a later "re-apply / switch fab" knows
 * where the rules came from. Unlike `libs` this can't be rebuilt from the
 * registry, so every lockfile writer carries the section over.
 */
export const lockfileKicadProjectSchema = z.object({
  profile: z.string().min(1),
  profileVersion: z.number().int().positive(),
  choices: kicadProjectChoicesSchema,
  /** ISO timestamp of the generation. */
  generatedAt: z.string(),
});
export type LockfileKicadProject = z.infer<typeof lockfileKicadProjectSchema>;

export const lockfileSchema = z.object({
  version: z.literal(LOCKFILE_VERSION),
  /** ISO timestamp of the export. */
  generatedAt: z.string(),
  /** The exporting project (uuid), informational. */
  projectId: z.string().optional(),
  libs: z.array(lockfileLibSchema),
  /** Keyed by the `.kicad_pro` path relative to the lockfile. Optional, so v1 readers still parse. */
  kicadProjects: z.record(z.string(), lockfileKicadProjectSchema).optional(),
});
export type Lockfile = z.infer<typeof lockfileSchema>;

/** Parse a lockfile's bytes; null when it is not a v1 lockfile. */
export function parseLockfile(text: string): Lockfile | null {
  try {
    const parsed = lockfileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The `kicadProjects` section of an existing lockfile's text, for writers that
 * regenerate `libs` (export, Git snapshot). Tolerates a lockfile whose `libs`
 * no longer parse: the section is read on its own.
 */
export function carriedKicadProjects(text: string | null | undefined): Lockfile["kicadProjects"] {
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as { kicadProjects?: unknown };
    const parsed = z.record(z.string(), lockfileKicadProjectSchema).safeParse(raw?.kicadProjects);
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Stable serialization (2-space JSON, trailing newline) — Git-diff friendly. */
export function serializeLockfile(lock: Lockfile): string {
  return JSON.stringify(lock, null, 2) + "\n";
}

/** The library folder a portable export uses for a nickname. */
export function bundledLibDir(nickname: string): string {
  return `libs/${nickname}`;
}
