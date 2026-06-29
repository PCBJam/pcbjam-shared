import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { driftReportBody, driftSummary } from "./drift.js";
import {
  createLibBody,
  errorBody,
  libItemSchema,
  libSchema,
  projectFileSchema,
  projectSchema,
  projectWithFiles,
} from "./schemas.js";

export * from "./schemas.js";
export * from "./routes.js";
export * from "./sexpr.js";
export * from "./kicad-doc.js";
export * from "./collab-wire.js";
export * from "./kicad-delta.js";
export * from "./kicad-y.js";
export * from "./items-wire.js";
export * from "./drift.js";
export * from "./sync-wire.js";

const c = initContract();

/**
 * The contract between the wasm-frontend (the GPL standalone editor) and ANY
 * backend that wants to serve projects to it. This is the *minimum* read/load
 * surface a backend must implement for the editor to enumerate projects, read a
 * project's file tree, and stream file bytes into the WASM tools.
 *
 * Project management/write (createProject, deleteProject, uploads) and the auth
 * model are intentionally NOT here — those live in the closed application
 * contract. The ONE write exception is the library protocol (createLib + the raw
 * item-body PUT, 0004): the open build must round-trip create-a-lib + save-an-item
 * without the closed backend, so its wire shape is shared (the rich registry /
 * per-scope impl stays closed). Identity travels via `SCOPE_HEADER`/`USER_HEADER`.
 *
 * Every resource is addressed `scope/kind/name` (see routes.ts): projects and
 * libs live under `/api/scopes/:scope/...`. `:scope` is the owning namespace,
 * `:project`/`:lib` the slug within it.
 *
 * NOTE: the file-byte download is a streamed-binary route
 * (`GET /api/scopes/:scope/projects/:project/files/*`) and is intentionally NOT
 * a ts-rest endpoint (binary does not round-trip cleanly through ts-rest). A
 * conforming backend MUST still expose it; the editor fetches it directly.
 */
export const contract = c.router(
  {
    listProjects: {
      method: "GET",
      path: "/api/scopes/:scope/projects",
      pathParams: z.object({ scope: z.string() }),
      responses: { 200: z.array(projectSchema) },
      summary: "List the projects in a scope",
    },
    getProject: {
      method: "GET",
      path: "/api/scopes/:scope/projects/:project",
      pathParams: z.object({ scope: z.string(), project: z.string() }),
      responses: {
        200: projectWithFiles,
        404: errorBody,
      },
      summary: "Get a project and its file tree",
    },
    listFiles: {
      method: "GET",
      path: "/api/scopes/:scope/projects/:project/files",
      pathParams: z.object({ scope: z.string(), project: z.string() }),
      responses: {
        200: z.array(projectFileSchema),
        404: errorBody,
      },
      summary: "List the files in a project",
    },

    // --- libraries (read-only) ---
    // The item BODY fetch is a raw streamed-text route
    // (`GET /api/scopes/:scope/libs/:lib/items/:kind/:name`), NOT a ts-rest
    // endpoint — same as file-byte download. A conforming backend MUST expose it.
    listLibs: {
      method: "GET",
      path: "/api/scopes/:scope/libs",
      pathParams: z.object({ scope: z.string() }),
      query: z.object({
        // Optional item-kind filter ("symbol" | "footprint"). When set, origins
        // are filtered to those holding >=1 item of that kind; org libs (which
        // are kind-agnostic containers) are always listed. Drives per-tool
        // lib-table generation (a footprint tool requests kind=footprint).
        kind: z.string().optional(),
        // Optional project slug: when present, the backend returns the COMPUTED
        // resolved set for that project (kicad + scope libs + this project's
        // override mirrors + adds − opt-outs); absent ⇒ the scope's own libs.
        project: z.string().optional(),
      }),
      responses: { 200: z.array(libSchema) },
      summary: "List the libraries visible in a scope (optionally project-resolved)",
    },
    listLibItems: {
      method: "GET",
      path: "/api/scopes/:scope/libs/:lib/items",
      pathParams: z.object({ scope: z.string(), lib: z.string() }),
      responses: {
        200: z.array(libItemSchema),
        404: errorBody,
      },
      summary: "List the items (symbols/footprints) in a library",
    },

    // --- library write (0004) ---
    // Creating a lib is JSON in/out (ts-rest). Writing an item BODY is a raw
    // streamed-text route (the mirror image of the GET item-body), NOT ts-rest:
    //   PUT /api/scopes/:scope/libs/:lib/items/:kind/:name  body = kicad_symbol_lib
    // A conforming backend MUST expose it; the editor's WASM plugin PUTs to it.
    createLib: {
      method: "POST",
      path: "/api/scopes/:scope/libs",
      pathParams: z.object({ scope: z.string() }),
      body: createLibBody,
      responses: {
        201: libSchema,
        400: errorBody,
        409: errorBody,
      },
      summary: "Create a library in a scope",
    },

    // --- collaboration drift reporting (ysync) ---
    // Generic: the editor posts a detected ydoc/wasm divergence (both KicadDoc
    // representations + the diff). How a backend stores/lists drifts is closed.
    reportDrift: {
      method: "POST",
      path: "/api/scopes/:scope/projects/:project/drift",
      pathParams: z.object({ scope: z.string(), project: z.string() }),
      body: driftReportBody,
      responses: {
        201: driftSummary,
        404: errorBody,
      },
      summary: "Report a detected ydoc/wasm drift for a project document",
    },
  },
  {
    strictStatusCodes: true,
  },
);

export type Contract = typeof contract;
