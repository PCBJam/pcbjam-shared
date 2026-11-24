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

test("an endpoint may declare upload paths; uploads stay inside that declaration", async () => {
  const { validateUploadRequest, backendPermissions, backendPolicyText } = await import("../backend-contract.mjs");
  const pcbway = { origin: "https://www.pcbway.com", paths: ["/Common/KiCadUpFile/"], methods: ["POST"], auth: "none", upload: { paths: ["/Common/KiCadUpFile/"], field: "upload[file]", maxBytes: 16 * 1024 * 1024 } };
  const { pcbway: policy } = validateEndpoints({ pcbway });
  assert.deepEqual(policy.upload, { paths: ["/Common/KiCadUpFile/"], field: "upload[file]", maxBytes: 16 * 1024 * 1024 });
  // The upload is part of what the operator approves and what the user sees.
  assert.notEqual(backendPolicyText(policy), backendPolicyText({ ...policy, upload: undefined }));
  assert.equal(backendPermissions({ pcbway: policy })["network:pcbway"], "Send data and upload files to https://www.pcbway.com");
  assert.equal(backendPermissions({ other: validateEndpoints({ other: endpoint }).other })["network:other"], "Send data to https://api.author.example");
  for (const bad of [
    { ...pcbway, methods: ["GET"] },
    { ...pcbway, upload: { ...pcbway.upload, paths: ["/elsewhere"] } },
    { ...pcbway, upload: { ...pcbway.upload, field: 'f"; x="y' } },
    { ...pcbway, upload: { ...pcbway.upload, maxBytes: 17 * 1024 * 1024 } },
    { ...pcbway, upload: { ...pcbway.upload, extra: 1 } },
  ])
    assert.throws(() => validateEndpoints({ pcbway: bad }));
  const request = { endpointId: "pcbway", path: "/Common/KiCadUpFile/", bundleId: "11111111-1111-4111-8111-111111111111", fields: { boardWidth: "50.00", boardLayer: "2" } };
  assert.deepEqual(validateUploadRequest(request, policy), request);
  for (const bad of [
    { ...request, path: "/Common/Other/" },
    { ...request, bundleId: "not-a-uuid" },
    { ...request, fields: { "upload[file]": "shadow" } },
    { ...request, fields: { a: "x\r\ny" } },
    { ...request, fields: { a: 1 } },
    { ...request, extra: true },
  ])
    assert.throws(() => validateUploadRequest(bad, policy), undefined, JSON.stringify(bad));
  // An endpoint without an upload declaration takes no uploads.
  assert.throws(() => validateUploadRequest({ ...request, path: "/v1/preferences" }, validateEndpoints({ backend: endpoint }).backend));
});

test("an upload may carry the query parameters its endpoint declares, and nothing else", async () => {
  const { validateUploadRequest, backendPolicyText, uploadQueryString } = await import("../backend-contract.mjs");
  const fab = {
    origin: "https://fab.example",
    paths: ["/api/import", "/p/new.json"],
    methods: ["GET", "POST"],
    auth: "none",
    upload: { paths: ["/api/import"], field: "upload[file]", maxBytes: 1024, query: ["s", "p"] },
  };
  const { fab: policy } = validateEndpoints({ fab });
  assert.deepEqual(policy.upload.query, ["p", "s"]);
  // The names are part of what the operator approves; a policy without them keeps its old text.
  const plain = validateEndpoints({ fab: { ...fab, upload: { ...fab.upload, query: undefined } } }).fab;
  assert.equal(Object.hasOwn(plain.upload, "query"), false);
  assert.notEqual(backendPolicyText(policy), backendPolicyText(plain));
  assert.notEqual(backendPolicyText(policy), backendPolicyText({ ...policy, upload: { ...policy.upload, query: ["p"] } }));
  for (const query of [[], ["p", "p"], ["a b"], ["a="], ["a&b"], [1], "p", ["x".repeat(33)], ["a", "b", "c", "d", "e", "f", "g", "h", "i"]])
    assert.throws(() => validateEndpoints({ fab: { ...fab, upload: { ...fab.upload, query } } }), undefined, JSON.stringify(query));

  const request = { endpointId: "fab", path: "/api/import", bundleId: "11111111-1111-4111-8111-111111111111", query: { p: "A".repeat(164), s: "0f".repeat(32) } };
  assert.deepEqual(validateUploadRequest(request, policy), request);
  assert.equal(uploadQueryString(request.query), "?p=" + "A".repeat(164) + "&s=" + "0f".repeat(32));
  assert.equal(uploadQueryString({ s: "2", p: "1" }), "?p=1&s=2");
  // A signed token may end in base64 padding; the query string carries it encoded.
  for (const p of ["A".repeat(163) + "=", "A".repeat(162) + "==", "a="]) {
    assert.deepEqual(validateUploadRequest({ ...request, query: { p } }, policy).query, { p });
    assert.equal(uploadQueryString({ p, s: "1" }), "?p=" + p.replaceAll("=", "%3D") + "&s=1");
  }
  assert.equal(uploadQueryString(undefined), "");
  assert.equal(uploadQueryString({}), "");
  // A declared name may be left out; the endpoint decides what it needs.
  assert.deepEqual(validateUploadRequest({ ...request, query: { p: "1" } }, policy).query, { p: "1" });
  for (const query of [
    { p: "1", other: "2" },
    { p: "" },
    { p: "a&s=b" },
    { p: "a=b" },
    { p: "=" },
    { p: "a===" },
    { p: "=a" },
    { p: "a%3D" },
    { p: "x".repeat(512) + "===" },
    { p: "a b" },
    { p: "a%26b" },
    { p: "a#b" },
    { p: "a/b" },
    { p: "a\r\nb" },
    { p: "x".repeat(513) },
    { p: 1 },
    { p: ["1"] },
    ["p"],
    "p=1",
  ])
    assert.throws(() => validateUploadRequest({ ...request, query }, policy), undefined, JSON.stringify(query));
  for (const query of [{ "p&q": "1" }, { p: "a&b" }, { p: "a=b" }, { p: "=" }, { p: 1 }])
    assert.throws(() => uploadQueryString(query), undefined, JSON.stringify(query));
  // An endpoint that declares no query takes none, and a path never carries one.
  assert.throws(() => validateUploadRequest(request, plain));
  assert.deepEqual(validateUploadRequest({ ...request, query: {} }, plain).query, {});
  assert.throws(() => validateUploadRequest({ ...request, path: "/api/import?p=1", query: undefined }, policy));
});

test("a policy path may end in one placeholder segment", async () => {
  const { backendPathPattern, pathAllowed } = await import("../backend-contract.mjs");
  const fab = { origin: "https://fab.example", paths: ["/api/import/{job}", "/api/import", "/p/new.json"], methods: ["GET", "POST"], auth: "none" };
  const { fab: policy } = validateEndpoints({ fab });
  assert.deepEqual(policy.paths, ["/api/import", "/api/import/{job}", "/p/new.json"]);
  const get = (path) => ({ endpointId: "fab", method: "GET", path });
  for (const path of ["/api/import", "/p/new.json", "/api/import/5f1c0a2b9d3e4f5a6b7c8d9e", "/api/import/a", "/api/import/A_b-9", "/api/import/" + "a".repeat(64)])
    assert.deepEqual(validateBackendRequest(get(path), policy), get(path), path);
  for (const path of [
    "/api/import/",
    "/api/import/a/b",
    "/api/import/a.json",
    "/api/import/" + "a".repeat(65),
    "/api/import/{job}",
    "/api/imports/a",
    "/api/a",
    "/p/a",
    "/a",
    "/api/import/..",
  ])
    assert.throws(() => validateBackendRequest(get(path), policy), undefined, path);
  assert.equal(pathAllowed(policy.paths, "/api/import/abc"), true);
  assert.equal(pathAllowed(["/api/import"], "/api/import/abc"), false);
  // Only the last segment, only once, and never the site's first level.
  for (const path of ["/{id}", "/{a}/b", "/a/{b}/c", "/a/{b}{c}", "/a/x{b}", "/a/{b}x", "/a/{B}", "/a/{}", "/a/{1a}", "/a/{" + "a".repeat(17) + "}", "/a//{b}", "/a/{b}/"])
    assert.throws(() => backendPathPattern(path), undefined, path);
  assert.equal(backendPathPattern("/a/{b}"), "/a/{b}");
  assert.equal(backendPathPattern("/a/b"), "/a/b");
  // The placeholder is part of the approved policy text.
  const { backendPolicyText } = await import("../backend-contract.mjs");
  assert.notEqual(backendPolicyText(policy), backendPolicyText({ ...policy, paths: ["/api/import", "/p/new.json"] }));
  // An upload never goes to a placeholder path.
  assert.throws(() =>
    validateEndpoints({ fab: { ...fab, upload: { paths: ["/api/import/{job}"], field: "file", maxBytes: 1024 } } })
  );
});
