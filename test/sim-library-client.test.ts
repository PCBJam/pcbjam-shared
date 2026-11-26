import { describe, expect, it, vi } from "vitest";
import { LIBRARY_REQUEST_MS, openLibrary } from "../src/sim-library/index.js";
import { makeEmulator, makeSnapshot, serve } from "./sim-library-fixtures.js";

const BASE = "https://library.test/sim";

describe("reading a published snapshot", () => {
  it("asks for the pointer, the index, and then only the files of the parts it loads", async () => {
    const snapshot = makeSnapshot();
    const cdn = serve(snapshot);
    const lib = await openLibrary(BASE, { fetch: cdn.fetch });
    expect(lib.version).toBe(snapshot.version);
    expect(cdn.asked).toEqual(["current.json", `${snapshot.version}/index.json`]);

    const pot = await lib.loadPart("potentiometer");
    expect(pot.manifest.analog.subckt).toBe("T_POT");
    expect(pot.analog).toContain(".subckt T_POT 1 2 3 RTOT=10k");
    expect(pot.logic).toBeNull();
    expect(lib.requests).toMatchObject({ pointer: 1, index: 1, files: 2 });

    await lib.loadPart("potentiometer");   // nothing is fetched twice
    expect(cdn.asked.length).toBe(4);
  });

  it("opens a named snapshot without asking for the pointer", async () => {
    const snapshot = makeSnapshot();
    const cdn = serve(snapshot);
    const lib = await openLibrary(BASE + "/", { fetch: cdn.fetch, version: snapshot.version });
    expect(cdn.asked).toEqual([`${snapshot.version}/index.json`]);
    expect(lib.parts.map((p) => p.id)).toContain("led");
  });

  it("reads a chip emulator's files from beside the snapshots, once, and checks them the same way", async () => {
    const emulator = makeEmulator();
    const snapshot = makeSnapshot(undefined, [emulator]);
    const cdn = serve(snapshot);
    const lib = await openLibrary(BASE, { fetch: cdn.fetch });
    expect(lib.emulator("esp32sim")).toMatchObject({ version: "0.4.0-1", program: "esp32sim.wasm", loader: "jit.mjs" });
    expect(lib.emulator("nothing")).toBeUndefined();

    const program = await lib.emulatorFile("esp32sim", "esp32sim.wasm");
    expect([...program.subarray(0, 4)]).toEqual([0, 97, 115, 109]);
    await lib.emulatorFile("esp32sim", "esp32sim.wasm");
    expect(cdn.asked.slice(2)).toEqual(["emulators/esp32sim/0.4.0-1/esp32sim.wasm"]);

    await expect(lib.emulatorFile("esp32sim", "other.js")).rejects.toThrow('simulation library: emulator "esp32sim" has no file "other.js"');
    await expect(lib.emulatorFile("nothing", "jit.mjs")).rejects.toThrow('simulation library: emulator "nothing" has no file "jit.mjs"');

    const key = "emulators/esp32sim/0.4.0-1/jit.mjs";
    const changed = new Uint8Array(cdn.files.get(key) ?? []);
    changed[0] = (changed[0] ?? 0) ^ 1;
    cdn.files.set(key, changed);
    await expect(lib.emulatorFile("esp32sim", "jit.mjs")).rejects.toThrow("simulation library: emulator esp32sim/jit.mjs does not match its checksum");
  });

  // A download that hangs must not keep whoever waits for it waiting for ever.
  it("gives a request up when it does not end in time, and asks again the next time", async () => {
    const snapshot = makeSnapshot();
    const cdn = serve(snapshot);
    const signals: (AbortSignal | undefined)[] = [];
    let hang: string | null = "current.json";
    const f = ((input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      // a request that never gets an answer
      return hang !== null && String(input).endsWith(hang) ? new Promise<Response>(() => {}) : cdn.fetch(input, init);
    }) as typeof fetch;

    await expect(openLibrary(BASE, { fetch: f, requestMs: 20 })).rejects.toThrow("simulation library: current.json: no answer within 20 ms");
    expect(signals[0]?.aborted, "the request is given up, not only its wait").toBe(true);

    // a file: it gets the time its size takes on a slow line on top
    hang = "led/model.lib";
    const lib = await openLibrary(BASE, { fetch: f, requestMs: 20 });
    await expect(lib.file("led", "model.lib")).rejects.toThrow(/^simulation library: .*led\/model\.lib: no answer within \d+ ms$/);
    // the next ask tries again, and gets it
    hang = null;
    expect(new TextDecoder().decode(await lib.file("led", "model.lib"))).toContain(".subckt");
    expect(cdn.asked.filter((p) => p.endsWith("led/model.lib"))).toHaveLength(1);
  });

  it("says seconds for the deadline it has by itself", async () => {
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    vi.useFakeTimers();
    try {
      const opened = openLibrary(BASE, { fetch: never }).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(LIBRARY_REQUEST_MS);
      expect(await opened).toBe("simulation library: current.json: no answer within 30 seconds");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a file that is not the one the index describes", async () => {
    const snapshot = makeSnapshot();
    const cdn = serve(snapshot);
    const key = `${snapshot.version}/parts/led/model.lib`;
    const changed = new Uint8Array(cdn.files.get(key) ?? []);
    changed[2] = (changed[2] ?? 0) ^ 1;   // same length, one bit off
    cdn.files.set(key, changed);
    const lib = await openLibrary(BASE, { fetch: cdn.fetch });
    await expect(lib.loadPart("led")).rejects.toThrow("simulation library: led/model.lib does not match its checksum");
    cdn.files.set(key, snapshot.files.get("parts/led/model.lib") ?? new Uint8Array());
    await expect(lib.loadPart("led")).resolves.toMatchObject({ id: "led" });   // a failure is not remembered
  });

  it("says so when the library, a part or a file is not there", async () => {
    const snapshot = makeSnapshot();
    const cdn = serve(snapshot);
    const lib = await openLibrary(BASE, { fetch: cdn.fetch });
    await expect(lib.file("led", "secret.txt")).rejects.toThrow("part \"led\" has no file \"secret.txt\"");
    await expect(lib.file("nothing", "part.json")).rejects.toThrow("part \"nothing\" has no file \"part.json\"");
    cdn.files.delete("current.json");
    await expect(openLibrary(BASE, { fetch: cdn.fetch })).rejects.toThrow("simulation library: current.json: HTTP 404");
  });

  it("refuses a pointer or an index it does not understand", async () => {
    const snapshot = makeSnapshot();
    const cdn = serve(snapshot);
    const put = (path: string, json: unknown): void => { cdn.files.set(path, new TextEncoder().encode(JSON.stringify(json))); };
    put("current.json", { schema: 1, version: "../../etc" });
    await expect(openLibrary(BASE, { fetch: cdn.fetch })).rejects.toThrow("bad snapshot name");
    put("current.json", { schema: 2, version: snapshot.version });
    await expect(openLibrary(BASE, { fetch: cdn.fetch })).rejects.toThrow("pointer of an unknown format (2)");
    put(`${snapshot.version}/index.json`, { ...snapshot.index, version: "aaaaaaaaaaaa" });
    await expect(openLibrary(BASE, { fetch: cdn.fetch, version: snapshot.version })).rejects.toThrow(`asked for snapshot ${snapshot.version}, got aaaaaaaaaaaa`);
  });
});
