import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedFragment, hostedUi, hostedUiPermission, hostedUiPolicyText, hostedUiUrl, wellKnownProves } from "../hosted-ui-contract.mjs";
import { validatePackage } from "../package-validation.mjs";

const ORIGIN = "https://ai-chat-pcbjam.example-acct.workers.dev";
const manifest = (ui, extra = []) => ({
  apiVersion: 1,
  id: "hosted-test",
  name: "Hosted",
  version: "1.0.0",
  description: "A plugin whose UI is its own page",
  main: "main.js",
  ui,
  surfaces: ["editor:eeschema", "editor:pcbnew"],
  permissions: ["ui:custom", "ui:project-data", ...extra],
});
const pkg = (m, files = [], options) =>
  validatePackage([{ path: "manifest.json", text: JSON.stringify(m) }, { path: "main.js", text: 'pcbjam.handle("x",()=>1)' }, ...files], options);

test("a hosted UI: no ui.html, its own permission, the origin in the reviewed policy", () => {
  const ui = { kind: "hosted", origin: ORIGIN, path: "/panel" };
  const v = pkg(manifest(ui, [hostedUiPermission(ORIGIN)]));
  assert.deepEqual(v.manifest.ui, ui);
  assert.equal(v.validationVersion, 6);
  // Moving the page to another origin is a different policy.
  const other = pkg(manifest({ ...ui, origin: "https://other.example" }, ["hosted:other.example"]));
  assert.notEqual(v.policyDigest, other.policyDigest);
  // The path defaults to the root.
  assert.equal(pkg(manifest({ kind: "hosted", origin: ORIGIN }, [hostedUiPermission(ORIGIN)])).manifest.ui.path, "/");
});

test("a hosted UI is refused without its permission, with a ui.html, or on a PCBJam or local origin", () => {
  const ui = { kind: "hosted", origin: ORIGIN, path: "/panel" };
  assert.throws(() => pkg(manifest(ui)), /hosted:<hostname> permission/);
  assert.throws(() => pkg(manifest(ui, [hostedUiPermission(ORIGIN)]), [{ path: "ui.html", text: "<p>x</p>" }]), /no ui\.html/);
  for (const origin of ["https://app.pcbjam.com", "https://pcbjam.com", "http://example.com", "https://example.com:8443", "https://example.com/x", "http://localhost:3070"])
    assert.throws(() => hostedUi({ kind: "hosted", origin, path: "/" }), /hosted UI/, origin);
  assert.throws(() => hostedUi({ kind: "hosted", origin: ORIGIN, path: "../up" }), /hosted UI/);
  assert.throws(() => hostedUi({ kind: "hosted", origin: ORIGIN, extra: 1 }), /hosted UI/);
});

test("http://localhost is a hosted origin in local development only", () => {
  const ui = { kind: "hosted", origin: "http://localhost:3070", path: "/panel" };
  assert.throws(() => pkg(manifest(ui, ["hosted:localhost"])), /hosted UI/);
  assert.equal(pkg(manifest(ui, ["hosted:localhost"]), [], { allowLocalHostedUi: true }).manifest.ui.origin, "http://localhost:3070");
});

test("the packaged ui.html keeps working as before", () => {
  const v = pkg(manifest("ui.html"), [{ path: "ui.html", text: "<p>x</p>" }]);
  assert.equal(v.manifest.ui, "ui.html");
  assert.equal(v.validationVersion, 2);
});

test("the policy text, the framed page, and the well-known proof", () => {
  const ui = hostedUi({ kind: "hosted", origin: ORIGIN, path: "/panel" });
  assert.equal(hostedUiPolicyText(ui), JSON.stringify({ version: 1, kind: "hosted-ui", origin: ORIGIN, path: "/panel" }));
  assert.equal(hostedUiUrl(ui), ORIGIN + "/panel");
  assert.equal(wellKnownProves(JSON.stringify({ "pcbjam-plugin": ["abc", "def"] }), "def"), true);
  assert.equal(wellKnownProves(JSON.stringify({ "pcbjam-plugin": ["abc"] }), "def"), false);
  assert.equal(wellKnownProves("not json", "def"), false);
});

test("a hosted page connects only to an editor it trusts", () => {
  const nonce = "0b9e2a4c-1f3d-4e5a-9b6c-7d8e9f0a1b2c";
  const editors = ["https://editor.pcbjam.com"];
  assert.deepEqual(hostedFragment(`#${nonce}&parent=${encodeURIComponent(editors[0])}`, editors), { nonce, parent: editors[0] });
  assert.equal(hostedFragment(`#${nonce}&parent=${encodeURIComponent("https://evil.example")}`, editors), null);
  assert.equal(hostedFragment(`#${nonce}`, editors), null);
  assert.equal(hostedFragment(`#not-a-nonce&parent=${encodeURIComponent(editors[0])}`, editors), null);
});
