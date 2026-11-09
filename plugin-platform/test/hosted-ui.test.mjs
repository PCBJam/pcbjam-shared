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

test("contributions: where a hosted plugin's pages show up in the web app", async () => {
  const { validateContributes, contributionPath } = await import("../hosted-ui-contract.mjs");
  const ui = { kind: "hosted", origin: ORIGIN, path: "/panel" };
  const contributes = {
    adminNav: [{ label: "AI chat", path: "/admin" }],
    adminUser: [{ label: "AI usage", path: "/admin/users/{userId}" }],
    adminProject: [{ label: "AI chats", path: "/admin/projects/{projectId}" }],
    userSettings: [{ label: "AI usage", path: "/settings" }],
    projectSettings: [{ section: "git", path: "/project/{projectId}/git", height: 120 }],
  };
  assert.deepEqual(pkg(manifest(ui, [hostedUiPermission(ORIGIN)]), [], undefined).manifest.contributes, undefined);
  assert.deepEqual(validatePackage([{ path: "manifest.json", text: JSON.stringify({ ...manifest(ui, [hostedUiPermission(ORIGIN)]), contributes }) }, { path: "main.js", text: "x" }]).manifest.contributes, contributes);
  // Only with a hosted UI.
  assert.throws(() => pkg({ ...manifest("ui.html"), contributes }, [{ path: "ui.html", text: "<p>x</p>" }]), /hosted ui/);
  for (const bad of [
    { nope: [{ label: "x", path: "/x" }] },
    { adminNav: [] },
    { adminNav: [{ label: "", path: "/x" }] },
    { adminNav: [{ label: "x", path: "relative" }] },
    { adminNav: [{ label: "x", path: "/users/{userId}" }] },
    { adminUser: [{ label: "x", path: "/p/{projectId}" }] },
    { projectSettings: [{ section: "danger", path: "/x" }] },
    { projectSettings: [{ section: "git", path: "/x", height: 5 }] },
    { adminNav: [{ label: "x", path: "/x", extra: 1 }] },
  ])
    assert.throws(() => validateContributes(bad), /contributes/, JSON.stringify(bad));
  const id = "0b9e2a4c-1f3d-4e5a-9b6c-7d8e9f0a1b2c";
  assert.equal(contributionPath("/admin/users/{userId}", { userId: id }), "/admin/users/" + id);
  assert.equal(contributionPath("/admin/users/{userId}", { userId: "Mfil3GpsHa3ffGtfcYL5yrAOdr5FY90q" }), "/admin/users/Mfil3GpsHa3ffGtfcYL5yrAOdr5FY90q");
  assert.throws(() => contributionPath("/admin/users/{userId}", { userId: "../x" }), /userId/);
  assert.throws(() => contributionPath("/admin/users/{userId}", {}), /userId/);
});

test("identity permissions need a hosted UI, and the admin role an admin page (plugins 0025 §5.5)", () => {
  const ui = { kind: "hosted", origin: ORIGIN, path: "/panel" };
  const claims = ["identity:subject", "identity:account", "identity:entitlements"];
  assert.deepEqual(pkg(manifest(ui, [hostedUiPermission(ORIGIN), ...claims])).manifest.permissions.slice(-3), claims);
  // A packaged ui.html has no site of its own to give a token to.
  assert.throws(() => pkg({ ...manifest("ui.html", ["identity:subject"]) }, [{ path: "ui.html", text: "<p>x</p>" }]), /need a hosted ui/);
  assert.throws(() => pkg(manifest(ui, [hostedUiPermission(ORIGIN), "identity:role"])), /admin page/);
  const admin = { ...manifest(ui, [hostedUiPermission(ORIGIN), "identity:role"]), contributes: { adminNav: [{ label: "Usage", path: "/admin" }] } };
  assert.ok(pkg(admin).manifest.permissions.includes("identity:role"));
});
