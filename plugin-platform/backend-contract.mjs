// Shared, runtime-neutral policy. No network, credentials or environment fallback.
export const BACKEND_LIMITS = Object.freeze({
  requestBytes: 128 * 1024,
  responseBytes: 256 * 1024,
  resultBytes: 512 * 1024,
  deadlineMs: 30000,
  hostDeadlineMs: 35000,
});
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
    exact(value, ["origin", "paths", "methods", "auth"]);
    const origin = backendOrigin(value.origin);
    if (
      !Array.isArray(value.paths) ||
      !value.paths.length ||
      value.paths.length > 16 ||
      new Set(value.paths).size !== value.paths.length
    )
      fail();
    const paths = value.paths.map(backendPath).sort();
    if (
      !Array.isArray(value.methods) ||
      !value.methods.length ||
      value.methods.length > 2 ||
      new Set(value.methods).size !== value.methods.length ||
      value.methods.some((m) => !["GET", "POST"].includes(m))
    )
      fail();
    if (!["none", "pcbjam-user"].includes(value.auth)) fail();
    output[name] = {
      origin,
      paths,
      methods: [...value.methods].sort(),
      auth: value.auth,
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
      ["network:" + name, "Send data to " + p.origin],
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
    (!policy.paths.includes(value.path) ||
      !policy.methods.includes(value.method))
  )
    fail();
  return value;
}
