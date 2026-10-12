/**
 * Team-library path variables (libs 0020). A library authored in a Git folder
 * gets one KiCad path variable, `${<NICK>_DIR}`, pointing at the library's
 * root folder. Footprints reference their 3D models and symbols their
 * datasheets through it (`${MYPARTS_DIR}/3d/sot23.step`), so the same refs
 * resolve in pcbjam and in desktop KiCad once the variable is set there.
 */

/** The path variable name for a library file nickname: `My-Parts` → `MY_PARTS_DIR`. */
export function libPathVar(nickname: string): string {
  const base = nickname
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || "LIB"}_DIR`;
}

/** The default models folder of a library, relative to its root. */
export function defaultModelsDir(nickname: string): string {
  return `${nickname}.3dshapes`;
}

/** `${VAR}/rest` → { pathVar, rest }; null when the ref is not a variable ref. */
export function parseLibVarRef(ref: string): { pathVar: string; rest: string } | null {
  const m = /^\$[{(]([A-Za-z0-9_]+)[})][/\\]*(.+)$/.exec(ref.trim());
  if (!m) return null;
  return { pathVar: m[1]!, rest: m[2]!.replace(/\\/g, "/") };
}

/** A library-variable ref for a file at `relPath` under the library root. */
export function libVarRef(pathVar: string, relPath: string): string {
  return `\${${pathVar}}/${relPath.replace(/^\/+/, "")}`;
}

/**
 * The model item name for a path relative to the library root, or null when
 * the path is outside the models folder. Item names keep sub-folders
 * (`sub/x.step`) relative to the models folder.
 */
export function modelItemNameFor(relPath: string, modelsDir: string): string | null {
  const dir = modelsDir.replace(/^\/+|\/+$/g, "");
  const p = relPath.replace(/^\/+/, "");
  if (!dir) return p || null;
  return p.startsWith(`${dir}/`) && p.length > dir.length + 1 ? p.slice(dir.length + 1) : null;
}
