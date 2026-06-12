import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  errorBody,
  libItemSchema,
  libSchema,
  projectFileSchema,
  projectSchema,
  projectWithFiles,
} from "./schemas.js";

export * from "./schemas.js";
export * from "./sexpr.js";
export * from "./kicad-doc.js";
export * from "./collab-wire.js";
export * from "./kicad-delta.js";
export * from "./kicad-y.js";
export * from "./items-wire.js";

const c = initContract();

/**
 * The contract between the wasm-frontend (the GPL standalone editor) and ANY
 * backend that wants to serve projects to it. This is the *minimum* read/load
 * surface a backend must implement for the editor to enumerate projects, read a
 * project's file tree, and stream file bytes into the WASM tools.
 *
 * Management/write concerns (creating, deleting, uploading) and any ownership /
 * auth model are intentionally NOT here — those live in the application layer
 * that builds on top of this contract.
 *
 * NOTE: the file-byte download is a streamed-binary route
 * (`GET /api/projects/:project/files/*`) and is intentionally NOT a ts-rest
 * endpoint (binary does not round-trip cleanly through ts-rest). A conforming
 * backend MUST still expose it; the editor fetches it directly.
 */
export const contract = c.router(
  {
    listProjects: {
      method: "GET",
      path: "/api/projects",
      responses: { 200: z.array(projectSchema) },
      summary: "List the projects this backend serves",
    },
    getProject: {
      method: "GET",
      path: "/api/projects/:project",
      pathParams: z.object({ project: z.string() }),
      responses: {
        200: projectWithFiles,
        404: errorBody,
      },
      summary: "Get a project and its file tree",
    },
    listFiles: {
      method: "GET",
      path: "/api/projects/:project/files",
      pathParams: z.object({ project: z.string() }),
      responses: {
        200: z.array(projectFileSchema),
        404: errorBody,
      },
      summary: "List the files in a project",
    },

    // --- libraries (read-only) ---
    // The item BODY fetch is a raw streamed-text route
    // (`GET /api/libs/:lib/items/:kind/:name`), NOT a ts-rest endpoint — same as
    // file-byte download. A conforming backend MUST still expose it.
    listLibs: {
      method: "GET",
      path: "/api/libs",
      responses: { 200: z.array(libSchema) },
      summary: "List the libraries this backend serves",
    },
    listLibItems: {
      method: "GET",
      path: "/api/libs/:lib/items",
      pathParams: z.object({ lib: z.string() }),
      responses: {
        200: z.array(libItemSchema),
        404: errorBody,
      },
      summary: "List the items (symbols/footprints) in a library",
    },
  },
  {
    strictStatusCodes: true,
  },
);

export type Contract = typeof contract;
