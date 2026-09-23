// Shared, runtime-neutral rules for `kind: "remote-provider"` packages: the
// KiCad 10 remote-provider metadata document, the PLACE_COMPONENT manifest and
// the JSON-RPC v1 envelope the provider panel speaks. Mirrors the desktop
// implementation (eeschema/widgets/panel_remote_symbol.cpp,
// eeschema/remote_symbol_download_manager.cpp) so a provider written for KiCad
// works here unchanged. No network, credentials or environment fallback.
import { backendOrigin, exact } from "./backend-contract.mjs";

export const RPC_VERSION = 1;
export const WELL_KNOWN_PATH = "/.well-known/kicad-remote-provider";
export const ASSET_TYPES = Object.freeze(["symbol", "footprint", "3dmodel", "spice"]);
export const PROVIDER_LIMITS = Object.freeze({
  metadataBytes: 64 * 1024,
  assetBytes: 4 * 1024 * 1024,
  partBytes: 4 * 1024 * 1024,
  messageBytes: 6 * 1024 * 1024,
  manifestAssets: 16,
  handshakeAttempts: 10,
  handshakeIntervalMs: 1000,
});
// The editor document is cross-origin isolated (COEP require-corp, needed for
// SharedArrayBuffer), so a cross-origin panel page only loads when it opts in
// with both headers. Values are compared case-insensitively.
export const REQUIRED_PANEL_HEADERS = Object.freeze({
  "cross-origin-embedder-policy": Object.freeze(["require-corp"]),
  "cross-origin-resource-policy": Object.freeze(["cross-origin"]),
});
export const PROVIDER_COMMANDS = Object.freeze([
  "NEW_SESSION",
  "GET_KICAD_VERSION",
  "LIST_SUPPORTED_VERSIONS",
  "CAPABILITIES",
  "GET_SOURCE_INFO",
  "REMOTE_LOGIN",
  "DL_SYMBOL",
  "DL_COMPONENT",
  "DL_FOOTPRINT",
  "DL_SPICE",
  "DL_3DMODEL",
  "PLACE_COMPONENT",
]);

const fail = (message) => {
  throw new Error(message);
};
const isString = (v, min = 1, max = 2048) =>
  typeof v === "string" && v.length >= min && v.length <= max;
const isInt = (v, min) => Number.isInteger(v) && v >= min;
const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);

export function providerOrigin(value) {
  return backendOrigin(value);
}
export function metadataUrl(origin) {
  return providerOrigin(origin) + WELL_KNOWN_PATH;
}
// Origin of an absolute URL the provider handed us. https only; http is
// accepted for loopback hosts only when the caller opts in (fixtures), never
// in product code. Userinfo, ports and fragments are refused outright.
export function urlOrigin(value, { allowInsecureLocalhost = false } = {}) {
  if (!isString(value)) fail("Remote provider URL must be a non-empty string");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Remote provider URL is not absolute: " + value);
  }
  if (url.username || url.password || url.hash)
    fail("Remote provider URL must not carry credentials or a fragment");
  if (url.protocol === "https:") {
    if (url.port) fail("Remote provider URL must use the default https port");
    backendOrigin(url.origin);
    return url.origin;
  }
  if (url.protocol === "http:" && allowInsecureLocalhost && loopback(url.hostname))
    return url.origin;
  fail("Remote provider URL must use https: " + value);
}

export function validateProviderMetadata(
  doc,
  { allowInsecureLocalhost = false, allowedAuthTypes = ["none"] } = {}
) {
  exact(doc, [
    "provider_name",
    "provider_version",
    "api_base_url",
    "panel_url",
    "session_bootstrap_url",
    "allow_insecure_localhost",
    "auth",
    "capabilities",
    "max_download_bytes",
    "supported_asset_types",
    "parts",
    "documentation_url",
    "terms_url",
    "privacy_url",
  ]);
  for (const key of [
    "provider_name",
    "provider_version",
    "api_base_url",
    "panel_url",
    "auth",
    "capabilities",
    "max_download_bytes",
    "supported_asset_types",
  ])
    if (doc[key] === undefined) fail("Remote provider metadata is missing " + key);
  if (!isString(doc.provider_name, 1, 200) || !isString(doc.provider_version, 1, 64))
    fail("Remote provider metadata has an invalid provider_name or provider_version");
  if (doc.allow_insecure_localhost !== undefined && typeof doc.allow_insecure_localhost !== "boolean")
    fail("allow_insecure_localhost must be a boolean");
  const urls = { allowInsecureLocalhost };
  const apiOrigin = urlOrigin(doc.api_base_url, urls);
  const panelOrigin = urlOrigin(doc.panel_url, urls);
  if (doc.session_bootstrap_url !== undefined) urlOrigin(doc.session_bootstrap_url, urls);
  for (const key of ["documentation_url", "terms_url", "privacy_url"])
    if (doc[key] !== undefined && !isString(doc[key])) fail(key + " must be a non-empty string");

  exact(doc.auth, ["type", "metadata_url", "client_id", "scopes"]);
  if (!["none", "oauth2"].includes(doc.auth.type)) fail("auth.type must be none or oauth2");
  if (doc.auth.type === "oauth2") {
    if (!isString(doc.auth.metadata_url) || !isString(doc.auth.client_id))
      fail("oauth2 providers must declare auth.metadata_url and auth.client_id");
    if (!isString(doc.session_bootstrap_url))
      fail("oauth2 providers must declare session_bootstrap_url");
  }
  if (
    doc.auth.scopes !== undefined &&
    (!Array.isArray(doc.auth.scopes) || doc.auth.scopes.some((s) => !isString(s, 1, 128)))
  )
    fail("auth.scopes must be an array of non-empty strings");
  if (!allowedAuthTypes.includes(doc.auth.type))
    fail("Remote providers with auth.type " + doc.auth.type + " are not supported yet");

  exact(doc.capabilities, ["web_ui_v1", "parts_v1", "direct_downloads_v1", "inline_payloads_v1"]);
  if (typeof doc.capabilities.web_ui_v1 !== "boolean") fail("capabilities.web_ui_v1 is required");
  for (const key of ["parts_v1", "direct_downloads_v1", "inline_payloads_v1"])
    if (doc.capabilities[key] !== undefined && typeof doc.capabilities[key] !== "boolean")
      fail("capabilities." + key + " must be a boolean");
  if (!doc.capabilities.web_ui_v1) fail("Remote provider does not offer a web panel (web_ui_v1)");

  if (!isInt(doc.max_download_bytes, 1)) fail("max_download_bytes must be a positive integer");
  if (
    !Array.isArray(doc.supported_asset_types) ||
    !doc.supported_asset_types.length ||
    doc.supported_asset_types.some((t) => !ASSET_TYPES.includes(t)) ||
    new Set(doc.supported_asset_types).size !== doc.supported_asset_types.length
  )
    fail("supported_asset_types must list distinct known asset types");
  if (doc.parts !== undefined) {
    exact(doc.parts, ["endpoint_template"]);
    if (doc.parts.endpoint_template !== undefined && !/^\/\S*$/.test(doc.parts.endpoint_template))
      fail("parts.endpoint_template must start with /");
  }

  return {
    providerName: doc.provider_name,
    providerVersion: doc.provider_version,
    apiBaseUrl: doc.api_base_url,
    panelUrl: doc.panel_url,
    sessionBootstrapUrl: doc.session_bootstrap_url,
    authType: doc.auth.type,
    capabilities: {
      webUi: true,
      parts: doc.capabilities.parts_v1 === true,
      directDownloads: doc.capabilities.direct_downloads_v1 === true,
      inlinePayloads: doc.capabilities.inline_payloads_v1 === true,
    },
    maxDownloadBytes: doc.max_download_bytes,
    supportedAssetTypes: [...doc.supported_asset_types].sort(),
    documentationUrl: doc.documentation_url,
    termsUrl: doc.terms_url,
    privacyUrl: doc.privacy_url,
    originSet: [...new Set([panelOrigin, apiOrigin])].sort(),
  };
}

// Same rule as the desktop client: assets may only come from the panel's or
// the API's origin. Returns the URL as given so the caller fetches exactly it.
export function assetAllowed(url, originSet, options) {
  const origin = urlOrigin(url, options);
  if (!Array.isArray(originSet) || !originSet.includes(origin))
    fail("Remote asset URL origin must match the selected provider");
  return url;
}

export function validatePlaceManifest(
  params,
  { supportedAssetTypes = ASSET_TYPES, maxDownloadBytes = PROVIDER_LIMITS.partBytes, originSet, urlOptions } = {}
) {
  exact(params, ["part_id", "display_name", "summary", "license", "assets", "symbol_name", "library_name", "mode"]);
  if (!isString(params.part_id, 1, 256) || !isString(params.display_name, 1, 256))
    fail("Manifest requires part_id and display_name");
  for (const key of ["summary", "license", "symbol_name", "library_name", "mode"])
    if (params[key] !== undefined && typeof params[key] !== "string") fail(key + " must be a string");
  if (params.mode !== undefined && !["PLACE", "SAVE"].includes(params.mode.toUpperCase()))
    fail("Unsupported transfer mode '" + params.mode + "'");
  if (!Array.isArray(params.assets) || !params.assets.length)
    fail("Manifest requires a non-empty assets array");
  if (params.assets.length > PROVIDER_LIMITS.manifestAssets) fail("Manifest lists too many assets");
  const budget = Math.min(maxDownloadBytes, PROVIDER_LIMITS.partBytes);
  let total = 0;
  const assets = params.assets.map((asset) => {
    exact(asset, ["asset_type", "name", "target_library", "target_name", "content_type", "size_bytes", "sha256", "download_url", "required"]);
    for (const key of ["asset_type", "name", "content_type", "size_bytes", "sha256", "download_url", "required"])
      if (asset[key] === undefined) fail("Manifest assets require asset_type, content_type, size_bytes, and download_url");
    if (!ASSET_TYPES.includes(asset.asset_type)) fail("Unknown asset_type '" + asset.asset_type + "'");
    if (!supportedAssetTypes.includes(asset.asset_type))
      fail("Provider does not declare support for " + asset.asset_type + " assets");
    if (!isString(asset.name, 1, 256) || !isString(asset.content_type, 1, 128))
      fail("Manifest asset name and content_type must be non-empty strings");
    for (const key of ["target_library", "target_name"])
      if (asset[key] !== undefined && !isString(asset[key], 0, 256)) fail(key + " must be a string");
    if (!isInt(asset.size_bytes, 1)) fail("Remote asset manifest declared an invalid size");
    if (asset.size_bytes > PROVIDER_LIMITS.assetBytes) fail("Remote asset exceeds the PCBJam asset size limit");
    if (typeof asset.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(asset.sha256))
      fail("Remote asset manifest must declare sha256 for URL-based downloads");
    if (typeof asset.required !== "boolean") fail("Manifest asset 'required' must be a boolean");
    if (originSet) assetAllowed(asset.download_url, originSet, urlOptions);
    else urlOrigin(asset.download_url, urlOptions);
    total += asset.size_bytes;
    return {
      assetType: asset.asset_type,
      name: asset.name,
      targetLibrary: asset.target_library ?? "",
      targetName: asset.target_name ?? "",
      contentType: asset.content_type,
      sizeBytes: asset.size_bytes,
      sha256: asset.sha256.toLowerCase(),
      downloadUrl: asset.download_url,
      required: asset.required,
    };
  });
  if (total > budget) fail("Remote assets exceed the provider download limit");
  return {
    partId: params.part_id,
    displayName: params.display_name,
    summary: params.summary ?? "",
    license: params.license ?? "",
    symbolName: params.symbol_name ?? "",
    libraryName: params.library_name ?? "",
    place: params.mode === undefined || params.mode.toUpperCase() === "PLACE",
    assets,
    totalBytes: total,
  };
}

// DL_COMPONENT carries a base64 JSON array of {type, name, content, compression}.
// Only the shape is validated here; the base64 content is decoded by the host.
export function validateInlineBundle(entries) {
  if (!Array.isArray(entries) || !entries.length) fail("Component list must be a non-empty array.");
  if (entries.length > PROVIDER_LIMITS.manifestAssets) fail("Component list has too many entries");
  return entries.map((entry) => {
    exact(entry, ["type", "name", "content", "compression"]);
    if (!isString(entry.type, 1, 32)) fail("Component entry was missing a type.");
    const type = entry.type.toLowerCase();
    if (!ASSET_TYPES.includes(type)) fail("Unsupported component type '" + entry.type + "'.");
    if (entry.name !== undefined && !isString(entry.name, 0, 256)) fail("Component entry name must be a string");
    if (typeof entry.content !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(entry.content))
      fail("Failed to decode base64 payload.");
    if (entry.compression !== undefined && !isString(entry.compression, 1, 16)) fail("compression must be a string");
    return { type, name: entry.name ?? "", content: entry.content, compression: (entry.compression ?? "NONE").toUpperCase() };
  });
}

// One JSON-RPC v1 envelope from the provider page. Accepts a string or an
// already-parsed object; refuses anything the desktop client would refuse.
export function validateEnvelope(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > PROVIDER_LIMITS.messageBytes) fail("Message exceeds the size limit");
    try {
      value = JSON.parse(raw);
    } catch {
      fail("Message is not valid JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Message must be a JSON object");
  exact(value, ["version", "session_id", "message_id", "response_to", "command", "status", "error_code", "error_message", "parameters", "data"]);
  if (!isString(value.command, 1, 64)) fail("Message is missing a command");
  if (!isInt(value.message_id, 0)) fail("Message is missing a numeric message_id");
  if (value.response_to !== undefined && !isInt(value.response_to, 0)) fail("response_to must be an integer");
  if (value.parameters !== undefined && (typeof value.parameters !== "object" || value.parameters === null || Array.isArray(value.parameters)))
    fail("parameters must be an object");
  if (value.data !== undefined && typeof value.data !== "string") fail("data must be a base64 string");
  for (const key of ["status", "error_code", "error_message", "session_id"])
    if (value[key] !== undefined && typeof value[key] !== "string") fail(key + " must be a string");
  return {
    version: typeof value.version === "number" ? value.version : 0,
    sessionId: value.session_id ?? "",
    messageId: value.message_id,
    responseTo: value.response_to,
    command: value.command,
    status: value.status,
    errorCode: value.error_code,
    errorMessage: value.error_message,
    parameters: value.parameters ?? {},
    data: value.data ?? "",
  };
}

export function providerPolicyText(origin) {
  return JSON.stringify({ version: 1, kind: "remote-provider", origin: providerOrigin(origin) });
}
export function providerPermissions(origin) {
  const o = providerOrigin(origin);
  return {
    "provider:embed": "Show " + o + " inside PCBJam",
    "provider:download": "Download parts you choose from " + o + " into a team library",
  };
}

// `headers` is anything with a case-insensitive get(name) (fetch Headers) or a
// plain object keyed by lowercase header names.
export function checkPanelHeaders(headers) {
  const get = (name) =>
    typeof headers?.get === "function" ? headers.get(name) : headers?.[name] ?? null;
  const missing = [];
  for (const [name, accepted] of Object.entries(REQUIRED_PANEL_HEADERS)) {
    const actual = get(name);
    const value = typeof actual === "string" ? actual.split(";")[0].trim().toLowerCase() : "";
    if (!accepted.includes(value)) missing.push({ name, expected: accepted[0], actual: actual ?? "" });
  }
  return { ok: missing.length === 0, missing };
}
