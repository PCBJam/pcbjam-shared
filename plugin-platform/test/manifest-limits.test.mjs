import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveRates, validateLimits, DEFAULT_RATES } from "../manifest-limits.mjs";
import { hostedUi } from "../hosted-ui-contract.mjs";
import { validatePackage } from "../package-validation.mjs";

test("a plugin's own rates: from its defaults up to the ceilings, and part of its policy", () => {
  assert.deepEqual(validateLimits({ uiCommandsPer10s: 100, hostCallsPer10s: 300 }), { uiCommandsPer10s: 100, hostCallsPer10s: 300 });
  for (const bad of [{ uiCommandsPer10s: 121 }, { hostCallsPer10s: 39 }, { other: 50 }, { uiCommandsPer10s: 1.5 }, []])
    assert.throws(() => validateLimits(bad), /limits/, JSON.stringify(bad));
  assert.deepEqual(effectiveRates(undefined), DEFAULT_RATES);
  assert.deepEqual(effectiveRates({ uiCommandsPer10s: 100 }), { uiCommandsPer10s: 100, hostCallsPer10s: 40 });
  assert.deepEqual(effectiveRates({ uiCommandsPer10s: 9999 }), { uiCommandsPer10s: 120, hostCallsPer10s: 40 });
  const m = (limits) => validatePackage([
    { path: "manifest.json", text: JSON.stringify({ apiVersion: 1, id: "rates-test", name: "Rates", version: "1.0.0", description: "", main: "main.js", ui: "ui.html", surfaces: ["editor:eeschema"], permissions: ["ui:custom", "ui:project-data"], ...(limits ? { limits } : {}) }) },
    { path: "main.js", text: "x" }, { path: "ui.html", text: "<p>x</p>" },
  ]);
  assert.notEqual(m(undefined).policyDigest, m({ uiCommandsPer10s: 100 }).policyDigest);
});

test("a hosted UI may be persistent", () => {
  const origin = "https://plugin.example";
  assert.equal(hostedUi({ kind: "hosted", origin, path: "/p", persistent: true }).persistent, true);
  assert.equal(hostedUi({ kind: "hosted", origin, path: "/p" }).persistent, undefined);
  assert.throws(() => hostedUi({ kind: "hosted", origin, path: "/p", persistent: false }), /hosted UI/);
});
