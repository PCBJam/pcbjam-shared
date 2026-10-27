/**
 * Problem reports: the wire shape the editor posts when the user presses
 * "Report a problem": their own description, an optional screenshot, the
 * logs and environment the editor gathered, and whether the team may open
 * the project to reproduce it. A generic protocol (the GPL editor posts it
 * without the closed contract); how a backend stores, lists or acts on
 * reports is its own concern; only these shapes are shared.
 *
 * Its own router (not `contract`): the closed contract spreads `contract`
 * and sits at TypeScript's declaration-size limit, so new routes go in
 * separate routers that a backend mounts next to the main one.
 */
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { errorBody } from "./schemas.js";

/** The server enforces these; the editor trims to them before sending. */
export const PROBLEM_REPORT_LIMITS = {
  descriptionChars: 5000,
  /** Decoded screenshot bytes. */
  screenshotBytes: 4 * 1024 * 1024,
  /** `logs`, JSON-serialized. */
  logsBytes: 3 * 1024 * 1024,
  /** `context`, JSON-serialized. */
  contextBytes: 64 * 1024,
  /** The whole request body (base64 screenshot + logs + context). */
  bodyBytes: 10 * 1024 * 1024,
  consoleEntries: 2000,
  editorLines: 800,
  errors: 100,
  network: 100,
  files: 500,
} as const;

export const problemReportLogLevel = z.enum(["debug", "log", "info", "warn", "error"]);
export type ProblemReportLogLevel = z.infer<typeof problemReportLogLevel>;

/** One captured console call. `t` is ms since the epoch. */
export const problemReportConsoleEntry = z.object({
  t: z.number(),
  level: problemReportLogLevel,
  text: z.string(),
  /** Where it was logged when not the page itself (e.g. "occ-worker"). */
  source: z.string().optional(),
});
export type ProblemReportConsoleEntry = z.infer<typeof problemReportConsoleEntry>;

/** An uncaught error or unhandled promise rejection. */
export const problemReportErrorEntry = z.object({
  t: z.number(),
  kind: z.enum(["error", "unhandledrejection"]),
  message: z.string(),
  stack: z.string().optional(),
  /** `file:line:col` when the event carried one. */
  where: z.string().optional(),
});
export type ProblemReportErrorEntry = z.infer<typeof problemReportErrorEntry>;

/** A request that failed (status >= 400) per the browser's resource timing. */
export const problemReportNetworkEntry = z.object({
  t: z.number(),
  url: z.string(),
  status: z.number().int(),
  durationMs: z.number(),
  initiator: z.string().optional(),
});
export type ProblemReportNetworkEntry = z.infer<typeof problemReportNetworkEntry>;

export const problemReportLogs = z.object({
  console: z.array(problemReportConsoleEntry).default([]),
  /** The editor's own log (boot, saves, collab, wasm stdout/stderr). */
  editor: z.array(z.string()).default([]),
  errors: z.array(problemReportErrorEntry).default([]),
  network: z.array(problemReportNetworkEntry).default([]),
  /** The load timeline, as the crash screen prints it. */
  loadTrace: z.string().optional(),
  /** What the wasm side is blocked on, when it is. */
  wxWaitDump: z.string().optional(),
  /** Error-reporting event ids from this session, for cross-reference. */
  errorEventIds: z.array(z.string()).default([]),
});
export type ProblemReportLogs = z.infer<typeof problemReportLogs>;

/**
 * Where the report came from. Free-form beyond the summary fields: the editor
 * adds whatever it can learn, the admin view shows it as a key/value table.
 */
export const problemReportContext = z.object({
  app: z.record(z.unknown()).default({}),
  env: z
    .object({
      /** Short labels for listings, e.g. "Chrome 141" and "macOS 15.6". */
      browser: z.string().optional(),
      os: z.string().optional(),
      userAgent: z.string().optional(),
    })
    .passthrough()
    .default({}),
  page: z.record(z.unknown()).default({}),
});
export type ProblemReportContext = z.infer<typeof problemReportContext>;

export const problemReportScreenshot = z.object({
  mime: z.enum(["image/webp", "image/png", "image/jpeg"]),
  base64: z.string().min(1),
});
export type ProblemReportScreenshot = z.infer<typeof problemReportScreenshot>;

/** The project the editor had open, by its URL segments. */
export const problemReportProject = z.object({
  /** Scope slug. */
  scope: z.string().min(1),
  /** Project slug. */
  project: z.string().min(1),
  /** The project's stable id, when the editor knows it (a cross-check). */
  projectId: z.string().optional(),
  /** Working copy the session was bound to, if not the default. */
  copy: z.string().optional(),
  tool: z.string().optional(),
  /** Project-relative path of the open document. */
  file: z.string().optional(),
});
export type ProblemReportProject = z.infer<typeof problemReportProject>;

export const problemReportBody = z.object({
  description: z.string().trim().min(1).max(PROBLEM_REPORT_LIMITS.descriptionChars),
  /**
   * The user agreed that the team may open (and edit) the project to
   * reproduce the problem. Only meaningful with `project`; a backend may
   * honor it for its own members only.
   */
  projectConsent: z.boolean().default(false),
  project: problemReportProject.optional(),
  context: problemReportContext,
  logs: problemReportLogs,
  screenshot: problemReportScreenshot.optional(),
});
export type ProblemReportBody = z.input<typeof problemReportBody>;

export const problemReportCreated = z.object({
  id: z.string().uuid(),
  /** The first 8 hex characters of `id`, for the user to quote. */
  shortId: z.string(),
  /** When the team's access to the project ends; null = no access granted. */
  supportAccessUntil: z.string().nullable(),
});
export type ProblemReportCreated = z.infer<typeof problemReportCreated>;

const c = initContract();

export const problemReportContract = c.router(
  {
    createProblemReport: {
      method: "POST",
      path: "/api/problem-reports",
      body: problemReportBody,
      responses: {
        201: problemReportCreated,
        400: errorBody,
        401: errorBody,
        403: errorBody,
        404: errorBody,
        413: errorBody,
        429: errorBody,
      },
      summary: "Report a problem from the editor (description, logs, screenshot, consent)",
    },
  },
  { strictStatusCodes: true },
);
