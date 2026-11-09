// A plugin UI served from the plugin's own origin (plugins 0025 §5.1), next to the packaged
// ui.html: the editor frames that origin's page, which may then hold its own connections
// (a WebSocket to the plugin's backend) and run any bundle. The origin is consented to by the
// person and approved by an operator who saw it proven (DNS TXT, or HOSTED_UI_WELL_KNOWN on
// the origin itself, which also works on hosts like workers.dev where nobody can add DNS).
import { backendOrigin, backendPath } from './backend-contract.mjs';

export const HOSTED_UI_WELL_KNOWN = '/.well-known/pcbjam-plugin.json';
// The editor is cross-origin isolated (COEP require-corp, for SharedArrayBuffer): a framed
// page only loads when it opts in, as a remote provider's panel does.
export const HOSTED_UI_HEADERS = Object.freeze({
  'cross-origin-embedder-policy': Object.freeze(['require-corp']),
  'cross-origin-resource-policy': Object.freeze(['cross-origin']),
});

const fail = () => {
  throw new Error('ui: a hosted UI is {"kind":"hosted","origin":"https://…","path":"/…"}: an https origin with a public hostname (no path or port), not a PCBJam host, and an absolute path');
};
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/;

/**
 * The manifest's hosted `ui`, normalized. `allowLocalhost` admits http://localhost (and
 * 127.0.0.1) origins, for local development only (plugins 0025 §12).
 */
export function hostedUi(value, { allowLocalhost = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (keys.some((k) => !['kind', 'origin', 'path'].includes(k)) || value.kind !== 'hosted') fail();
  let origin;
  if (allowLocalhost && typeof value.origin === 'string' && LOCAL_ORIGIN.test(value.origin)) origin = value.origin;
  else {
    try {
      origin = backendOrigin(value.origin);
    } catch {
      fail();
    }
    const host = new URL(origin).hostname;
    if (host === 'pcbjam.com' || host.endsWith('.pcbjam.com')) fail();
  }
  let path = '/';
  if (value.path !== undefined) {
    try {
      path = backendPath(value.path);
    } catch {
      fail();
    }
  }
  return { kind: 'hosted', origin, path };
}

export const isHostedUi = (ui) => !!ui && typeof ui === 'object' && ui.kind === 'hosted';
export const hostedUiPermission = (origin) => 'hosted:' + new URL(origin).hostname;
/** Consent text, keyed by its permission. */
export function hostedUiPermissions(origin) {
  return {
    [hostedUiPermission(origin)]: `Show a page from ${origin} inside the editor. That site runs its own code, and sees what this plugin's interface sends it.`,
  };
}
/** The reviewed policy: the origin and the page, so moving either needs a new approval. */
export function hostedUiPolicyText(ui) {
  return JSON.stringify({ version: 1, kind: 'hosted-ui', origin: ui.origin, path: ui.path });
}
/** The page the editor frames for a hosted UI. */
export const hostedUiUrl = (ui) => ui.origin + ui.path;
/**
 * The well-known proof: the origin serves {"pcbjam-plugin":["<challenge hash>", …]} at
 * HOSTED_UI_WELL_KNOWN. True when `body` (its text) lists `challengeHash`.
 */
export function wellKnownProves(body, challengeHash) {
  try {
    const doc = JSON.parse(body);
    const list = doc && typeof doc === 'object' ? doc['pcbjam-plugin'] : undefined;
    return Array.isArray(list) && list.includes(challengeHash);
  } catch {
    return false;
  }
}

/**
 * The editor and nonce a hosted page was opened with (`#<nonce>&parent=<origin>`), or null when
 * it wasn't opened by one of `editors`, the editor origins the page trusts.
 */
export function hostedFragment(hash, editors) {
  const [nonce, ...rest] = String(hash).replace(/^#/, '').split('&');
  const parent = new URLSearchParams(rest.join('&')).get('parent');
  if (!nonce || !/^[0-9a-f-]{36}$/.test(nonce) || !parent || !editors.includes(parent)) return null;
  return { nonce, parent };
}

/**
 * Where a hosted plugin's pages show up in the web app (plugins 0025 §5.2): each entry is a
 * label and a page on the plugin's own origin. `{userId}` and `{projectId}` are filled in by
 * the web app, and only where they make sense.
 */
export const CONTRIBUTION_KINDS = Object.freeze({
  adminNav: { placeholders: [] },
  adminUser: { placeholders: ['{userId}'] },
  adminProject: { placeholders: ['{projectId}'] },
  userSettings: { placeholders: [] },
  projectSettings: { placeholders: ['{projectId}'], sections: ['git'] },
});
const contributionFail = (why) => {
  throw new Error('contributes: ' + why);
};
export function validateContributes(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) contributionFail('an object of kinds');
  const out = {};
  for (const [kind, entries] of Object.entries(input)) {
    const spec = CONTRIBUTION_KINDS[kind];
    if (!spec) contributionFail(`unknown kind ${kind}`);
    if (!Array.isArray(entries) || !entries.length || entries.length > 4) contributionFail(`${kind} holds 1-4 entries`);
    out[kind] = entries.map((e) => {
      const allowed = spec.sections ? ['section', 'path', 'height'] : ['label', 'path'];
      if (!e || typeof e !== 'object' || Object.keys(e).some((k) => !allowed.includes(k))) contributionFail(`${kind}: ${allowed.join(', ')}`);
      if (!spec.sections && (typeof e.label !== 'string' || !e.label.trim() || e.label.length > 40)) contributionFail(`${kind}: a label of 1-40 characters`);
      if (spec.sections && !spec.sections.includes(e.section)) contributionFail(`${kind}: section is one of ${spec.sections.join(', ')}`);
      if (spec.sections && e.height !== undefined && !(Number.isInteger(e.height) && e.height >= 40 && e.height <= 2000)) contributionFail(`${kind}: height is 40-2000 pixels`);
      let bare = typeof e.path === 'string' ? e.path : '';
      for (const p of spec.placeholders) bare = bare.split(p).join('x');
      try {
        backendPath(bare);
      } catch {
        contributionFail(`${kind}: an absolute path, with ${spec.placeholders.join(' or ') || 'no placeholders'}`);
      }
      if (/[{}]/.test(bare)) contributionFail(`${kind}: only ${spec.placeholders.join(' or ') || 'no placeholders'}`);
      return spec.sections ? { section: e.section, path: e.path, ...(e.height !== undefined ? { height: e.height } : {}) } : { label: e.label.trim(), path: e.path };
    });
  }
  return out;
}
/** A contribution's page for one object: its placeholders filled in (ids of letters, digits, - and _). */
export function contributionPath(path, values = {}) {
  return path.replace(/\{(userId|projectId)\}/g, (_, key) => {
    const v = values[key];
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error('contributes: ' + key + ' is missing');
    return v;
  });
}
