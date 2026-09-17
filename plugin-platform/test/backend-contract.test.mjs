import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  validateEndpoints,
  validateBackendRequest,
  backendOrigin,
  backendPath,
} from "../backend-contract.mjs";
import { validatePackage } from "../package-validation.mjs";
const endpoint = {
  origin: "https://api.author.example",
  paths: ["/v1/preferences"],
  methods: ["GET", "POST"],
  auth: "pcbjam-user",
};
const manifest = {
  apiVersion: 1,
  id: "backend-test",
  name: "Test",
  version: "1.0.0",
  description: "Test",
  main: "main.js",
  ui: "ui.html",
  surfaces: ["editor:eeschema"],
  permissions: ["ui:custom", "ui:project-data"],
};
const pkg = (m) =>
  validatePackage([
    { path: "manifest.json", text: JSON.stringify(m) },
    { path: "main.js", text: 'pcbjam.handle("x",()=>1)' },
    { path: "ui.html", text: "<p>Test</p>" },
  ]);
test("old packages keep their consent digest; new endpoints require exact dynamic grants", () => {
  const old = pkg(manifest);
  assert.equal(
    old.policyDigest,
    createHash("sha256")
      .update(
        JSON.stringify({
          apiVersion: 1,
          permissions: [...manifest.permissions].sort(),
        })
      )
      .digest("hex")
  );
  assert.equal(old.validationVersion, 2);
  assert.throws(() => pkg({ ...manifest, endpoints: { backend: endpoint } }));
  const network = {
    ...manifest,
    permissions: [
      ...manifest.permissions,
      "network:backend",
      "backend:identity:backend",
    ],
    endpoints: { backend: endpoint },
  };
  const first = pkg(network);
  assert.equal(first.validationVersion, 3);
  for (const change of [
    { origin: "https://different.example" },
    { paths: ["/v1/new"] },
    { methods: ["POST"] },
  ])
    assert.notEqual(
      pkg({ ...network, endpoints: { backend: { ...endpoint, ...change } } })
        .policyDigest,
      first.policyDigest
    );
  assert.throws(() =>
    pkg({ ...network, permissions: [...network.permissions, "network:other"] })
  );
  assert.throws(() =>
    pkg({
      ...manifest,
      permissions: [...manifest.permissions, "network:backend"],
    })
  );
});
test("strict canonical origins, paths, methods and declaration sizes", () => {
  for (const origin of [
    "http://api.example",
    "https://api.example:443",
    "https://API.example",
    "https://user@api.example",
    "https://127.1",
    "https://2130706433",
    "https://[::1]",
    "https://foo.local",
    "https://foo.internal",
    "https://api.example.",
    "https://xn--hello.example",
    "https://api.example/",
  ])
    assert.throws(() => backendOrigin(origin));
  for (const path of [
    "/a?b=c",
    "/a#fragment",
    "//a",
    "/a/../b",
    "/%61",
    "/foo\\bar",
    "/é",
    "/a/./b",
  ])
    assert.throws(() => backendPath(path));
  for (const policy of [
    { ...endpoint, methods: ["PUT"] },
    { ...endpoint, paths: ["/a", "/a"] },
    { ...endpoint, auth: "bearer" },
    { ...endpoint, headers: {} },
  ])
    assert.throws(() => validateEndpoints({ backend: policy }));
  assert.throws(() => validateEndpoints({ a: endpoint, b: endpoint }));
  assert.throws(() => validateEndpoints([]));
});
test("request JSON limits and method/path restrictions cannot be overridden", () => {
  const request = {
    endpointId: "backend",
    method: "POST",
    path: "/v1/preferences",
    json: { a: 1 },
  };
  assert.deepEqual(validateBackendRequest(request, endpoint), request);
  for (const value of [
    { ...request, json: "x".repeat(128 * 1024) },
    { ...request, path: "/admin" },
    { ...request, method: "GET" },
    { ...request, headers: {} },
    { ...request, audience: "other" },
    { ...request, json: NaN },
    { ...request, json: new Date() },
  ])
    assert.throws(() => validateBackendRequest(value, endpoint));
  let depth = {};
  for (let i = 0; i < 34; i++) depth = { depth };
  assert.throws(() => validateBackendRequest({ ...request, json: depth }));
});
