import { z } from "zod";

/** WASM tools that can be selected by the `:tool` URL segment. */
export const TOOLS = ["pcbnew", "eeschema", "calculator"] as const;
export const toolSchema = z.enum(TOOLS);
export type Tool = z.infer<typeof toolSchema>;

/** Default file-extension → tool mapping (the explicit URL segment always wins). */
export const EXTENSION_TOOL: Record<string, Tool> = {
  ".kicad_pcb": "pcbnew",
  ".kicad_sch": "eeschema",
};

/** Tools that do not take a file (booted standalone). */
export const FILELESS_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["calculator"]);

export const projectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "slug must start alphanumeric and contain only lowercase letters, digits, '.', '_', '-'",
  );

export const projectSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
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
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export const createProjectBody = z.object({
  name: z.string().min(1).max(200),
  slug: projectSlugSchema.optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBody>;

export const projectWithFiles = z.object({
  project: projectSchema,
  files: z.array(projectFileSchema),
});
export type ProjectWithFiles = z.infer<typeof projectWithFiles>;

/** Shared response shape for the (raw-Fastify) upload endpoints. */
export const uploadResponse = z.object({
  files: z.array(projectFileSchema),
});
export type UploadResponse = z.infer<typeof uploadResponse>;

export const errorBody = z.object({ message: z.string() });
export type ErrorBody = z.infer<typeof errorBody>;
