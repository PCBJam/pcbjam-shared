import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  errorBody,
  projectFileSchema,
  projectSchema,
  projectWithFiles,
} from "./schemas.js";

export * from "./schemas.js";

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
  },
  {
    strictStatusCodes: true,
  },
);

export type Contract = typeof contract;
