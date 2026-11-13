import { describe, expect, it } from "vitest";
import { openLibrary } from "../src/sim-library/index.js";
import { makeSnapshot, serve } from "./sim-library-fixtures.js";

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
