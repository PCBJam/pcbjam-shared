/**
 * Site status: the maintenance window and the minimum client build
 * (pcbjam-private admin 0009). Shared by the backend, the management app and
 * the editor:
 *
 *  - Every request a browser client sends to the API carries
 *    `x-pcbjam-build: <client>/<build>[+<sha>]` ({@link installBuildHeader}).
 *    The backend counts builds in use and refuses a build below the minimum
 *    with 426 `{ code: "reload_required" }`.
 *  - During a maintenance window the backend answers 503
 *    `{ code: "maintenance" }` to everyone but admins and closes sync sockets
 *    with {@link MAINTENANCE_CLOSE_CODE}.
 *  - Every API response carries `x-pcbjam-status: <hash>`. The client fetches
 *    `GET /api/status` only when the hash changes, on focus, when the browser
 *    comes back online, and every few minutes as a fallback; once it knows a
 *    window's start it counts down on its own ({@link createSiteStatusClient}).
 *
 * No DOM dependency beyond `fetch`, timers and (optionally) `document` /
 * `window` events, so the backend can import the types and pure helpers.
 */

export const BUILD_HEADER = "x-pcbjam-build";
export const STATUS_HEADER = "x-pcbjam-status";
/** WebSocket handshakes can't carry headers: the build rides as this query parameter. */
export const BUILD_QUERY_PARAM = "build";
/** Sync sockets closed for a maintenance window. */
export const MAINTENANCE_CLOSE_CODE = 4503;
export const STATUS_PATH = "/api/status";

export const SITE_CLIENTS = ["web", "editor"] as const;
export type SiteClient = (typeof SITE_CLIENTS)[number];

/** Notice thresholds before a window starts. */
export const SOON_MS = 5 * 60_000;
export const IMMINENT_MS = 60_000;
/** Fallback poll for tabs that make no API calls. */
export const STATUS_POLL_MS = 5 * 60_000;

export interface BuildStamp {
  client: SiteClient;
  /** `YYYYMMDDHHmm` in UTC, or null for a build without a stamp. */
  build: number | null;
  sha?: string | null;
}

export function isSiteClient(v: unknown): v is SiteClient {
  return v === "web" || v === "editor";
}

/** `web/202611231405+abc1234`; a build without a stamp sends `web/0`. */
export function formatBuildHeader(stamp: BuildStamp): string {
  const sha = stamp.sha ? `+${stamp.sha.slice(0, 12)}` : "";
  return `${stamp.client}/${stamp.build ?? 0}${sha}`;
}

export function parseBuildHeader(raw: string | null | undefined): BuildStamp | null {
  if (!raw) return null;
  const m = /^(web|editor)\/(\d{1,14})(?:\+([0-9a-f]{4,40}))?$/i.exec(raw.trim());
  if (!m) return null;
  const build = Number(m[2]);
  return {
    client: m[1]!.toLowerCase() as SiteClient,
    build: Number.isSafeInteger(build) && build > 0 ? build : null,
    sha: m[3] ? m[3].toLowerCase() : null,
  };
}

/** The build number for "now": `YYYYMMDDHHmm` in UTC. */
export function buildNumberAt(date: Date): number {
  const p = (n: number) => String(n).padStart(2, "0");
  return Number(
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`,
  );
}

/** "2026-11-23 14:05 UTC" for a build number; the number itself when it doesn't parse. */
export function describeBuildNumber(build: number): string {
  const s = String(build);
  if (!/^\d{12}$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)} UTC`;
}

export interface MaintenanceWindowStatus {
  id: string;
  /** ISO; the scheduled start, or when an admin started it early. */
  startsAt: string;
  /** ISO; the estimated end shown to users. */
  etaAt: string | null;
  reason: string;
  state: "scheduled" | "active";
}

export interface SiteStatus {
  /** The open window (scheduled or active), if any. */
  window: MaintenanceWindowStatus | null;
  minBuild: Partial<Record<SiteClient, number>>;
  /** Refuse browser requests from our own origins that carry no build header. */
  refuseUnknown: Partial<Record<SiteClient, boolean>>;
  /** The caller is a platform admin: passes the window's gate. */
  admin: boolean;
  /** Server clock (ISO) — the client corrects its timers with it. */
  now: string;
  /** The same hash the `x-pcbjam-status` header carries. */
  hash: string;
}

export interface MaintenanceRefusal {
  code: "maintenance";
  message: string;
  window: MaintenanceWindowStatus;
}

export interface ReloadRequiredRefusal {
  code: "reload_required";
  message: string;
  client: SiteClient;
  minBuild: number;
}

/**
 * The hash of the state every client cares about. Stable across requests
 * (no clock in it); changes when a window is created, edited, started, ended
 * or canceled, or a minimum changes. FNV-1a, hex.
 */
export function siteStatusHash(s: Pick<SiteStatus, "window" | "minBuild" | "refuseUnknown">): string {
  const w = s.window;
  const parts = [
    w ? `${w.id}|${w.startsAt}|${w.etaAt ?? ""}|${w.state}|${w.reason}` : "-",
    ...SITE_CLIENTS.map((c) => `${c}:${s.minBuild[c] ?? 0}:${s.refuseUnknown[c] ? 1 : 0}`),
  ].join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Is `stamp` below the client's minimum? A build without a stamp is "unknown". */
export function belowMinimum(
  status: Pick<SiteStatus, "minBuild" | "refuseUnknown">,
  client: SiteClient,
  build: number | null,
): boolean {
  const min = status.minBuild[client];
  if (build === null) return !!status.refuseUnknown[client];
  return min !== undefined && min > 0 && build < min;
}

// ---------------------------------------------------------------------------
// What a tab shows
// ---------------------------------------------------------------------------

export type SiteView =
  | { kind: "ok" }
  /** A window is scheduled more than 5 minutes out. */
  | { kind: "announced"; window: MaintenanceWindowStatus; msLeft: number }
  /** ≤ 5 minutes to the start. */
  | { kind: "soon"; window: MaintenanceWindowStatus; msLeft: number }
  /** ≤ 1 minute to the start. */
  | { kind: "imminent"; window: MaintenanceWindowStatus; msLeft: number }
  /** The window is on. `admin` passes the gate and keeps working. */
  | { kind: "maintenance"; window: MaintenanceWindowStatus; admin: boolean }
  /** This build is below the minimum: blocked until the page reloads. */
  | { kind: "reload"; client: SiteClient; minBuild: number };

/** The view for `status` at server-corrected time `nowMs`. */
export function computeSiteView(
  status: SiteStatus | null,
  stamp: BuildStamp,
  nowMs: number,
  forced?: { reload?: ReloadRequiredRefusal | null; maintenance?: MaintenanceRefusal | null },
): SiteView {
  if (forced?.reload) return { kind: "reload", client: forced.reload.client, minBuild: forced.reload.minBuild };
  if (status && belowMinimum(status, stamp.client, stamp.build)) {
    return { kind: "reload", client: stamp.client, minBuild: status.minBuild[stamp.client] ?? 0 };
  }
  const w = status?.window ?? forced?.maintenance?.window ?? null;
  if (!w) return { kind: "ok" };
  const admin = status?.admin ?? false;
  const msLeft = Date.parse(w.startsAt) - nowMs;
  if (w.state === "active" || msLeft <= 0) return { kind: "maintenance", window: w, admin };
  if (forced?.maintenance && !admin) return { kind: "maintenance", window: w, admin };
  if (msLeft <= IMMINENT_MS) return { kind: "imminent", window: w, msLeft };
  if (msLeft <= SOON_MS) return { kind: "soon", window: w, msLeft };
  return { kind: "announced", window: w, msLeft };
}

/** Does this view lock the tab (full-screen, no work)? */
export function siteViewBlocks(view: SiteView): boolean {
  return view.kind === "reload" || (view.kind === "maintenance" && !view.admin);
}

/** "4:05" / "0:42" / "1:02:10". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ---------------------------------------------------------------------------
// Browser client
// ---------------------------------------------------------------------------

/** The bit of `window` / `document` the client listens on (no DOM lib here). */
interface EventHost {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface SiteStatusClientOptions {
  /** API origin + base path, e.g. "https://api.pcbjam.com". */
  apiBase: string;
  stamp: BuildStamp;
  /** Defaults to the global fetch (captured before {@link installBuildHeader} wraps it is fine too). */
  fetchImpl?: typeof fetch;
  pollMs?: number;
  /** Event target for focus/online (defaults to `window` / `document` when present). */
  win?: EventHost | null;
  doc?: (EventHost & { visibilityState?: string }) | null;
  now?: () => number;
}

export interface SiteStatusClient {
  start(): void;
  stop(): void;
  /** Fetch `/api/status` now (deduped while one is in flight). */
  refresh(): Promise<void>;
  /** A response carried `x-pcbjam-status`: refresh when it differs. */
  noteStatusHash(hash: string): void;
  /** A request was refused (426 / 503 with our body). */
  noteRefusal(body: MaintenanceRefusal | ReloadRequiredRefusal): void;
  /** A sync socket closed with {@link MAINTENANCE_CLOSE_CODE} (or failed to open). */
  noteSocketTrouble(): void;
  getView(): SiteView;
  getStatus(): SiteStatus | null;
  subscribe(fn: (view: SiteView) => void): () => void;
}

export function createSiteStatusClient(opts: SiteStatusClientOptions): SiteStatusClient {
  const base = opts.apiBase.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const pollMs = opts.pollMs ?? STATUS_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const g = globalThis as { window?: EventHost; document?: EventHost & { visibilityState?: string } };
  const win = opts.win === undefined ? (g.window ?? null) : opts.win;
  const doc = opts.doc === undefined ? (g.document ?? null) : opts.doc;

  let status: SiteStatus | null = null;
  let clockOffset = 0; // server − local
  let forcedReload: ReloadRequiredRefusal | null = null;
  let forcedMaintenance: MaintenanceRefusal | null = null;
  let view: SiteView = { kind: "ok" };
  let inflight: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSocketRefresh = 0;
  let lastT0Check: string | null = null;
  let started = false;
  const listeners = new Set<(v: SiteView) => void>();

  const serverNow = () => now() + clockOffset;

  const recompute = () => {
    const next = computeSiteView(status, opts.stamp, serverNow(), {
      reload: forcedReload,
      maintenance: forcedMaintenance,
    });
    const changed = JSON.stringify(next) !== JSON.stringify(view);
    view = next;
    if (changed) for (const fn of listeners) fn(view);
    schedule();
  };

  /** Tick every second while a countdown shows; otherwise sleep to the next boundary. */
  const schedule = () => {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    if (!started) return;
    const w = status?.window;
    if (!w || w.state === "active") return;
    const msLeft = Date.parse(w.startsAt) - serverNow();
    if (msLeft <= 0) {
      // Past T-0 but the server still says "scheduled" (or we haven't asked yet):
      // confirm with it — the window may have been canceled — at most every 5 s.
      tickTimer = setTimeout(() => void refresh(), lastT0Check === w.id ? 5000 : 0);
      lastT0Check = w.id;
      return;
    }
    const delay = msLeft > SOON_MS ? Math.min(msLeft - SOON_MS, 2 ** 31 - 1) : Math.min(1000, msLeft);
    tickTimer = setTimeout(recompute, Math.max(50, delay));
  };

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const sentAt = now();
        // Built loosely: the Workers' RequestInit type has no `credentials`.
        const init = { credentials: "include", cache: "no-store" } as unknown as RequestInit;
        const res = await doFetch(`${base}${STATUS_PATH}`, init);
        if (!res.ok) return;
        const body = (await res.json()) as SiteStatus;
        const receivedAt = now();
        const serverAt = Date.parse(body.now);
        if (Number.isFinite(serverAt)) clockOffset = serverAt - (sentAt + receivedAt) / 2;
        status = body;
        // A fresh status supersedes refusals heard from other requests — unless
        // the status agrees (the reload stays until the page reloads).
        if (forcedReload && !belowMinimum(body, opts.stamp.client, opts.stamp.build)) {
          // The server refused us earlier but the minimum is gone now; trust the status.
          forcedReload = null;
        }
        forcedMaintenance = null;
      } catch {
        /* offline / API down: keep what we have */
      } finally {
        inflight = null;
        recompute();
      }
    })();
    return inflight;
  };

  const onVisible = () => {
    if (!doc || doc.visibilityState === "visible") void refresh();
  };
  const onOnline = () => void refresh();

  return {
    start() {
      if (started) return;
      started = true;
      void refresh();
      pollTimer = setInterval(() => void refresh(), pollMs);
      doc?.addEventListener("visibilitychange", onVisible);
      win?.addEventListener("online", onOnline);
      win?.addEventListener("focus", onVisible);
    },
    stop() {
      started = false;
      if (pollTimer) clearInterval(pollTimer);
      if (tickTimer) clearTimeout(tickTimer);
      pollTimer = tickTimer = null;
      doc?.removeEventListener("visibilitychange", onVisible);
      win?.removeEventListener("online", onOnline);
      win?.removeEventListener("focus", onVisible);
    },
    refresh,
    noteStatusHash(hash) {
      if (!status || status.hash !== hash) void refresh();
    },
    noteRefusal(body) {
      if (body.code === "reload_required") forcedReload = body;
      else forcedMaintenance = body;
      recompute();
      void refresh();
    },
    noteSocketTrouble() {
      // A reconnect loop must not turn into a status-request loop.
      if (now() - lastSocketRefresh < 10_000) return;
      lastSocketRefresh = now();
      void refresh();
    },
    getView: () => view,
    getStatus: () => status,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export interface InstallBuildHeaderOptions {
  /** Only requests to this origin get the header (the API). */
  apiBase: string;
  stamp: BuildStamp;
  /** Receives the status hash and our refusals; usually a {@link SiteStatusClient}. */
  client?: Pick<SiteStatusClient, "noteStatusHash" | "noteRefusal">;
  target?: { fetch: typeof fetch };
}

/**
 * Wrap the global `fetch` once at boot: requests to the API origin carry the
 * build header, and their responses feed the status client (the status hash,
 * a 426 / 503 refusal). Returns the unwrapped fetch.
 */
export function installBuildHeader(opts: InstallBuildHeaderOptions): typeof fetch {
  const target = opts.target ?? (globalThis as unknown as { fetch: typeof fetch });
  const original = target.fetch.bind(target);
  const marker = "__pcbjamBuildHeader";
  if ((target.fetch as unknown as Record<string, unknown>)[marker]) return original;
  let apiOrigin: string;
  try {
    apiOrigin = new URL(opts.apiBase).origin;
  } catch {
    return original;
  }
  const value = formatBuildHeader(opts.stamp);

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    let toApi = false;
    try {
      const here = (globalThis as { location?: { href: string } }).location?.href;
      toApi = new URL(url, here).origin === apiOrigin;
    } catch {
      toApi = false;
    }
    if (!toApi) return original(input, init);

    let res: Response;
    if (input instanceof Request && !init) {
      const headers = new Headers(input.headers);
      headers.set(BUILD_HEADER, value);
      res = await original(new Request(input, { headers }));
    } else {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set(BUILD_HEADER, value);
      res = await original(input, { ...init, headers });
    }
    const hash = res.headers.get(STATUS_HEADER);
    if (hash) opts.client?.noteStatusHash(hash);
    if ((res.status === 426 || res.status === 503) && opts.client) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json")) {
        try {
          const body = (await res.clone().json()) as { code?: string };
          if (body.code === "maintenance" || body.code === "reload_required") {
            opts.client.noteRefusal(body as MaintenanceRefusal | ReloadRequiredRefusal);
          }
        } catch {
          /* not our body */
        }
      }
    }
    return res;
  };
  (wrapped as unknown as Record<string, unknown>)[marker] = true;
  target.fetch = wrapped as typeof fetch;
  return original;
}

/** Append the build to a sync WebSocket URL. */
export function withBuildParam(url: string, stamp: BuildStamp): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${BUILD_QUERY_PARAM}=${encodeURIComponent(formatBuildHeader(stamp))}`;
}
