// Shared, runtime-neutral policy. No network, credentials or environment fallback.
export const BACKEND_LIMITS = Object.freeze({
  requestBytes: 128 * 1024,
  responseBytes: 256 * 1024,
  resultBytes: 512 * 1024,
  deadlineMs: 30000,
  hostDeadlineMs: 35000,
  // One ZIP per upload; its base64 form must fit one Durable Object RPC message.
  uploadBytes: 16 * 1024 * 1024,
  uploadFields: 16,
  uploadFieldChars: 1024,
});
const UPLOAD_NAME = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
// The query of an upload URL: names the manifest declares, values the endpoint
// issued (a signed token, say). No character that could end a value or start
// another parameter. A value may end in base64 padding, "=" once or twice:
// tokens made with Ruby's urlsafe base64 carry it about one time in three
// (AISLER's do). The query string writes it as "%3D", as such a service does.
const QUERY_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const QUERY_VALUE = /^[A-Za-z0-9_-]{1,512}={0,2}$/;
const QUERY_KEYS = 8;
// A policy path may end in one placeholder segment, "/jobs/{id}".
const PLACEHOLDER = /^\{[a-z][a-z0-9]{0,15}\}$/;
const PLACEHOLDER_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
const fail = () => {
  throw new Error("Invalid plugin backend policy or request");
};
export function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail();
}
export function backendOrigin(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^https:\/\/[a-z0-9.-]+$/.test(value)
  )
    fail();
  const url = new URL(value);
  const labels = url.hostname.split(".");
  if (
    url.origin !== value ||
    labels.length < 2 ||
    labels.some(
      (l) =>
        !l ||
        l.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l) ||
        l.startsWith("xn--")
    ) ||
    !/^[a-z]{2,63}$/.test(labels.at(-1))
  )
    fail();
  if (
    ["localhost", "local", "internal", "test", "invalid", "onion"].includes(
      labels.at(-1)
    )
  )
    fail();
  return value;
}
export function backendPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^\/[A-Za-z0-9/_.-]*$/.test(value) ||
    value.includes("//") ||
    value.split("/").some((p) => p === "." || p === "..")
  )
    fail();
  return value;
}
/**
 * A path of an endpoint policy: exact, or ending in one placeholder segment
 * such as "/api/import/{job}", which stands for 1 to 64 characters of
 * [A-Za-z0-9_-] (no dot, no slash). The part before it is a literal path of at
 * least one segment, so a placeholder never covers a site's first level.
 */
export function backendPathPattern(value) {
  if (typeof value !== "string" || value.length > 512) fail();
  const cut = value.lastIndexOf("/");
  if (!PLACEHOLDER.test(value.slice(cut + 1))) return backendPath(value);
  const prefix = value.slice(0, cut);
  if (prefix.length < 2 || prefix.endsWith("/")) fail();
  backendPath(prefix);
  return value;
}
/** Whether a request path (already a valid `backendPath`) is one the policy's paths allow. */
export function pathAllowed(paths, path) {
  if (typeof path !== "string") return false;
  return paths.some((p) => {
    if (p === path) return true;
    const cut = p.lastIndexOf("/");
    return (
      PLACEHOLDER.test(p.slice(cut + 1)) &&
      path.startsWith(p.slice(0, cut + 1)) &&
      PLACEHOLDER_VALUE.test(path.slice(cut + 1))
    );
  });
}
/** The query string of an upload URL ("" or "?a=1&b=2"), from validated names and values only, in name order. */
export function uploadQueryString(query) {
  if (query === undefined || query === null) return "";
  if (typeof query !== "object" || Array.isArray(query)) fail();
  const keys = Object.keys(query).sort();
  if (keys.length > QUERY_KEYS || keys.some((k) => !QUERY_KEY.test(k) || typeof query[k] !== "string" || !QUERY_VALUE.test(query[k]))) fail();
  return keys.length ? "?" + keys.map((k) => k + "=" + query[k].replaceAll("=", "%3D")).join("&") : "";
}
export function validateEndpoints(input) {
  if (input === undefined) return undefined;
  const entries = Object.entries(input ?? {});
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    entries.length !== 1
  )
    fail();
  const output = Object.create(null);
  for (const [name, value] of entries) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) fail();
    exact(value, ["origin", "paths", "methods", "auth", "upload"]);
    const origin = backendOrigin(value.origin);
    if (
      !Array.isArray(value.paths) ||
      !value.paths.length ||
      value.paths.length > 16 ||
      new Set(value.paths).size !== value.paths.length
    )
      fail();
    const paths = value.paths.map(backendPathPattern).sort();
    if (
      !Array.isArray(value.methods) ||
      !value.methods.length ||
      value.methods.length > 2 ||
      new Set(value.methods).size !== value.methods.length ||
      value.methods.some((m) => !["GET", "POST"].includes(m))
    )
      fail();
    if (!["none", "pcbjam-user"].includes(value.auth)) fail();
    // Optional: paths that take one ZIP made by the plugin (exports.bundle) as
    // multipart/form-data. Part of the approved policy like everything else.
    // `query` names the query parameters an upload URL may carry, for endpoints
    // that hand out a signed upload URL; an upload path is never a placeholder.
    let upload;
    if (value.upload !== undefined) {
      exact(value.upload, ["paths", "field", "maxBytes", "query"]);
      const u = value.upload;
      if (
        !value.methods.includes("POST") ||
        !Array.isArray(u.paths) || !u.paths.length || new Set(u.paths).size !== u.paths.length ||
        u.paths.some((p) => !paths.includes(p) || p.includes("{")) ||
        typeof u.field !== "string" || !UPLOAD_NAME.test(u.field) ||
        !Number.isSafeInteger(u.maxBytes) || u.maxBytes < 1 || u.maxBytes > BACKEND_LIMITS.uploadBytes ||
        (u.query !== undefined &&
          (!Array.isArray(u.query) || !u.query.length || u.query.length > QUERY_KEYS ||
            new Set(u.query).size !== u.query.length ||
            u.query.some((k) => typeof k !== "string" || !QUERY_KEY.test(k))))
      )
        fail();
      // Added only when declared, so an older policy keeps its text and digest.
      upload = { paths: [...u.paths].sort(), field: u.field, maxBytes: u.maxBytes, ...(u.query ? { query: [...u.query].sort() } : {}) };
    }
    output[name] = {
      origin,
      paths,
      methods: [...value.methods].sort(),
      auth: value.auth,
      ...(upload ? { upload } : {}),
    };
  }
  return output;
}
export function backendPolicyText(endpoint) {
  return JSON.stringify({
    version: 1,
    ...validateEndpoints({ backend: endpoint }).backend,
  });
}
export function backendPermissions(endpoints) {
  return Object.fromEntries(
    Object.entries(endpoints ?? {}).flatMap(([name, p]) => [
      ["network:" + name, (p.upload ? "Send data and upload files to " : "Send data to ") + p.origin],
      ...(p.auth === "pcbjam-user"
        ? [
            [
              "backend:identity:" + name,
              "Identify you to " + p.origin + " using a signed request",
            ],
          ]
        : []),
    ])
  );
}
export function validateBackendRequest(value, policy) {
  exact(value, ["endpointId", "method", "path", "json"]);
  if (
    typeof value.endpointId !== "string" ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(value.endpointId) ||
    !["GET", "POST"].includes(value.method)
  )
    fail();
  backendPath(value.path);
  if (
    (value.method === "GET" && Object.hasOwn(value, "json")) ||
    (value.method === "POST" && !Object.hasOwn(value, "json"))
  )
    fail();
  let nodes = 0;
  function visit(v, depth) {
    if (++nodes > 16000 || depth > 32) fail();
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return;
    if (
      !v ||
      typeof v !== "object" ||
      (!Array.isArray(v) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
    )
      fail();
    for (const x of Object.values(v)) visit(x, depth + 1);
  }
  if (Object.hasOwn(value, "json")) visit(value.json, 0);
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    BACKEND_LIMITS.requestBytes
  )
    fail();
  if (
    policy &&
    (!pathAllowed(policy.paths, value.path) ||
      !policy.methods.includes(value.method))
  )
    fail();
  return value;
}

/** An upload of a bundle (exports.bundle) to an endpoint path that declares `upload`. */
export function validateUploadRequest(value, policy) {
  exact(value, ["endpointId", "path", "bundleId", "fields", "query"]);
  const fields = value.fields ?? {};
  const query = value.query ?? {};
  if (
    typeof value.endpointId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.endpointId) ||
    typeof value.bundleId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.bundleId) ||
    !fields || typeof fields !== "object" || Array.isArray(fields) ||
    Object.keys(fields).length > BACKEND_LIMITS.uploadFields ||
    Object.entries(fields).some(([k, v]) => !UPLOAD_NAME.test(k) || typeof v !== "string" || v.length > BACKEND_LIMITS.uploadFieldChars || /[\r\n]/.test(v)) ||
    !query || typeof query !== "object" || Array.isArray(query) ||
    Object.keys(query).length > QUERY_KEYS ||
    Object.entries(query).some(([k, v]) => !QUERY_KEY.test(k) || typeof v !== "string" || !QUERY_VALUE.test(v))
  )
    fail();
  backendPath(value.path);
  if (
    policy &&
    (!policy.upload || !policy.upload.paths.includes(value.path) || Object.hasOwn(fields, policy.upload.field) ||
      Object.keys(query).some((k) => !(policy.upload.query ?? []).includes(k)))
  )
    fail();
  return value;
}
