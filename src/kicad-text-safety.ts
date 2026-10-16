/**
 * What text from outside (an AI agent, a library someone else wrote) may put into
 * a schematic's fields (ai-chat 0006 S4, S21). KiCad opens a Datasheet, and any field
 * whose text holds a web link, in a new window of the editor's origin; before that it
 * expands text variables (`${VAR}`, `$(VAR)`, `@{expr}`) and its escapes (`{colon}`,
 * `{dollar}`), so a value that looks harmless can open as `javascript:`. The editor's
 * `openUrl` (wx.js) is the boundary; these rules keep agents and libraries from
 * writing such links in the first place.
 */

/** Text KiCad expands or unescapes before it shows or opens it. */
const EXPANDS = /\$\{|\$\(|@\{|\{[A-Za-z_]+\}/;
/** One web link: http(s) and URL characters only (no spaces, quotes, braces or `$`). */
const WEB_LINK = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!&'()*+,;=%]+$/i;
/** KiCad's link to a file embedded in the project. */
const EMBED_LINK = /^kicad-embed:\/\/[A-Za-z0-9 _\-.()+,/]+$/;
/** A project file, relative and plain. */
const PLAIN_PATH = /^[A-Za-z0-9 _\-.()+,]+(?:\/[A-Za-z0-9 _\-.()+,]+)*$/;

/** A Datasheet KiCad may open: nothing, `~`, a web link, an embedded file or a project file. */
export function datasheetOk(value: string): boolean {
  if (value === "" || value === "~") return true;
  if (WEB_LINK.test(value) || EMBED_LINK.test(value)) return true;
  return PLAIN_PATH.test(value) && !value.split("/").some((s) => s === "." || s === "..");
}

/**
 * Why `value` may not go into the field `name`, or null. A field that holds a link is
 * a link as a whole (KiCad opens its whole text), so it must be one web link.
 */
export function fieldValueProblem(name: string, value: string): string | null {
  if (EXPANDS.test(value)) return `KiCad would expand or unescape ${JSON.stringify(value.slice(0, 40))}; write the text itself.`;
  if (name.toLowerCase() === "datasheet") {
    return datasheetOk(value) ? null : `A Datasheet is a web link (http or https), a kicad-embed:// link or a project file path, not ${JSON.stringify(value.slice(0, 40))}.`;
  }
  if (name.toLowerCase() === "sim.library") return "Sim.Library is not set from here: it names a file KiCad opens.";
  if (/:\/\//.test(value) && !WEB_LINK.test(value)) return "A field with a link holds just that one web link (http or https).";
  return null;
}

/**
 * A library field's value as a placed part gets it: a Datasheet KiCad should not open
 * becomes `~`, and another field holding a link that is not a plain web link, or
 * starting with a script scheme, is left empty. Library text comes from whoever wrote
 * the library.
 */
export function safeLibraryField(name: string, value: string): string {
  if (name.toLowerCase() === "datasheet") return datasheetOk(value) && !EXPANDS.test(value) ? value : "~";
  if (/^\s*(javascript|data|vbscript|file):/i.test(value)) return "";
  if (/:\/\//.test(value) && !WEB_LINK.test(value)) return "";
  return value;
}

/**
 * Characters that make text look like other text: format characters (zero-width,
 * bidi overrides; ZWJ and ZWNJ are kept, writing needs them), line and paragraph
 * separators, and blanks that render as nothing (Hangul fillers, the combining
 * grapheme joiner, the blank braille pattern).
 */
export const INVISIBLE = /(?![‌‍])\p{Cf}|[\p{Zl}\p{Zp}͏ᅟᅠ⠀ㅤﾠ]/u;

/** In a name (a net, a label) also: any space but the plain one, ZWJ/ZWNJ, variation selectors. */
export const NAME_LOOKALIKE = /[^\S ]|[‌‍︀-️]|[\u{E0100}-\u{E01EF}]/u;

/** A reference: ASCII letters, digits and `_ + - . ?`, after a `#` on power symbols only. */
export const REFERENCE = /^#?[A-Za-z0-9_+\-.?]+$/;
