// A plugin's backend calling the PCBJam API as the person, on one project (plugins 0025 §5.6).
// The manifest declares the most it may get (`api`), the operator reviews it with the release,
// and the backend exchanges an identity token plus a credential signed with the declared key
// for a short-lived project key that is at most that, and maybe narrower.
const fail = message => { throw new Error(message); };

export const PROJECT_API_PERMISSION = 'api:project';
export const BACKEND_CREDENTIAL_TYPE = 'pcbjam-plugin-backend+jwt';
export const BACKEND_CREDENTIAL_SECONDS = 60;
export const PROJECT_KEY_DAYS = 1;

/** A project-relative path scope: folders end with "/", files don't; no `..`, no leading "/". */
export function validPaths(paths) {
  return Array.isArray(paths) && paths.length >= 1 && paths.length <= 16 && new Set(paths).size === paths.length
    && paths.every(p => typeof p === 'string' && p.length <= 200 && !p.startsWith('/') && !/[\\\x00-\x1f]/.test(p)
      && p.replace(/\/$/, '').split('/').every(seg => seg && seg !== '.' && seg !== '..'));
}

/** Is every path of `inner` inside some path of `outer`? */
export function pathsWithin(inner, outer) {
  return inner.every(p => outer.some(o => (o.endsWith('/') ? p.startsWith(o) : p === o)));
}

/** The manifest's `api` field: `{access: "read" | "write", paths?, credentialKey}`; undefined when absent. */
export function validateProjectApi(api) {
  if (api === undefined) return undefined;
  if (!api || typeof api !== 'object' || Array.isArray(api)) fail('api must be an object');
  for (const key of Object.keys(api)) if (!['access', 'paths', 'credentialKey'].includes(key)) fail('Unsupported api field: ' + key);
  if (!['read', 'write'].includes(api.access)) fail('api.access must be read or write');
  if (api.paths !== undefined && !validPaths(api.paths)) fail('api.paths must be 1–16 project-relative paths (folders end with /)');
  if (api.paths !== undefined && api.access !== 'write') fail('api.paths limits writes: it needs access write');
  const k = api.credentialKey;
  if (!k || typeof k !== 'object' || k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string'
    || k.d !== undefined || Object.keys(k).some(key => !['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use'].includes(key)))
    fail('api.credentialKey must be the backend\'s public ES256 (P-256) JWK');
  return { access: api.access, ...(api.paths ? { paths: [...api.paths] } : {}), credentialKey: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y } };
}

/**
 * What a backend asked for, within what the manifest declares: read stays read; a path scope
 * stays inside the declared one (none declared: any). Returns the key's access and paths.
 */
export function narrowProjectAccess(declared, requested = {}) {
  const access = requested.access ?? declared.access;
  if (!['read', 'write'].includes(access) || (access === 'write' && declared.access !== 'write')) fail('More access than the plugin declares');
  if (requested.paths !== undefined && !validPaths(requested.paths)) fail('Invalid paths');
  const paths = requested.paths ?? declared.paths;
  if (access === 'write' && declared.paths && !pathsWithin(paths, declared.paths)) fail('Paths outside what the plugin declares');
  return { access, ...(access === 'write' && paths ? { paths } : {}) };
}

export function projectApiPolicyText(api) {
  return `Its own server may use PCBJam as you on the project it is opened in, for a day at a time: ${api.access === 'read' ? 'read only' : api.paths ? 'read, and write only ' + api.paths.join(', ') : 'read and write'}.`;
}
