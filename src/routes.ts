// The shared scope/kind/name URL grammar + tool inference. Used by the GPL
// standalone editor, the closed management app, and the closed apps so every
// surface BUILDS and PARSES the same URLs. Generic — no ownership/auth here.
//
//   /:scope/projects/:name                      project overview
//   /:scope/projects/:name/<path/to/file.ext>   open a file (tool inferred)
//   /:scope/projects/:name/-/:tool              fileless/scratch tool boot
//   /:scope/libs/:name                          open a library (tool from kind)
//
// The `-/` segment (TOOL_SEGMENT) separates a tool name from a file path, so a
// path that begins with it is a tool boot, not a file. Scope/name are slugs
// (see scopeSlugSchema / libNameSchema) and are interpolated verbatim; only the
// free-form file path is percent-encoded per segment.

import {
  EXTENSION_TOOL,
  LIB_EXTENSION_TOOL,
  type Tool,
  toolSchema,
} from "./schemas.js";

/** The literal segment that introduces a fileless tool boot in a project URL. */
export const TOOL_SEGMENT = "-";

export type ResourceKind = "projects" | "libs";

/** Lowercased file extension incl. the dot, e.g. ".kicad_pcb"; "" if none. */
export function fileExt(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

// Gerber/drill artifacts have many extensions and all open in the gerber viewer.
const GERBER_EXTS: ReadonlySet<string> = new Set([
  ".gbr", ".gbl", ".gtl", ".gbo", ".gto", ".gbs", ".gts", ".gbp", ".gtp",
  ".gko", ".gm1", ".gm2", ".gpt", ".gpb", ".drl", ".xln", ".nc", ".gerber",
]);

/**
 * The tool that opens a document file, inferred from its extension; null if no
 * tool claims it (caller falls back to the project overview). The explicit
 * `?tool=` query param, when present, always wins over this.
 */
export function toolForFile(path: string): Tool | null {
  const ext = fileExt(path);
  const t = EXTENSION_TOOL[ext];
  if (t) return t;
  if (GERBER_EXTS.has(ext)) return "gerbview";
  return null;
}

/** The library file extensions whose editor is inferred (.kicad_sym/.kicad_mod). */
export function toolForLibFile(path: string): Tool | null {
  return LIB_EXTENSION_TOOL[fileExt(path)] ?? null;
}

/** The editor that opens a library of a given item kind. */
export function toolForLibKind(kind: string): Tool {
  return kind === "footprint" ? "footprint_editor" : "symbol_editor";
}

/** Parse a `?tool=` value into a Tool, or null when absent/invalid. */
export function parseToolParam(value: string | null | undefined): Tool | null {
  if (!value) return null;
  const r = toolSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** Findings W-2: scope/name come back DECODED from the router (`%2F` → `/`),
 *  so interpolating them verbatim lets `/%2Fevil.com/projects/x` build a
 *  scheme-relative `//evil.com/…` navigation. Slugs (`[a-z0-9._-]`, optional
 *  leading `@`) are unchanged by encodeURIComponent. */
function encSeg(segment: string): string {
  // `@` (reserved virtual scopes like `@local`) is kept readable; it cannot
  // form a scheme-relative or path-escaping segment.
  return encodeURIComponent(segment).replace(/%40/g, "@");
}

function encPath(filePath: string): string {
  return filePath
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

/** `/:scope/projects/:name` (+ optional deep-linked file path). */
export function projectPath(
  scope: string,
  name: string,
  filePath?: string,
): string {
  const base = `/${encSeg(scope)}/projects/${encSeg(name)}`;
  const rel = filePath ? encPath(filePath) : "";
  return rel ? `${base}/${rel}` : base;
}

/** `/:scope/projects/:name/-/:tool` — a fileless/scratch tool in a project. */
export function projectToolPath(
  scope: string,
  name: string,
  tool: Tool,
): string {
  return `/${encSeg(scope)}/projects/${encSeg(name)}/${TOOL_SEGMENT}/${tool}`;
}

/** `/:scope/libs/:name` — open a library in its kind-appropriate editor. */
export function libPath(scope: string, name: string): string {
  return `/${encSeg(scope)}/libs/${encSeg(name)}`;
}

/**
 * Interpret the splat (everything after `/:scope/projects/:name/`) as either a
 * fileless tool boot (`-/<tool>`) or a file path to open. Returns a discriminated
 * result the editor's ToolPage can switch on. An empty splat ⇒ project overview.
 */
export function parseProjectTarget(
  splat: string | undefined,
):
  | { kind: "overview" }
  | { kind: "tool"; tool: Tool }
  | { kind: "file"; filePath: string; tool: Tool | null } {
  const s = (splat ?? "").replace(/^\/+/, "");
  if (s.length === 0) return { kind: "overview" };
  if (s === TOOL_SEGMENT || s.startsWith(`${TOOL_SEGMENT}/`)) {
    const rest = s.slice(TOOL_SEGMENT.length).replace(/^\/+/, "");
    const tool = parseToolParam(rest);
    // An unknown tool name falls back to the overview rather than 404-ing.
    return tool ? { kind: "tool", tool } : { kind: "overview" };
  }
  return { kind: "file", filePath: s, tool: toolForFile(s) };
}
