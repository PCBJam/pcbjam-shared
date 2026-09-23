// Starter KiCad 10 Remote Symbols provider for PCBJam. Node.js 22+, no
// dependencies. It serves everything PCBJam and desktop KiCad need:
//
//   /.well-known/kicad-remote-provider   metadata (application/json)
//   /panel                               the panel page, with the PCBJam shim and both isolation headers
//   /v1/parts/<part_id>                  a PLACE_COMPONENT manifest per part
//   /downloads/<file>                    the asset bytes, with exact Content-Type and Content-Length
//
// Replace PARTS and the files in data/ with your catalog. Sizes and sha256 are
// computed from the files at start-up, so manifests always match the bytes.
//
//   PUBLIC_ORIGIN=https://<your tunnel or host> node serve.mjs
//
// PUBLIC_ORIGIN is the https origin PCBJam reaches you at (lowercase, no
// trailing slash); it goes into the metadata, manifests and download URLs.
// EMBEDDERS (comma-separated) overrides which PCBJam origins may embed the
// panel; unset keeps the shim's defaults (production and staging editor).
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(ROOT, "data", name));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// The four content types PCBJam accepts; a download must be served with exactly this type.
const CONTENT_TYPES = {
  symbol: "application/x-kicad-symbol",
  footprint: "application/x-kicad-footprint",
  "3dmodel": "model/step",
  spice: "application/x-spice",
};
const FILES = {
  "r.kicad_sym": { type: "symbol", target: "R" },
  "c.kicad_sym": { type: "symbol", target: "C" },
  "R_0603_1608Metric.kicad_mod": { type: "footprint", target: "R_0603_1608Metric" },
  "R_0603_1608Metric.step": { type: "3dmodel", target: "R_0603_1608Metric" },
  "resistor.cir": { type: "spice", target: "resistor" },
  "capacitor.cir": { type: "spice", target: "capacitor" },
};
for (const [name, file] of Object.entries(FILES)) file.bytes = read(name);
const LIBRARY = { symbol: "Passives", footprint: "Passives_SMD", "3dmodel": "Passives_3D", spice: "Passives_Spice" };

// Your catalog. Every part needs exactly one symbol; the first footprint is kept.
const PARTS = [
  { part_id: "r-10k-0603", display_name: "R 10k 0603", summary: "10 kΩ ±1% 0603 thick film resistor", license: "CC-BY-SA-4.0",
    symbol_name: "R", library_name: "Passives", files: ["r.kicad_sym", "R_0603_1608Metric.kicad_mod", "R_0603_1608Metric.step", "resistor.cir"] },
  { part_id: "c-100n-0603", display_name: "C 100n 0603", summary: "100 nF X7R 0603 capacitor", license: "CC-BY-SA-4.0",
    symbol_name: "C", library_name: "Passives", files: ["c.kicad_sym", "R_0603_1608Metric.kicad_mod", "capacitor.cir"] },
];

function asset(origin, name) {
  const f = FILES[name];
  return {
    asset_type: f.type, name, target_library: LIBRARY[f.type], target_name: f.target, content_type: CONTENT_TYPES[f.type],
    size_bytes: f.bytes.length, sha256: sha256(f.bytes), download_url: origin + "/downloads/" + name,
    required: f.type === "symbol", // mandatory boolean on every asset
  };
}
function manifestFor(origin, id) {
  const part = PARTS.find((p) => p.part_id === id);
  if (!part) return null;
  const { files, ...rest } = part;
  return { ...rest, assets: files.map((name) => asset(origin, name)) };
}
// Inline DL_COMPONENT payload: base64 of a UTF-8 JSON array of {type, name, content (base64), compression}.
function inlineBundle(id) {
  const part = PARTS.find((p) => p.part_id === id);
  const entries = part.files.map((name) => ({ type: FILES[name].type, name: FILES[name].target, content: b64(FILES[name].bytes), compression: "NONE" }));
  return b64(JSON.stringify(entries));
}
function metadataFor(origin) {
  return {
    provider_name: "Starter Parts", provider_version: "1.0.0",
    api_base_url: origin + "/v1", panel_url: origin + "/panel",
    auth: { type: "none" },
    capabilities: { web_ui_v1: true, parts_v1: true, direct_downloads_v1: true, inline_payloads_v1: true },
    // PCBJam caps a part at min(max_download_bytes, 4 MiB).
    max_download_bytes: 4 * 1024 * 1024,
    supported_asset_types: ["symbol", "footprint", "3dmodel", "spice"],
    parts: { endpoint_template: "/v1/parts/{part_id}" },
    // Desktop KiCad only: lets it use an http://localhost origin while you develop. PCBJam requires https.
    ...(origin.startsWith("http:") ? { allow_insecure_localhost: true } : {}),
  };
}

const PANEL = readFileSync(path.join(ROOT, "panel.html"), "utf8");
const SHIM = readFileSync(path.join(ROOT, "shim.js"), "utf8");
const ISOLATION = { "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" };

export async function startProvider({ port = 4400, host = "127.0.0.1", publicOrigin, embedders } = {}) {
  let origin = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { "Content-Type": type, ...extra }); res.end(body); };
    const json = (value, status = 200) => send(status, "application/json", JSON.stringify(value), { "Cross-Origin-Resource-Policy": "cross-origin" });
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "method not allowed");
    const pub = publicOrigin ?? origin;
    if (url.pathname === "/.well-known/kicad-remote-provider") return json(metadataFor(pub));
    if (url.pathname === "/shim.js") return send(200, "text/javascript", SHIM, ISOLATION);
    if (url.pathname === "/panel") {
      const parts = PARTS.map(({ part_id, display_name, summary }) => ({ part_id, display_name, summary }));
      const manifests = Object.fromEntries(PARTS.map((p) => [p.part_id, manifestFor(pub, p.part_id)]));
      const inline = Object.fromEntries(PARTS.map((p) => [p.part_id, inlineBundle(p.part_id)]));
      const allow = embedders ? `<script>window.PCBJAM_EMBEDDERS = ${JSON.stringify(embedders)};</script>\n` : "";
      const html = PANEL.replace("__SHIM__", `${allow}<script>${SHIM}</script>`).replace("__PARTS__", JSON.stringify(parts))
        .replace("__MANIFESTS__", JSON.stringify(manifests)).replace("__INLINE__", JSON.stringify(inline));
      return send(200, "text/html; charset=utf-8", html, ISOLATION);
    }
    const part = url.pathname.match(/^\/v1\/parts\/([a-z0-9-]+)$/);
    if (part) { const m = manifestFor(pub, part[1]); return m ? json(m) : json({ error: "Part " + part[1] + " not found" }, 404); }
    const dl = url.pathname.match(/^\/downloads\/([A-Za-z0-9_.-]+)$/);
    if (dl) {
      const f = FILES[dl[1]];
      if (!f) return json({ error: "Asset " + dl[1] + " not found" }, 404);
      // 200 directly (no redirect), exact type and length: PCBJam checks all three plus sha256.
      return send(200, CONTENT_TYPES[f.type], f.bytes, { "Content-Length": f.bytes.length, "Cross-Origin-Resource-Policy": "cross-origin" });
    }
    return send(404, "text/plain", "not found");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  origin = `http://${host}:${server.address().port}`;
  return { origin, publicOrigin: publicOrigin ?? origin, async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const embedders = process.env.EMBEDDERS === undefined ? undefined : process.env.EMBEDDERS.split(",").filter(Boolean);
  const provider = await startProvider({ port: Number(process.env.PORT ?? 4400), publicOrigin: process.env.PUBLIC_ORIGIN, embedders });
  console.log(`provider listening on ${provider.origin} (public origin ${provider.publicOrigin})`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => provider.close().then(() => process.exit(0)));
}
