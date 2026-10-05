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

/*
 * One lockfile per KiCad project folder (git-integration 0018, revising
 * L-D4): `pcbjam.lock.json` sits next to its `.kicad_pro`, lists only that
 * KiCad project's libraries and template records, and keys the records by
 * file name relative to its own folder, so any subtree checkout is whole.
 */

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** True for a lockfile at any depth (`pcbjam.lock.json`, `b/pcbjam.lock.json`). */
export function isLockfilePath(path: string): boolean {
  return baseOf(path) === LOCKFILE_NAME;
}

/** The lockfile of a folder (`""` = the root). */
export function lockfilePathFor(dir: string): string {
  return dir ? `${dir}/${LOCKFILE_NAME}` : LOCKFILE_NAME;
}

/** The folder a lockfile describes. */
export function lockfileDirOf(lockPath: string): string {
  return dirOf(lockPath);
}

/** Folders holding a `.kicad_pro` — each owns one lockfile. Sorted, unique. */
export function lockfileOwnerDirs(paths: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const p of paths) if (p.endsWith(".kicad_pro")) dirs.add(dirOf(p));
  return [...dirs].sort();
}

/**
 * The KiCad project folder a file belongs to: the nearest folder at or above
 * it that holds a `.kicad_pro`. Null for a file under no KiCad project.
 */
export function ownerDirOf(path: string, ownerDirs: readonly string[]): string | null {
  const owners = new Set(ownerDirs);
  let dir = dirOf(path);
  for (;;) {
    if (owners.has(dir)) return dir;
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

type KicadProjects = NonNullable<Lockfile["kicadProjects"]>;

/**
 * A lockfile's template records keyed by `.kicad_pro` path from the project
 * root. Current keys are file names in the lock's folder; a key with a slash
 * is a pre-0018 root-relative key and is taken as is.
 */
export function kicadProjectsByPath(lockDir: string, records: Lockfile["kicadProjects"]): KicadProjects {
  const out: KicadProjects = {};
  for (const [key, rec] of Object.entries(records ?? {})) {
    const abs = key.includes("/") ? key : lockDir ? `${lockDir}/${key}` : key;
    out[abs] = rec;
  }
  return out;
}

/** The records of the `.kicad_pro` files directly in `dir`, keyed by file name; undefined when none. */
export function kicadProjectsForDir(dir: string, byPath: KicadProjects): Lockfile["kicadProjects"] {
  const out: KicadProjects = {};
  for (const [abs, rec] of Object.entries(byPath)) if (dirOf(abs) === dir) out[baseOf(abs)] = rec;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Every lockfile of an archive or tree read as one, for the readers (relink,
 * zip update): bundled `path`s become root-relative, a library listed by
 * several folders appears once (a bundled entry wins), and template records
 * are keyed from the root.
 */
export function mergeLockfiles(locks: ReadonlyArray<{ path: string; lock: Lockfile }>): Lockfile | null {
  if (!locks.length) return null;
  const sorted = [...locks].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const libs: Lockfile["libs"] = [];
  const at = new Map<string, number>();
  let kicadProjects: KicadProjects = {};
  for (const { path, lock } of sorted) {
    const dir = lockfileDirOf(path);
    for (const lib of lock.libs) {
      const entry = lib.path && dir ? { ...lib, path: `${dir}/${lib.path}` } : lib;
      const seen = at.get(lib.libId);
      if (seen === undefined) {
        at.set(lib.libId, libs.length);
        libs.push(entry);
      } else if (!libs[seen]?.path && entry.path) {
        libs[seen] = entry;
      }
    }
    kicadProjects = { ...kicadProjects, ...kicadProjectsByPath(dir, lock.kicadProjects) };
  }
  const first = sorted[0]!.lock;
  return {
    version: LOCKFILE_VERSION,
    generatedAt: first.generatedAt,
    ...(first.projectId ? { projectId: first.projectId } : {}),
    libs,
    ...(Object.keys(kicadProjects).length ? { kicadProjects } : {}),
  };
}

/** Stable serialization (2-space JSON, trailing newline) — Git-diff friendly. */
export function serializeLockfile(lock: Lockfile): string {
  return JSON.stringify(lock, null, 2) + "\n";
}

/** The library folder a portable export uses for a nickname. */
export function bundledLibDir(nickname: string): string {
  return `libs/${nickname}`;
}
