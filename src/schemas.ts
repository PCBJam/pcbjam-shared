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

/** A library name is a slug within its scope (same shape as a project slug). */
export const libNameSchema = projectSlugSchema;

/**
 * A scope is the first URL segment — a neutral namespace (user, org, team, …)
 * that owns projects and libs, GitHub-like (`scope/kind/name`). Reserved virtual
 * scopes carry a leading `@` (e.g. `@local` = browser-local content); ordinary
 * scopes are bare slugs. Reserved/blocklisted names are enforced by the backend.
 */
export const scopeSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^@?[a-z0-9][a-z0-9._-]*$/,
    "scope must be a slug (lowercase alphanumeric, '.', '_', '-'), optionally '@'-prefixed for a reserved virtual scope",
  );

/** Reserved system scopes (never handed out as user/org slugs). */
export const KICAD_SCOPE = "kicad";
export const DEMO_SCOPE = "demo";
/** Global home of user-triggered URL ingests (community-imported origin libs). */
export const COMMUNITY_SCOPE = "community";
/** Browser-local (IndexedDB) content in standalone/demo; never hits a backend. */
export const LOCAL_SCOPE = "@local";

/**
 * A project as seen by the wasm-frontend. `scope` is the owning namespace — now
 * part of the shared identity because it appears in every URL (`scope/projects/
 * slug`). Membership/auth still live in the closed application layer; `scope` is
 * just the addressable namespace slug.
 */
export const projectSchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  /**
   * Stable id of the owning scope (the `scope` slug can be renamed; this can't).
   * Feeds team-scoped collab room ids / storage keys ({@link collabRoomId}).
   * Optional on the wire so scope-less backends (the GPL example backend,
   * `@local`) stay conforming; backends with real scopes SHOULD send it.
   */
  scopeId: z.string().optional(),
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
  /**
   * Set when the backend's validation of the last uploaded content failed
   * (e.g. not parseable as KiCad). A flagged file is still served as-is, but
   * the backend MAY refuse collaborative sessions on it. How validation is
   * performed stays in the application layer; this is only the verdict.
   */
  invalidReason: z.string().optional(),
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
  /**
   * Capability overlay (optional; a backend MAY surface it): may the CURRENT
   * caller write this project's documents? "read" puts the editor into
   * read-only viewer mode (read-only-viewer). Absent ⇒ "write" — authz-free
   * backends stay writable without knowing the field exists. A capability
   * descriptor like `LayerDescriptor.writable`, not authz policy: how it is
   * computed stays in the closed application layer.
   */
  access: z.enum(["read", "write"]).optional(),
});
export type ProjectWithFiles = z.infer<typeof projectWithFiles>;

export const errorBody = z.object({ message: z.string() });
export type ErrorBody = z.infer<typeof errorBody>;

/**
 * A scope collaborator as seen by the editor (comments-ux 0001 E): the
 * DISPLAY surface for @-mention autocomplete — slug (identity key, same as
 * presence/comments), name, optional avatar. Deliberately no role/membership
 * fields: membership, auth and the members model stay in the closed
 * application layer (this leaks the shape, not the mechanism — the libs
 * precedent). Backends without a members model simply 404 the route.
 */
export const collaboratorSchema = z.object({
  slug: z.string(),
  name: z.string(),
  image: z.string().optional(),
});
export type Collaborator = z.infer<typeof collaboratorSchema>;

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
  // The scope (namespace) this lib belongs to, e.g. "kicad" or "myorg". Optional
  // on the wire for sources that don't model scopes (built-in/static examples).
  scope: z.string().optional(),
  name: z.string(),
  // 'origin' | 'mirror' | 'org'
  type: z.string(),
  // 'public' | 'private' — origins are always public. Optional for sources that
  // don't model visibility.
  visibility: z.string().optional(),
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
 * Header carrying the active scope (namespace) a request operates in. The scope
 * also appears in the path; the header is the canonical value services read.
 */
export const SCOPE_HEADER = "x-pcbjam-scope";

/**
 * Header carrying the (thin, pre-auth) current-user identity. Per-user concerns
 * (lib pin opt-outs / explicit adds) key on it; absent ⇒ the backend's default
 * user. Real auth replaces it later without reshaping the protocol. The user's
 * own slug doubles as their personal scope.
 */
export const USER_HEADER = "x-pcbjam-user";

/**
 * Header carrying the current project id on lib requests. A backend MAY use it
 * to scope or compose lib resolution per project, so collaborators on a shared
 * project resolve identically; the minimal reference backend ignores it. Absent
 * ⇒ unscoped resolution.
 */
export const PROJECT_HEADER = "x-pcbjam-project";

/** Body for creating a library (the scope comes from the path / SCOPE_HEADER). */
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
 * `scopeId` is the owning team's stable id ({@link projectSchema}.scopeId;
 * `"local"` for scope-less backends), `projectId` is a uuid and `docPath` is a
 * POSIX project-relative path. The room id carries the scope so the sync
 * backend can persist under team-scoped storage keys without a lookup.
 */
export const collabRoomIdSchema = z.string().min(1);
export function collabRoomId(
  scopeId: string,
  projectId: string,
  docPath: string,
): string {
  return `${scopeId}:${projectId}:${docPath}`;
}

/**
 * Inverse of {@link collabRoomId} / {@link presenceRoomId} — the ONE parser for
 * the room-id format, shared by every backend that needs to recover the parts
 * (ids contain no colons; `docPath` may, so only the first two split).
 */
export function parseCollabRoomId(
  room: string,
): { scopeId: string; projectId: string; docPath: string } | null {
  const i = room.indexOf(":");
  if (i <= 0) return null;
  const j = room.indexOf(":", i + 1);
  if (j <= i + 1) return null;
  const docPath = room.slice(j + 1);
  if (!docPath) return null; // every real room names a doc (or ~presence)
  return {
    scopeId: room.slice(0, i),
    projectId: room.slice(i + 1, j),
    docPath,
  };
}

/**
 * The project-wide PRESENCE room (collab-presence 0006): awareness-only, no
 * document content — every collab-capable tool joins it alongside its per-file
 * room(s) so cross-app features (eeschema⇄pcbnew selection highlight) can see
 * peers in the project's OTHER documents. The `~presence` token cannot collide
 * with a real `docPath` (project files are always relative paths without `~`).
 * Backends should not persist these rooms (nothing writes to their Y.Doc).
 */
export const PRESENCE_DOC_PATH = "~presence";
export function presenceRoomId(scopeId: string, projectId: string): string {
  return collabRoomId(scopeId, projectId, PRESENCE_DOC_PATH);
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

/** Team-scoped prefix every collab blob for a project lives under. */
function collabKeyPrefix(scopeId: string, projectId: string): string {
  return `teams/${scopeId}/projects/${projectId}/`;
}

/** Suffixes appended to a doc's key for its persisted state / liveness marker. */
const COLLAB_DOC_SUFFIX = ".ydoc";
const COLLAB_LIVE_SUFFIX = ".live";

/**
 * R2 key of a room's persisted Yjs state, beside its raw file under the
 * team-scoped `teams/<scopeId>/projects/<projectId>/` prefix. Both segments come
 * straight from the room id ({@link parseCollabRoomId}), so the sync worker and
 * the app server compute identical keys and they never drift.
 * e.g. `teams/<uuid>/projects/<uuid>/pcbnew/board.kicad_pcb.ydoc`.
 */
export function collabDocKey(
  scopeId: string,
  projectId: string,
  docPath: string,
): string {
  return `${collabKeyPrefix(scopeId, projectId)}${sanitizeDocPath(docPath)}${COLLAB_DOC_SUFFIX}`;
}

/**
 * R2 key of a room's liveness marker (a tiny blob the sync DO writes while the
 * room has connections, deletes when empty). The app server checks for it to
 * decide whether to fetch live Y state from the sync worker — without it, a cold
 * Durable Object is never woken. Sits beside the `.ydoc` blob.
 */
export function collabLiveKey(
  scopeId: string,
  projectId: string,
  docPath: string,
): string {
  return `${collabKeyPrefix(scopeId, projectId)}${sanitizeDocPath(docPath)}${COLLAB_LIVE_SUFFIX}`;
}

/**
 * R2 key of an ARCHIVED ydoc epoch: the exact blob `<…>.ydoc` held before an
 * onLoad version-conversion/compaction replaced it (ysync 0009 §5/§6 — the
 * attribution-history chain survives even though the reseed resets the live
 * doc's CRDT history). `epochMs` is the replacement time; one doc's chain is
 * every key under the `<docKey>.` prefix, ordered by the numeric suffix.
 * Deliberately NOT recognized by {@link parseCollabKey}, so archives never
 * surface as live collab docs in listings.
 * e.g. `teams/<uuid>/projects/<uuid>/pcbnew/board.kicad_pcb.ydoc.1783680000000`.
 */
export function collabDocArchiveKey(
  scopeId: string,
  projectId: string,
  docPath: string,
  epochMs: number,
): string {
  return `${collabDocKey(scopeId, projectId, docPath)}.${epochMs}`;
}

/**
 * R2 key of the LAST-KNOWN-GOOD ydoc checkpoint (kicad-validity 0001 §4.3):
 * the exact encoded state that last passed the backend's validity check.
 * Overwritten on every pass; the revert pipeline restores content from it on a
 * deterministic failure. Like the epoch archives, deliberately NOT recognized
 * by {@link parseCollabKey} so it never surfaces as a live collab doc.
 * e.g. `teams/<uuid>/projects/<uuid>/pcbnew/board.kicad_pcb.ydoc.good`.
 */
export function collabDocGoodKey(
  scopeId: string,
  projectId: string,
  docPath: string,
): string {
  return `${collabDocKey(scopeId, projectId, docPath)}.good`;
}

/**
 * Inverse of {@link collabDocKey} / {@link collabLiveKey}: recover the doc path and
 * blob kind from an R2 key, or null if `key` isn't a collab blob under this project's
 * prefix. Keeps the key scheme (prefix + `.ydoc`/`.live` suffix) defined in ONE place
 * so the backend can list collab-only docs without re-deriving it by hand.
 *
 * NOTE: {@link collabDocKey} runs `docPath` through a lossy {@link sanitizeDocPath},
 * so the recovered path equals the original only for already-clean POSIX paths — which
 * is exactly the case that matters here (paths that came from the file list / editor).
 */
export function parseCollabKey(
  scopeId: string,
  projectId: string,
  key: string,
): { path: string; kind: "ydoc" | "live" } | null {
  const prefix = collabKeyPrefix(scopeId, projectId);
  if (!key.startsWith(prefix)) return null;
  const suffix = key.endsWith(COLLAB_DOC_SUFFIX)
    ? COLLAB_DOC_SUFFIX
    : key.endsWith(COLLAB_LIVE_SUFFIX)
      ? COLLAB_LIVE_SUFFIX
      : null;
  if (!suffix) return null;
  const path = key.slice(prefix.length, -suffix.length);
  if (!path) return null;
  return { path, kind: suffix === COLLAB_DOC_SUFFIX ? "ydoc" : "live" };
}
