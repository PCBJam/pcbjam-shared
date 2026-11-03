/**
 * Font uploads into a team library (fonts 0002), shared by the library page and the
 * editor's team fonts panel: which picked files to send, and how a font's faces and
 * license read in a list. The server reads each file again and has the last word.
 */
import type { FontFace } from "./schemas.js";

/** File names a font item may have (the server's rule). */
export const FONT_FILE_NAME = /\.(ttf|otf|ttc|otc)$/i;

/** Same cap as the item route and the runner's library bodies. */
export const MAX_FONT_FILE_BYTES = 32 * 1024 * 1024;

/** The free licenses a public library takes, as the font list names them. */
export const FREE_FONT_LICENSE_NAMES: Record<string, string> = {
  OFL: "SIL Open Font License",
  "Apache-2.0": "Apache License 2.0",
  UFL: "Ubuntu Font Licence",
};

/** The free license every face states, or null (none, another, or mixed). */
export function fontFacesLicense(faces: readonly FontFace[]): string | null {
  const ids = new Set(faces.map((f) => f.license?.id ?? null));
  if (ids.size !== 1) return null;
  const [id] = [...ids];
  return id ? (FREE_FONT_LICENSE_NAMES[id] ?? id) : null;
}

/** "Noto Sans" + "Regular, Bold" from a font file's faces (several in a collection). */
export function fontFacesLabel(faces: readonly FontFace[], fileName: string): { family: string; styles: string } {
  if (faces.length === 0) return { family: fileName.slice(fileName.lastIndexOf("/") + 1), styles: "" };
  return {
    family: [...new Set(faces.map((f) => f.family))].join(", "),
    styles: [...new Set(faces.map((f) => f.style))].join(", "),
  };
}

/** A picked file (a browser File). */
export interface PickedFontFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** What a pick would do, before anything is sent. */
export interface FontUploadPlan<F extends PickedFontFile = PickedFontFile> {
  add: Array<{ file: F; name: string }>;
  /** Same name, other content: replaced only when the user says so. */
  replace: Array<{ file: F; name: string }>;
  /** Same name, same content: nothing to do. */
  same: string[];
  /** Not sent: too large. */
  refused: Array<{ name: string; reason: string }>;
}

async function sha256Hex(file: PickedFontFile): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Sort picked files against the fonts the library already holds. Files that are not
 * fonts by name are left out (a picked folder holds other files too); a folder pick is
 * flattened to file names.
 */
export async function planFontUpload<F extends PickedFontFile>(
  files: readonly F[],
  existing: ReadonlyArray<{ name: string; sha256: string | null }>,
): Promise<FontUploadPlan<F>> {
  const have = new Map(existing.map((i) => [i.name, i.sha256]));
  const plan: FontUploadPlan<F> = { add: [], replace: [], same: [], refused: [] };
  const seen = new Set<string>();
  for (const file of files) {
    const name = file.name;
    if (!FONT_FILE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    if (file.size > MAX_FONT_FILE_BYTES) plan.refused.push({ name, reason: "larger than 32 MB" });
    else if (!have.has(name)) plan.add.push({ file, name });
    else if (have.get(name) === (await sha256Hex(file))) plan.same.push(name);
    else plan.replace.push({ file, name });
  }
  return plan;
}

/** The reason in an item route refusal ("<name>: <reason>"), without the file name. */
export function fontRefusalReason(name: string, message: string | null | undefined, status?: number): string {
  if (!message) return `upload failed${status ? ` (${status})` : ""}`;
  return message.startsWith(`${name}: `) ? message.slice(name.length + 2) : message;
}
