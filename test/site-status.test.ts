import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_HEADER,
  STATUS_HEADER,
  belowMinimum,
  buildNumberAt,
  computeSiteView,
  createSiteStatusClient,
  formatBuildHeader,
  formatCountdown,
  installBuildHeader,
  parseBuildHeader,
  siteStatusHash,
  siteViewBlocks,
  withBuildParam,
  type SiteStatus,
} from "../src/site-status.js";

const stamp = { client: "web" as const, build: 202611231405, sha: "abc1234" };

function status(over: Partial<SiteStatus> = {}): SiteStatus {
  const s: SiteStatus = {
    window: null,
    minBuild: {},
    refuseUnknown: {},
    admin: false,
    now: new Date(0).toISOString(),
    hash: "",
    ...over,
  };
  s.hash = siteStatusHash(s);
  return s;
}

const windowAt = (startsAt: number, state: "scheduled" | "active" = "scheduled") => ({
  id: "w1",
  startsAt: new Date(startsAt).toISOString(),
  etaAt: new Date(startsAt + 3_600_000).toISOString(),
  reason: "File format migration",
  state,
});

describe("build header", () => {
  it("round-trips", () => {
    expect(formatBuildHeader(stamp)).toBe("web/202611231405+abc1234");
    expect(parseBuildHeader("web/202611231405+abc1234")).toEqual(stamp);
    expect(parseBuildHeader("editor/202611231405")).toEqual({ client: "editor", build: 202611231405, sha: null });
  });

  it("treats a missing stamp as no build", () => {
    expect(formatBuildHeader({ client: "editor", build: null })).toBe("editor/0");
    expect(parseBuildHeader("editor/0")?.build).toBeNull();
  });

  it("refuses junk", () => {
    expect(parseBuildHeader("mcp/1")).toBeNull();
    expect(parseBuildHeader("web/abc")).toBeNull();
    expect(parseBuildHeader("")).toBeNull();
    expect(parseBuildHeader(null)).toBeNull();
  });

  it("numbers builds by UTC minute", () => {
    expect(buildNumberAt(new Date(Date.UTC(2026, 10, 23, 14, 5, 59)))).toBe(202611231405);
  });

  it("adds the build to a socket URL", () => {
    expect(withBuildParam("wss://x/room?ticket=t", stamp)).toBe(
      "wss://x/room?ticket=t&build=web%2F202611231405%2Babc1234",
    );
  });
});

describe("minimum build", () => {
  it("compares per client", () => {
    const s = status({ minBuild: { web: 202611240000 } });
    expect(belowMinimum(s, "web", 202611231405)).toBe(true);
    expect(belowMinimum(s, "web", 202611240000)).toBe(false);
    expect(belowMinimum(s, "editor", 1)).toBe(false);
  });

  it("refuses unknown builds only when asked", () => {
    expect(belowMinimum(status(), "web", null)).toBe(false);
    expect(belowMinimum(status({ refuseUnknown: { web: true } }), "web", null)).toBe(true);
  });
});

describe("computeSiteView", () => {
  const T = Date.UTC(2026, 10, 30, 14, 0);
  it("walks the notices toward the start", () => {
    const s = status({ window: windowAt(T) });
    expect(computeSiteView(s, stamp, T - 3_600_000).kind).toBe("announced");
    expect(computeSiteView(s, stamp, T - 5 * 60_000).kind).toBe("soon");
    expect(computeSiteView(s, stamp, T - 60_000).kind).toBe("imminent");
    expect(computeSiteView(s, stamp, T)).toMatchObject({ kind: "maintenance", admin: false });
  });

  it("lets admins through", () => {
    const view = computeSiteView(status({ window: windowAt(T, "active"), admin: true }), stamp, T);
    expect(view).toMatchObject({ kind: "maintenance", admin: true });
    expect(siteViewBlocks(view)).toBe(false);
  });

  it("puts reload above maintenance", () => {
    const s = status({ window: windowAt(T, "active"), minBuild: { web: 202612010000 } });
    expect(computeSiteView(s, stamp, T)).toEqual({ kind: "reload", client: "web", minBuild: 202612010000 });
  });

  it("blocks on a refusal even before the status arrives", () => {
    const view = computeSiteView(null, stamp, T, {
      maintenance: { code: "maintenance", message: "", window: windowAt(T, "active") },
    });
    expect(siteViewBlocks(view)).toBe(true);
  });
});

describe("status hash", () => {
  it("ignores the clock and the caller, follows the state", () => {
    const a = status({ now: "2026-01-01T00:00:00Z" });
    const b = status({ now: "2026-06-01T00:00:00Z", admin: true });
    expect(a.hash).toBe(b.hash);
    expect(status({ minBuild: { web: 1 } }).hash).not.toBe(a.hash);
    expect(status({ window: windowAt(0) }).hash).not.toBe(a.hash);
  });
});

describe("formatCountdown", () => {
  it("formats", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(400)).toBe("0:01");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("installBuildHeader", () => {
  it("stamps API requests only and feeds the client", async () => {
    const seen: Array<{ url: string; build: string | null }> = [];
    const target = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push({ url, build: new Headers(init?.headers).get(BUILD_HEADER) });
        return new Response(JSON.stringify({ code: "maintenance", message: "", window: windowAt(0, "active") }), {
          status: 503,
          headers: { "content-type": "application/json", [STATUS_HEADER]: "deadbeef" },
        });
      }) as typeof fetch,
    };
    const client = { noteStatusHash: vi.fn(), noteRefusal: vi.fn() };
    installBuildHeader({ apiBase: "https://api.example.com", stamp, client, target });
    await target.fetch("https://api.example.com/api/projects");
    await target.fetch("https://cdn.example.com/x.wasm");
    expect(seen).toEqual([
      { url: "https://api.example.com/api/projects", build: "web/202611231405+abc1234" },
      { url: "https://cdn.example.com/x.wasm", build: null },
    ]);
    expect(client.noteStatusHash).toHaveBeenCalledWith("deadbeef");
    expect(client.noteRefusal).toHaveBeenCalledWith(expect.objectContaining({ code: "maintenance" }));
  });
});

describe("createSiteStatusClient", () => {
  afterEach(() => vi.useRealTimers());

  it("counts down locally after one status read", async () => {
    vi.useFakeTimers();
    const T = Date.UTC(2026, 10, 30, 14, 0);
    vi.setSystemTime(T - 6 * 60_000);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json(status({ window: windowAt(T), now: new Date(Date.now()).toISOString() }));
    }) as unknown as typeof fetch;
    const client = createSiteStatusClient({
      apiBase: "https://api.example.com",
      stamp,
      fetchImpl,
      win: null,
      doc: null,
      pollMs: 10 * 60_000,
    });
    const kinds: string[] = [];
    client.subscribe((v) => {
      if (kinds[kinds.length - 1] !== v.kind) kinds.push(v.kind);
    });
    client.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getView().kind).toBe("announced");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(client.getView().kind).toBe("soon");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(client.getView().kind).toBe("imminent");
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(client.getView().kind).toBe("maintenance");
    expect(kinds).toEqual(["announced", "soon", "imminent", "maintenance"]);
    client.stop();
  });

  it("refreshes only when the hash changes", async () => {
    let calls = 0;
    const s = status();
    const fetchImpl = (async () => {
      calls++;
      return Response.json(s);
    }) as unknown as typeof fetch;
    const client = createSiteStatusClient({ apiBase: "https://a", stamp, fetchImpl, win: null, doc: null });
    await client.refresh();
    client.noteStatusHash(s.hash);
    await Promise.resolve();
    expect(calls).toBe(1);
    client.noteStatusHash("other");
    await client.refresh();
    expect(calls).toBe(2);
  });
});
