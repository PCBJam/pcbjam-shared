// Direct HTTPS from the plugin Worker (plugins 0022 M3): the sites a plugin may call, shared by
// the manifest validator, the editor host, the runtime-asset server and the Worker itself, so
// the consent text, the Worker's CSP and the Worker's own check always name the same list.
import { backendOrigin } from './backend-contract.mjs';

export const NET_LIMITS = Object.freeze({
  sites: 8,
  requestBytes: 128 * 1024,
  responseBytes: 1024 * 1024,
  timeoutMs: 30000,
  inFlight: 4,
  perMinute: 30,
});
export const NET_METHODS = Object.freeze(['GET', 'POST']);
export const NET_HEADERS = Object.freeze(['accept', 'content-type', 'authorization']);
// Never a plugin's site: ours (the editor, API, plugin UI and storage run on these hosts),
// and names that only resolve inside a local network.
const PLATFORM_HOSTS = ['pcbjam.com', 'workers.dev', 'pages.dev', 'r2.dev', 'cloudflarestorage.com'];
const LOCAL_TLDS = ['arpa', 'lan', 'home', 'corp', 'localdomain'];
const fail = () => {
  throw new Error('network: each site must be an https origin with a public hostname, no path or port, and not a PCBJam host');
};

export function directOrigin(value) {
  try {
    backendOrigin(value);
  } catch {
    fail();
  }
  const host = new URL(value).hostname;
  if (PLATFORM_HOSTS.some((h) => host === h || host.endsWith('.' + h)) || LOCAL_TLDS.includes(host.split('.').at(-1))) fail();
  return value;
}
/** Code-unit order, so every runtime sorts a list the same way. */
export const canonicalSites = (sites) => [...sites].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** The manifest's `network`: 1-8 distinct sites, in canonical order. */
export function validateNetwork(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length < 1 || input.length > NET_LIMITS.sites) fail();
  const sites = input.map(directOrigin);
  if (new Set(sites).size !== sites.length) fail();
  return canonicalSites(sites);
}
export const sitePermission = (site) => 'direct:' + new URL(site).hostname;
/** Consent text per site, keyed by its permission. */
export function directPermissions(network) {
  return Object.fromEntries((network ?? []).map((site) => [sitePermission(site), 'Send data from your browser to ' + new URL(site).hostname]));
}
/** The Worker URL segment for a site list: its hostnames, canonical, comma-separated. */
export function sitesSegment(sites) {
  return validateNetwork(sites).map((site) => new URL(site).hostname).join(',');
}
/** The sites a Worker URL segment names, or null unless it is exactly the canonical form, so one
 *  list has one URL and one CSP. */
export function sitesFromSegment(segment) {
  if (typeof segment !== 'string' || !/^[a-z0-9.,-]{1,2100}$/.test(segment)) return null;
  try {
    const sites = validateNetwork(segment.split(',').map((host) => 'https://' + host));
    return sitesSegment(sites) === segment ? sites : null;
  } catch {
    return null;
  }
}
/** The Worker's CSP: the runtime's policy with `connect-src` limited to the sites (or none). */
export function workerCsp(sites = []) {
  return `default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src ${sites.length ? sites.join(' ') : "'none'"}; worker-src 'none'; object-src 'none'; base-uri 'none'`;
}
