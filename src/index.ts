import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  createProjectBody,
  errorBody,
  projectFileSchema,
  projectSchema,
  projectWithFiles,
} from "./schemas.js";

export * from "./schemas.js";

const c = initContract();

/**
 * JSON API surface shared by the Fastify server and the React client.
 *
 * NOTE: binary upload (`POST .../files`, `.../files/zip`) and file-byte
 * download (`GET .../files/*`) are intentionally NOT in this ts-rest contract —
 * multipart/streamed-binary do not round-trip cleanly through ts-rest. They are
 * plain Fastify routes; their response shapes are still shared via the Zod
 * schemas in ./schemas.ts (e.g. `uploadResponse`).
 */
export const contract = c.router(
  {
    listProjects: {
      method: "GET",
      path: "/api/projects",
      responses: { 200: z.array(projectSchema) },
      summary: "List all projects in the default owner namespace",
    },
    createProject: {
      method: "POST",
      path: "/api/projects",
      body: createProjectBody,
      responses: {
        201: projectSchema,
        409: errorBody,
        400: errorBody,
      },
      summary: "Create a project",
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
    deleteProject: {
      method: "DELETE",
      path: "/api/projects/:project",
      body: c.type<Record<string, never>>(),
      responses: {
        200: z.object({ id: z.string().uuid() }),
        404: errorBody,
      },
      summary: "Delete a project and all its files",
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
