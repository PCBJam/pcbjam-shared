// Shared, runtime-neutral rules for `kind: "remote-provider"` packages: the
// KiCad 10 remote-provider metadata document, the PLACE_COMPONENT manifest and
// the JSON-RPC v1 envelope the provider panel speaks. Mirrors the desktop
// implementation (eeschema/widgets/panel_remote_symbol.cpp,
// eeschema/remote_symbol_download_manager.cpp) so a provider written for KiCad
// works here unchanged. No network, credentials or environment fallback.
import { backendOrigin, backendPath, exact } from "./backend-contract.mjs";

export const RPC_VERSION = 1;
export const WELL_KNOWN_PATH = "/.well-known/kicad-remote-provider";
// Sign-in (auth.type "oauth2"): where a sign-in server publishes its document
// (RFC 8414), and the editor path its answer comes back to. The path names the
// sign-in server, so an answer cannot be taken for another server's.
export const OAUTH_SERVER_WELL_KNOWN_PATH = "/.well-known/oauth-authorization-server";
export const LOGIN_CALLBACK_PREFIX = "/remote-provider-callback/";
export const OAUTH_LIMITS = Object.freeze({ clientIdChars: 200, scopes: 32, scopeChars: 128 });
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
// The headers of the panel page that decide whether a browser shows it inside another site.
export const PANEL_FRAMING_HEADERS = Object.freeze(["content-security-policy", "x-frame-options"]);
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

// A URL PCBJam calls itself or opens in the sign-in popup: written in its plain
// form (what `new URL` would print), no query, and a path the egress accepts.
function plainUrl(value, what, options) {
  const origin = urlOrigin(value, options);
  const url = new URL(value);
  try {
    backendPath(url.pathname);
  } catch {
    fail(what + " has a path PCBJam cannot call");
  }
  if (value !== origin + url.pathname) fail(what + " must be a plain URL without a query");
  return origin;
}
// RFC 6749: a client id is printable ASCII (VSCHAR).
export function oauthClientId(value) {
  if (typeof value !== "string" || value.length > OAUTH_LIMITS.clientIdChars || !/^[\x20-\x7e]+$/.test(value))
    fail("An OAuth client id is 1 to " + OAUTH_LIMITS.clientIdChars + " printable characters");
  return value;
}
// RFC 6749 3.3: a scope token is printable ASCII without space, quote and backslash.
const isScope = (v) =>
  typeof v === "string" && v.length <= OAUTH_LIMITS.scopeChars && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(v);

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
  // Sign-in: every value PCBJam will use is checked here, once, so that what is
  // stored at upload can be compared as plain strings at panel open.
  let auth;
  if (doc.auth.type === "oauth2") {
    plainUrl(doc.auth.metadata_url, "auth.metadata_url", urls);
    try {
      oauthClientId(doc.auth.client_id);
    } catch {
      fail("auth.client_id must be 1 to " + OAUTH_LIMITS.clientIdChars + " printable characters");
    }
    const scopes = doc.auth.scopes ?? [];
    if (scopes.length > OAUTH_LIMITS.scopes || scopes.some((s) => !isScope(s)) || new Set(scopes).size !== scopes.length)
      fail("auth.scopes must be distinct OAuth scope tokens");
    if (plainUrl(doc.session_bootstrap_url, "session_bootstrap_url", urls) !== panelOrigin)
      fail("session_bootstrap_url must be on the origin of panel_url");
    auth = { type: "oauth2", metadataUrl: doc.auth.metadata_url, clientId: doc.auth.client_id, scopes: [...scopes] };
  }

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
    // Only for providers with sign-in, so a document without it reads as before.
    ...(auth ? { auth } : {}),
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

// The sign-in server's own document (RFC 8414), read once at upload. It names
// the endpoints PCBJam pins, so it is tied to the provider in every way a
// document can be: on the provider's registered domain, all of it on one
// origin, and able to do what PCBJam needs (code flow, PKCE S256, a public
// client, and `iss` in its answer, RFC 9207). Unknown keys are fine: such a
// document has many. `registeredDomain(hostname)` answers the registrable
// domain from the public suffix list with its private section, or null (an IP
// address, a name that is itself a suffix); the caller brings it so this module
// stays free of the list.
export function validateOAuthServerMetadata(
  doc,
  { metadataUrl, origin, registeredDomain, allowInsecureLocalhost = false } = {}
) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    fail("The sign-in server's document must be a JSON object");
  const urls = { allowInsecureLocalhost };
  let issuerOrigin;
  try {
    issuerOrigin = urlOrigin(doc.issuer, urls);
  } catch {
    fail("The sign-in server's issuer must be an https origin");
  }
  if (doc.issuer !== issuerOrigin) fail("The sign-in server's issuer must be a bare origin without a path");
  if (metadataUrl !== doc.issuer + OAUTH_SERVER_WELL_KNOWN_PATH)
    fail("auth.metadata_url must be the issuer followed by " + OAUTH_SERVER_WELL_KNOWN_PATH);
  if (!sameRegisteredDomain(doc.issuer, origin, registeredDomain, urls))
    fail("The sign-in server must be on the provider's own registered domain");
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (!isString(doc[key])) fail("The sign-in server's document is missing " + key);
    if (plainUrl(doc[key], key, urls) !== doc.issuer) fail(key + " must be on the issuer's origin");
  }
  const lists = (key, wanted, required) => {
    if (doc[key] === undefined && !required) return;
    if (!Array.isArray(doc[key]) || !doc[key].includes(wanted))
      fail("The sign-in server must list " + wanted + " in " + key);
  };
  lists("response_types_supported", "code", true);
  lists("grant_types_supported", "authorization_code", false);
  lists("code_challenge_methods_supported", "S256", true);
  // Missing means client_secret_basic (RFC 8414), and PCBJam has no client secret.
  lists("token_endpoint_auth_methods_supported", "none", true);
  if (doc.authorization_response_iss_parameter_supported !== true)
    fail("The sign-in server must send iss in its answer (authorization_response_iss_parameter_supported: true, RFC 9207)");
  return {
    issuer: doc.issuer,
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
  };
}
function sameRegisteredDomain(a, b, registeredDomain, { allowInsecureLocalhost }) {
  const [hostA, hostB] = [new URL(a).hostname, new URL(urlOrigin(b, { allowInsecureLocalhost })).hostname];
  // Fixtures on loopback have no registered domain; the same host stands in for it.
  if (allowInsecureLocalhost && loopback(hostA) && loopback(hostB)) return hostA === hostB;
  if (typeof registeredDomain !== "function") fail("validateOAuthServerMetadata needs registeredDomain");
  const [domainA, domainB] = [registeredDomain(hostA), registeredDomain(hostB)];
  return typeof domainA === "string" && domainA.length > 0 && domainA === domainB;
}

// The one sign-in configuration a release is pinned to, stored at upload inside
// the metadata snapshot. `packageClientId` is `provider.oauthClientId` of the
// package: a client the provider registered for PCBJam alone. Without it the
// client is the one in the provider's document, which desktop KiCad uses too.
export function providerAuthSnapshot(metadata, server, packageClientId) {
  if (metadata.authType !== "oauth2") {
    if (packageClientId !== undefined)
      fail("provider.oauthClientId needs a provider with sign-in (auth.type oauth2)");
    return undefined;
  }
  return {
    type: "oauth2",
    metadataUrl: metadata.auth.metadataUrl,
    issuer: server.issuer,
    clientId: packageClientId === undefined ? metadata.auth.clientId : oauthClientId(packageClientId),
    clientIdFrom: packageClientId === undefined ? "metadata" : "package",
    scopes: [...metadata.auth.scopes],
    authorizationEndpoint: server.authorizationEndpoint,
    tokenEndpoint: server.tokenEndpoint,
  };
}
// Whether the provider's document, read again at panel open, still describes
// the sign-in a release is pinned to. `snapshot` is the stored metadata (no
// `auth` means no sign-in, as in every release before sign-in existed). The
// client of the document is not compared when the package names its own, and a
// provider without sign-in may still move its panel on its origin.
export function sameProviderAuth(snapshot, fresh) {
  const pinned = snapshot.auth;
  if (!pinned) return fresh.authType === "none";
  if (fresh.authType !== "oauth2" || !fresh.auth) return false;
  const scopes = (list) => [...list].sort().join(" ");
  return (
    fresh.auth.metadataUrl === pinned.metadataUrl &&
    (pinned.clientIdFrom === "package" || fresh.auth.clientId === pinned.clientId) &&
    scopes(fresh.auth.scopes) === scopes(pinned.scopes) &&
    fresh.sessionBootstrapUrl === snapshot.sessionBootstrapUrl &&
    fresh.panelUrl === snapshot.panelUrl
  );
}
// Where the sign-in server sends its answer: a path on the editor that names
// the server. Built in one place; the popup and the token exchange use it.
export function loginCallbackPath(issuer) {
  return LOGIN_CALLBACK_PREFIX + new URL(issuer).host;
}
export function loginRedirectUri(editorOrigin, issuer) {
  const editor = new URL(editorOrigin);
  if (editor.origin !== editorOrigin) fail("The editor origin must be a bare origin");
  return editorOrigin + loginCallbackPath(issuer);
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
      if (asset[key] === undefined) fail("Manifest asset is missing '" + key + "' (every asset needs asset_type, name, content_type, size_bytes, sha256, download_url and required)");
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

// Approximate serialized size of a structured-cloned message, walked without
// serializing it. Stops as soon as the budget is spent, so an oversized object
// costs at most `limit` characters of work.
export function withinMessageBudget(value, limit = PROVIDER_LIMITS.messageBytes) {
  let size = 0;
  const stack = [value];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === "string") size += node.length + 2;
    else if (node && typeof node === "object") {
      size += 2;
      for (const key of Object.keys(node)) {
        if (!Array.isArray(node)) size += key.length + 3;
        stack.push(node[key]);
        if (++size > limit) return false;
      }
    } else size += 8;
    if (size > limit) return false;
  }
  return true;
}

// One JSON-RPC v1 envelope from the provider page. Accepts a string or an
// already-parsed object, both under the same size limit; refuses anything the
// desktop client would refuse.
export function validateEnvelope(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > PROVIDER_LIMITS.messageBytes) fail("Message exceeds the size limit");
    try {
      value = JSON.parse(raw);
    } catch {
      fail("Message is not valid JSON");
    }
  } else if (!withinMessageBudget(raw)) fail("Message exceeds the size limit");
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

// The text an operator approves. Without sign-in it is the origin alone, byte
// for byte what it always was, so earlier approvals hold. With sign-in it also
// names the sign-in server, and the client when a package brought its own:
// each such configuration needs its own approval. `auth` is the snapshot's.
export function providerPolicyText(origin, auth) {
  const policy = { version: 1, kind: "remote-provider", origin: providerOrigin(origin) };
  if (auth?.type === "oauth2")
    policy.auth = {
      type: "oauth2",
      issuer: auth.issuer,
      ...(auth.clientIdFrom === "package" ? { clientId: auth.clientId } : {}),
    };
  return JSON.stringify(policy);
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

/** Whether one source of a `frame-ancestors` list lets the editor's page in. */
function ancestorSourceAllows(source, editor) {
  const text = source.toLowerCase();
  if (text === "*") return true;
  // 'self' is the provider's own origin, which the editor never is.
  if (text.startsWith("'")) return false;
  const upgraded = (scheme) => scheme === "http" && editor.protocol === "https:";
  const scheme = /^([a-z][a-z0-9+.-]*):$/.exec(text);
  if (scheme) return scheme[1] + ":" === editor.protocol || upgraded(scheme[1]);
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?(?:\/.*)?$/.exec(text);
  if (!host) return false;
  const [, named, name, port] = host;
  if (named && named + ":" !== editor.protocol && !upgraded(named)) return false;
  if (name !== "*" && (name.startsWith("*.") ? !editor.hostname.endsWith(name.slice(1)) : name !== editor.hostname)) return false;
  if (port === "*") return true;
  const standard = editor.protocol === "https:" ? "443" : "80";
  // A source without a port means the standard one. An http source also stands for its https twin.
  return (port ?? standard) === (editor.port || standard) || (named === "http" && upgraded(named) && (port ?? "80") === "80" && !editor.port);
}

/**
 * Whether a browser shows the panel page inside the editor, read from the page's headers the
 * way a browser reads them. Every Content-Security-Policy that has `frame-ancestors` must let
 * the editor's origin in, and where one has it, X-Frame-Options is ignored. Without it,
 * X-Frame-Options DENY or SAMEORIGIN keeps every other site out. This is for refusing a panel
 * that can never show (the user would get an empty frame), not for proving that one will.
 */
export function checkPanelFraming(headers, editorOrigin) {
  const get = (name) =>
    typeof headers?.get === "function" ? headers.get(name) : headers?.[name] ?? null;
  const editor = new URL(editorOrigin);
  // Several headers arrive joined by commas; each one is a policy of its own.
  const lists = [];
  for (const policy of String(get("content-security-policy") ?? "").split(",")) {
    // Inside one policy the first directive of a name counts.
    const directive = policy.split(";").map((part) => part.trim().split(/\s+/)).find((words) => words[0].toLowerCase() === "frame-ancestors");
    if (directive) lists.push(directive.slice(1));
  }
  if (lists.length) {
    const closed = lists.find((sources) => !sources.some((source) => ancestorSourceAllows(source, editor)));
    return closed ? { ok: false, header: "content-security-policy", actual: ("frame-ancestors " + closed.join(" ")).trim() } : { ok: true };
  }
  const raw = get("x-frame-options");
  const values = [...new Set(String(raw ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const closed = values.length > 1
    ? values.some((value) => value === "deny" || value === "sameorigin" || value === "allowall")
    : values[0] === "deny" || values[0] === "sameorigin";
  return closed ? { ok: false, header: "x-frame-options", actual: String(raw).trim() } : { ok: true };
}
