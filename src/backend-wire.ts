/**
 * HTTP protocol shapes shared by the GPL standalone editor and the CLOSED
 * platform backend. Two things live here, both of them pure protocol — an
 * `Accept`/`Content-Type` string and a request/response shape — with no
 * platform logic, so the GPL side can speak the protocol without importing the
 * closed contract (which it must never do; see collab-wire.ts's licensing note).
 * The closed contract re-exports these rather than redeclaring them, so the two
 * sides cannot drift.
 */
import type { LayerDescriptor } from "./sync-wire.js";

/* --------------------------------------------------------- ydoc file serve --
 * A project file whose collaborative room has ever been opened is stored as a
 * Yjs doc, and the backend materializes it to KiCad text on every GET: a Y ->
 * KicadDoc traversal plus an s-expr build. On a ~2300-item board that measured
 * ~2.0 s locally and blew the Cloudflare Workers CPU limit in production (503,
 * which the browser reports as a bogus missing-CORS-header error).
 *
 * A client that can apply a ydoc itself — the editor already can, it holds the
 * same `ydocUpdateToKicadDoc` + `docToFile` this package exports — asks for the
 * raw update instead and does the work locally, where CPU is free. The URL is
 * unchanged, so any consumer that does NOT negotiate keeps getting KiCad text.
 */

/** `Accept` (request) and `Content-Type` (response) for a raw Yjs update. */
export const YDOC_CONTENT_TYPE = "application/x-pcbjam-ydoc";

/**
 * Response header naming the representation actually served, so a client never
 * has to infer it from the body. Present only on a ydoc response — a backend
 * predating negotiation simply answers with text and omits it, which is exactly
 * the fallback a client should take.
 */
export const YDOC_REPRESENTATION_HEADER = "x-pcbjam-representation";

/** Whether a response to a negotiated file GET carries a ydoc rather than text. */
export function isYdocResponse(res: {
  headers: { get(name: string): string | null };
}): boolean {
  return (res.headers.get("content-type") ?? "").includes(YDOC_CONTENT_TYPE);
}

/* ------------------------------------------------------ batch stack resolve --
 * Resolving a library's layer stack is one cheap backend read, but the per-lib
 * route makes it one HTTP request — and a board load resolves 156-200 libraries
 * before a single byte of library content is fetched. The cost is dominated by
 * per-request overhead (a serverless invocation each), not by the resolve, so
 * batching collapses the whole phase into a handful of requests while leaving
 * the LAYER fetches per-lib and individually cacheable.
 */

/** One resolved stack: the library it belongs to plus its ordered layers. */
export interface SyncStackDescriptor {
  lib: { id: string; name: string };
  layers: LayerDescriptor[];
}

/**
 * Ids per batch request. The server caps each request at this many and returns
 * the rest in `remaining`, so a client that ignores paging still gets a valid
 * (partial) answer instead of an error.
 */
export const SYNC_STACKS_BATCH_MAX = 500;

/** POST body of the batch resolve. */
export interface SyncStacksRequest {
  libIds: string[];
}

/**
 * Response of the batch resolve. `stacks` maps lib id -> descriptor, with an
 * explicit `null` for an id the backend could not resolve (deleted library,
 * stale pin) so one bad id can never sink an entire load. `remaining` lists ids
 * that were NOT processed because the request exceeded the per-request cap —
 * absent or empty means the batch was complete.
 */
export interface SyncStacksResponse {
  stacks: Record<string, SyncStackDescriptor | null>;
  remaining?: string[];
}

/**
 * Resolve many stacks, paging until every id has an answer.
 *
 * Pages on BOTH signals: it chunks client-side to `SYNC_STACKS_BATCH_MAX`, and
 * it also honours a `remaining` list from the server, so a backend with a
 * smaller cap than this client assumes still terminates correctly. Ids the
 * backend maps to null are returned as null rather than dropped, so a caller
 * can tell "unresolvable" from "not asked for".
 */
export async function fetchSyncStacks(opts: {
  url: string;
  libIds: string[];
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}): Promise<Map<string, SyncStackDescriptor | null>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const out = new Map<string, SyncStackDescriptor | null>();
  let pending = [...opts.libIds];
  // Bounded so a backend that echoed `remaining` unchanged could not spin here.
  let guard = opts.libIds.length + 16;

  while (pending.length > 0 && guard-- > 0) {
    const chunk = pending.slice(0, SYNC_STACKS_BATCH_MAX);
    // `credentials` exists in the browser's RequestInit but not in the Workers /
    // Node typings this package also compiles against, and the live layers are
    // membership-gated per request — so send it, and cast rather than drop it.
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      credentials: "include",
      body: JSON.stringify({ libIds: chunk } satisfies SyncStacksRequest),
    } as unknown as Parameters<typeof fetch>[1];
    const res = await doFetch(opts.url, init);
    if (!res.ok) throw new Error(`sync-stacks resolve failed: HTTP ${res.status}`);
    const body = (await res.json()) as SyncStacksResponse;
    for (const [id, stack] of Object.entries(body.stacks ?? {})) out.set(id, stack);

    const serverRemaining = body.remaining ?? [];
    const answered = chunk.filter((id) => out.has(id));
    // Anything we asked for and did not hear about is retried with the next
    // page rather than silently lost.
    const unanswered = chunk.filter((id) => !out.has(id) && !serverRemaining.includes(id));
    if (answered.length === 0 && serverRemaining.length === chunk.length) {
      throw new Error("sync-stacks made no progress — backend returned every id as remaining");
    }
    pending = [...serverRemaining, ...unanswered, ...pending.slice(chunk.length)];
  }
  return out;
}
