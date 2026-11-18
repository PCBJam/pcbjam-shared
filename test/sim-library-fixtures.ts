// A small library for the tests of src/sim-library: three parts written out by hand, and a
// stand-in for the CDN. The real parts and the step that publishes them live elsewhere.
import { createHash } from "node:crypto";
import type { IndexEmulator, IndexPart, LibraryIndex, PartManifest } from "../src/sim-library/index.js";

export const POT: PartManifest = {
  schema: 1, id: "potentiometer", version: 1, title: "Potentiometer",
  fits: [{ symbol: "Device:R_Potentiometer" }],
  pins: ["1", "2", "3"],
  settings: [{ name: "resistance", default: "10k", fromValue: true, accept: "^[0-9]+(\\.[0-9]+)?(meg|[kKmMuUnNpP])?$" }],
  analog: { file: "model.lib", subckt: "T_POT", params: { RTOT: "$resistance" } },
  inputs: [{ name: "position", type: "range", source: "Vpos", min: 0, max: 1, default: 0.5 }],
  overlay: [{ widget: "slider", place: { below: "bbox" }, input: "position" }],
};
export const POT_MODEL = `.subckt T_POT 1 2 3 RTOT=10k
Vpos pos 0 dc 0.5
R1 1 2 r = '{RTOT} * (1 - V(pos)) + 1'
R2 2 3 r = '{RTOT} * V(pos) + 1'
.ends T_POT
`;

export const LED: PartManifest = {
  schema: 1, id: "led", version: 1, title: "LED",
  fits: [{ symbol: "Device:LED", pins: "name" }],
  pins: ["A", "K"],
  settings: [{ name: "color", default: "red", options: ["red", "green", "blue"], fromValue: true }],
  analog: { file: "model.lib", subckt: "T_LED" },
  signals: [{ name: "current", current: "Vsense" }],
  overlay: [{ widget: "glow", place: { at: "origin" }, signal: "current", color: "$color" }],
};
export const LED_MODEL = `.subckt T_LED A K
Vsense A a1 dc 0
D1 a1 K TLED
.model TLED D(IS=1e-18 N=2 RS=10)
.ends T_LED
`;

export const BUTTON: PartManifest = {
  schema: 1, id: "push-button", version: 1, title: "Push button",
  fits: [{ symbol: "Switch:SW_Push" }],
  pins: ["1", "2"],
  analog: { file: "model.lib", subckt: "T_BUTTON" },
  inputs: [{ name: "pressed", type: "momentary", source: "Vctl", released: 0, held: 1 }],
  overlay: [{ widget: "press-zone", place: { over: "bbox" }, input: "pressed" }],
};
export const BUTTON_MODEL = `.subckt T_BUTTON 1 2
Vctl ctl 0 dc 0
R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'
.ends T_BUTTON
`;

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface TestSnapshot {
  version: string;
  index: LibraryIndex;
  /** Every file by its path below the snapshot folder. */
  files: Map<string, Uint8Array>;
  /** The files that sit beside the snapshots (an emulator's), by their path from the library's root. */
  shared: Map<string, Uint8Array>;
}

/** A chip emulator with made-up files, as the index lists one and as the CDN holds it. */
export function makeEmulator(id = "esp-emu", version = "1.0.0-rc2"): { entry: IndexEmulator; files: Map<string, Uint8Array> } {
  const own: [string, Uint8Array][] = [["esp_emu.js", utf8("export class WasmEmulator {}\n")], ["esp_emu_bg.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])]];
  return {
    entry: {
      id, version, title: "A chip emulator", licence: "Apache-2.0", origin: "https://example.test/emulator", program: "esp_emu_bg.wasm", loader: "esp_emu.js",
      files: own.map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.length })),
    },
    files: new Map(own.map(([name, bytes]) => [`emulators/${id}/${version}/${name}`, bytes])),
  };
}

/** A snapshot of the three parts, laid out the way a published one is. */
export function makeSnapshot(
  parts: [PartManifest, string][] = [[LED, LED_MODEL], [POT, POT_MODEL], [BUTTON, BUTTON_MODEL]],
  emulators: ReturnType<typeof makeEmulator>[] = [],
): TestSnapshot {
  const files = new Map<string, Uint8Array>();
  const entries: IndexPart[] = parts.map(([m, model]) => {
    const own: [string, Uint8Array][] = [["part.json", utf8(JSON.stringify(m))], [m.analog.file, utf8(model)]];
    for (const [name, bytes] of own) files.set(`parts/${m.id}/${name}`, bytes);
    return {
      id: m.id, version: m.version, title: m.title, description: m.description ?? "", fits: m.fits, pins: m.pins, code: !!m.digital,
      files: own.map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.length })),
    };
  });
  const version = sha(utf8(JSON.stringify(entries))).slice(0, 12);
  const index: LibraryIndex = { schema: 1, version, parts: entries, emulators: emulators.map((e) => e.entry) };
  files.set("index.json", utf8(JSON.stringify(index)));
  return { version, index, files, shared: new Map(emulators.flatMap((e) => [...e.files])) };
}

/** A fetch that serves one snapshot from memory, the way the CDN would, and keeps what was asked. */
export function serve(snapshot: TestSnapshot, base = "https://library.test/sim/"): { fetch: typeof fetch; asked: string[]; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  files.set("current.json", utf8(JSON.stringify({ schema: 1, version: snapshot.version })));
  for (const [path, bytes] of snapshot.files) files.set(`${snapshot.version}/${path}`, bytes);
  for (const [path, bytes] of snapshot.shared) files.set(path, bytes);
  const asked: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.startsWith(base) ? url.slice(base.length) : "";
    asked.push(path);
    const bytes = files.get(path);
    return bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, asked, files };
}
