import { test } from "node:test";
import assert from "node:assert/strict";
import { narrowProjectAccess, pathsWithin, validateProjectApi, validPaths } from "../project-api-contract.mjs";
import { validatePackage } from "../package-validation.mjs";

const KEY = { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) };
const ORIGIN = "https://chat.example-acct.workers.dev";
const manifest = (extra = {}, permissions = []) => ({
  apiVersion: 1, id: "api-test", name: "API", version: "1.0.0", description: "", main: "main.js",
  ui: { kind: "hosted", origin: ORIGIN, path: "/" }, surfaces: ["editor:eeschema"],
  permissions: ["ui:custom", "ui:project-data", "hosted:chat.example-acct.workers.dev", ...permissions], ...extra,
});
const pkg = (m) => validatePackage([{ path: "manifest.json", text: JSON.stringify(m) }, { path: "main.js", text: "pcbjam.handle('x',()=>1)" }]);

test("the manifest's api: access, a path scope that limits writes, and the backend's public key", () => {
  assert.deepEqual(validateProjectApi({ access: "write", paths: [".ai-memories/"], credentialKey: { ...KEY, kid: "k", alg: "ES256", use: "sig" } }),
    { access: "write", paths: [".ai-memories/"], credentialKey: KEY });
  for (const [api, error] of [
    [{ access: "admin", credentialKey: KEY }, /read or write/],
    [{ access: "read", paths: ["a/"], credentialKey: KEY }, /needs access write/],
    [{ access: "write", paths: ["../x/"], credentialKey: KEY }, /project-relative/],
    [{ access: "write", credentialKey: { ...KEY, d: "secret" } }, /public ES256/],
    [{ access: "write", credentialKey: { ...KEY, crv: "P-384" } }, /public ES256/],
    [{ access: "write", credentialKey: KEY, extra: 1 }, /Unsupported api field/],
  ]) assert.throws(() => validateProjectApi(api), error);
});

test("a key is at most what the manifest declares", () => {
  const declared = { access: "write", paths: [".ai-memories/", ".ai-checks/"], credentialKey: KEY };
  assert.deepEqual(narrowProjectAccess(declared), { access: "write", paths: [".ai-memories/", ".ai-checks/"] });
  assert.deepEqual(narrowProjectAccess(declared, { access: "read" }), { access: "read" });
  assert.deepEqual(narrowProjectAccess(declared, { paths: [".ai-memories/x.md"] }), { access: "write", paths: [".ai-memories/x.md"] });
  assert.throws(() => narrowProjectAccess(declared, { paths: ["docs/"] }), /outside/);
  assert.throws(() => narrowProjectAccess({ access: "read", credentialKey: KEY }, { access: "write" }), /More access/);
  // No declared scope: any scope narrows it, none keeps full write.
  assert.deepEqual(narrowProjectAccess({ access: "write", credentialKey: KEY }), { access: "write" });
  assert.deepEqual(narrowProjectAccess({ access: "write", credentialKey: KEY }, { paths: ["docs/"] }), { access: "write", paths: ["docs/"] });
  assert.equal(pathsWithin(["a/b.md"], ["a/"]), true);
  assert.equal(validPaths(["a//b"]), false);
});

test("api goes with api:project and a hosted UI, and is part of the reviewed policy", () => {
  const api = { access: "write", credentialKey: KEY };
  const v = pkg(manifest({ api }, ["api:project"]));
  assert.deepEqual(v.manifest.api, api);
  assert.notEqual(v.policyDigest, pkg(manifest({ api: { access: "read", credentialKey: KEY } }, ["api:project"])).policyDigest);
  assert.throws(() => pkg(manifest({ api })), /go together/);
  assert.throws(() => pkg(manifest({}, ["api:project"])), /go together/);
});
