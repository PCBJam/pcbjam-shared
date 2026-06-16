import { z } from "zod";

/** WASM tools that can be selected by the `:tool` URL segment. */
export const TOOLS = [
  "pcbnew",
  "eeschema",
  "calculator",
  "pl_editor",
  "symbol_editor",
  "footprint_editor",
  "gerbview",
] as const;
export const toolSchema = z.enum(TOOLS);
export type Tool = z.infer<typeof toolSchema>;

/** Human-readable labels for tools (UI links, status text). */
export const TOOL_LABELS: Record<Tool, string> = {
  pcbnew: "PCB Editor",
  eeschema: "Schematic Editor",
  calculator: "PCB Calculator",
  pl_editor: "Drawing Sheet Editor",
  symbol_editor: "Symbol Editor",
  footprint_editor: "Footprint Editor",
  gerbview: "Gerber Viewer",
};

/** Default file-extension → tool mapping (the explicit URL segment always wins). */
export const EXTENSION_TOOL: Record<string, Tool> = {
  ".kicad_pcb": "pcbnew",
  ".kicad_sch": "eeschema",
  ".kicad_wks": "pl_editor",
};

/**
 * Library-file extension → the editor that opens it scoped to that lib. Unlike
 * EXTENSION_TOOL (document files opened into the tool), these are LIBRARY files:
 * the editor browses the file's contents through the lib bridge, not File→Open.
 */
export const LIB_EXTENSION_TOOL: Record<string, Tool> = {
  ".kicad_sym": "symbol_editor",
  ".kicad_mod": "footprint_editor",
};

/**
 * Tools that do not take a file (booted standalone). The calculator has no file
 * concept; the symbol editor opens libraries through its own UI (its frame does
 * not implement OpenProjectFiles), so we boot it standalone rather than auto-open.
 * The gerber viewer likewise opens gerber/drill files through its own File→Open
 * UI — projects carry no gerber files to auto-open — so it boots standalone too.
 * The footprint editor is the same: no project board/schematic file to auto-open;
 * it edits libraries (via the fp-lib-table) through its own UI. It is still
 * project-scoped (routed under /p/:project/ with a Prj()) — "fileless" here only
 * means no auto-open, not "no project".
 */
export const FILELESS_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "calculator",
  "symbol_editor",
  "footprint_editor",
  "gerbview",
]);

export const projectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "slug must start alphanumeric and contain only lowercase letters, digits, '.', '_', '-'",
  );

/**
 * A project as seen by the wasm-frontend. This is the minimal shape a backend
 * must return; ownership / multi-tenancy fields are intentionally NOT part of
 * the shared contract (they live in the closed application layer).
 */
export const projectSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectFileSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  /** POSIX project-relative path, e.g. "pcbnew/nyak.kicad_pcb". */
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // --- collaborative-state overlay (optional; a backend MAY surface it) ---
  /** A persisted Y.Doc (`.ydoc`) exists for this file (collaboratively edited). */
  hasYdoc: z.boolean().optional(),
  /** Size of the `.ydoc` blob, when present. */
  ydocSize: z.number().int().nonnegative().optional(),
  /** A room for this file is open right now (someone is editing live). */
  isLive: z.boolean().optional(),
  /** max(file updatedAt, ydoc last-modified), ISO 8601 — for "last changed". */
  lastChanged: z.string().optional(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export const projectWithFiles = z.object({
  project: projectSchema,
  files: z.array(projectFileSchema),
});
export type ProjectWithFiles = z.infer<typeof projectWithFiles>;

export const errorBody = z.object({ message: z.string() });
export type ErrorBody = z.infer<typeof errorBody>;

// --- libraries (symbol/footprint libs served to the editor) ---
// The read surface a backend exposes so the editor can enumerate libraries,
// list their items, and fetch a single self-contained item body. How a backend
// stores or composes libs (origins, per-user mirrors, merge) is its own concern;
// only this read shape is shared. Item BODIES are streamed text (a complete
// `kicad_symbol_lib` s-expr) over a raw route, NOT a ts-rest endpoint:
//   GET /api/libs/:lib/items/:kind/:name
// (same reasoning as file-byte download). The editor's WASM lib plugin fetches
// it directly; a conforming backend MUST expose it.

/**
 * One library as the editor sees it. `id` is the opaque token used in the
 * `/mnt/pcbjam/<id>` lib-table URI (a name for the example backend, a uuid for
 * the registry-backed one); `name` is the display nickname.
 */
export const libSchema = z.object({
  id: z.string(),
  name: z.string(),
  // 'origin' | 'mirror' | 'user'
  type: z.string(),
  description: z.string().nullish(),
  itemCount: z.number().int().nonnegative().optional(),
});
export type Lib = z.infer<typeof libSchema>;

/** One item (symbol/footprint/3D model) in a library's listing. */
export const libItemSchema = z.object({
  // 'symbol' | 'footprint' | 'model3d'
  kind: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  keywords: z.string().nullish(),
});
export type LibItem = z.infer<typeof libItemSchema>;

// --- library WRITE protocol (0004: user-defined libs, the first write path) ---
// Unlike project management (createProject etc., which live in the closed app
// contract), the lib write protocol is shared: the open build (GPL standalone +
// example backend) must round-trip create-a-lib + save-an-item end-to-end. How a
// backend stores/scopes user libs (registry+R2 + per-user owner in the closed
// server; plain files in the example backend) is its own concern — only this
// wire shape is shared.

/**
 * Header carrying the (thin, pre-auth) per-user owner identity on lib requests.
 * A backend scopes user libs to this owner; absent ⇒ the backend's default
 * owner. Real auth replaces it later without reshaping the protocol.
 */
export const OWNER_HEADER = "x-pcbjam-owner";

/**
 * Header carrying the current project id on lib requests. A backend MAY use it
 * to scope or compose lib resolution per project, so collaborators on a shared
 * project resolve identically; the minimal reference backend ignores it. Absent
 * ⇒ unscoped resolution.
 */
export const PROJECT_HEADER = "x-pcbjam-project";

/** Body for creating a user library (owner comes from `OWNER_HEADER`). */
export const createLibBody = z.object({
  name: z.string().min(1).max(200),
});
export type CreateLibBody = z.infer<typeof createLibBody>;

// --- collaboration (Yjs network sync) ---
// The contract between the editor and ANY Yjs sync backend (the closed PartyKit
// server, or an OSS Hocuspocus one). Only the wire-level naming/handshake lives
// here; how a backend persists or authorizes is its own (non-shared) concern.

/**
 * Identifies one collaboratively edited document — a board/schematic — within a
 * project. Both the editor (to pick a room to connect to) and the backend (to
 * namespace + persist that room) derive it the same way so they never drift.
 * `projectId` is a uuid and `docPath` is a POSIX project-relative path.
 */
export const collabRoomIdSchema = z.string().min(1);
export function collabRoomId(projectId: string, docPath: string): string {
  return `${projectId}:${docPath}`;
}

/**
 * Connection params a Yjs provider sends to the sync backend (query string).
 * `token` is the (thin, for now) auth credential; backends MAY require it.
 */
export const collabConnectParams = z.object({
  token: z.string().optional(),
});
export type CollabConnectParams = z.infer<typeof collabConnectParams>;

/**
 * Make a `docPath` safe to embed in an R2 key while preserving its POSIX shape
 * (slashes kept, `..` collapsed, leading slashes dropped, exotic chars folded).
 */
function sanitizeDocPath(docPath: string): string {
  return docPath
    .replace(/\.\.+/g, ".")
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._/-]/g, "_");
}

/**
 * R2 key of a room's persisted Yjs state, beside its raw file under the flat
 * `projects/<projectId>/` prefix (no owner segment — derivable from `projectId`
 * alone, which is all the sync worker knows). Both the sync server (persist) and
 * the app server (materialize/list) compute it identically so they never drift.
 * e.g. `projects/<uuid>/pcbnew/board.kicad_pcb.ydoc`.
 */
export function collabDocKey(projectId: string, docPath: string): string {
  return `projects/${projectId}/${sanitizeDocPath(docPath)}.ydoc`;
}

/**
 * R2 key of a room's liveness marker (a tiny blob the sync DO writes while the
 * room has connections, deletes when empty). The app server checks for it to
 * decide whether to fetch live Y state from the sync worker — without it, a cold
 * Durable Object is never woken. Sits beside the `.ydoc` blob.
 */
export function collabLiveKey(projectId: string, docPath: string): string {
  return `projects/${projectId}/${sanitizeDocPath(docPath)}.live`;
}
