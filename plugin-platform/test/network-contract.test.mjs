import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { directOrigin, validateNetwork, directPermissions, sitesSegment, sitesFromSegment, workerCsp, NET_LIMITS } from '../network-contract.mjs';
import { validatePackage, PROVIDER_PERMISSIONS } from '../package-validation.mjs';

const manifest = { apiVersion: 1, id: 'net-test', name: 'Net', version: '1.0.0', description: '', main: 'main.js', ui: 'ui.html',
  surfaces: ['editor:pcbnew'], permissions: ['ui:custom', 'ui:project-data', 'documents:read'] };
const pkg = (patch) => validatePackage([
  { path: 'manifest.json', text: JSON.stringify({ ...manifest, ...patch }) },
  { path: 'main.js', text: 'pcbjam.handle("x",()=>1)' },
  { path: 'ui.html', text: '<p>UI</p>' },
]);
const withSites = (network, extra = []) => pkg({ network, permissions: [...manifest.permissions, ...Object.keys(directPermissions(validateNetwork(network))), ...extra] });

test('a site is an https origin with a public hostname that is not ours', () => {
  for (const ok of ['https://api.example.com', 'https://parts.octo-part.example', 'https://a.b.c.example.org'])
    assert.equal(directOrigin(ok), ok);
  for (const bad of [
    'http://api.example.com', 'https://api.example.com/', 'https://api.example.com/v1', 'https://api.example.com:8443',
    'https://API.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://printer.local',
    'https://router.home.arpa', 'https://nas.lan', 'https://box.home', 'https://intranet.corp', 'https://pc.localdomain',
    'https://pcbjam.com', 'https://api.pcbjam.com', 'https://pcbjam-server-staging.pcbjam-staging.workers.dev',
    'https://x.pages.dev', 'https://bucket.r2.dev', 'https://acct.r2.cloudflarestorage.com', 'https://xn--e1afmkfd.example',
    'https://user@api.example.com', 'api.example.com', '', null, 42,
  ]) assert.throws(() => directOrigin(bad), /network: each site/, String(bad));
});

test('network is 1-8 distinct sites, returned in code-unit order', () => {
  assert.equal(validateNetwork(undefined), undefined);
  assert.deepEqual(validateNetwork(['https://b.example.com', 'https://a.example.com']), ['https://a.example.com', 'https://b.example.com']);
  for (const bad of [[], 'https://a.example.com', [1], ['https://a.example.com', 'https://a.example.com'],
    Array.from({ length: NET_LIMITS.sites + 1 }, (_, i) => `https://s${i}.example.com`)])
    assert.throws(() => validateNetwork(bad), /network: each site/);
});

test('the Worker URL segment round-trips and accepts only the canonical form', () => {
  const sites = ['https://files.example.org', 'https://api.example.com'];
  const segment = sitesSegment(sites);
  assert.equal(segment, 'api.example.com,files.example.org');
  assert.deepEqual(sitesFromSegment(segment), ['https://api.example.com', 'https://files.example.org']);
  for (const bad of ['files.example.org,api.example.com', 'api.example.com,api.example.com', 'API.example.com', '', ',',
    'api.example.com,', 'api.pcbjam.com', 'localhost', 'api.example.com/x', 'api.example.com:443', 'a b.example.com', 'x'.repeat(2200), null])
    assert.equal(sitesFromSegment(bad), null, String(bad).slice(0, 40));
});

test('the Worker CSP allows exactly the sites, or nothing', () => {
  assert.match(workerCsp(), /connect-src 'none';/);
  const csp = workerCsp(['https://api.example.com', 'https://files.example.org']);
  assert.match(csp, /connect-src https:\/\/api\.example\.com https:\/\/files\.example\.org;/);
  assert.match(csp, /default-src 'none'; script-src 'wasm-unsafe-eval';/);
  assert.match(csp, /worker-src 'none'; object-src 'none'; base-uri 'none'$/);
  assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'/);
});

test('a package declares sites with one consent per site; old packages keep their digest', () => {
  const plain = pkg({});
  assert.equal(plain.validationVersion, 2);
  assert.equal(plain.policyDigest, createHash('sha256').update(JSON.stringify({ apiVersion: 1, permissions: [...manifest.permissions].sort() })).digest('hex'),
    'packages without network hash exactly as before');
  const net = withSites(['https://api.example.com']);
  assert.equal(net.validationVersion, 5);
  assert.notEqual(net.policyDigest, plain.policyDigest);
  assert.deepEqual(directPermissions(['https://api.example.com']), { 'direct:api.example.com': 'Send data from your browser to api.example.com' });
  assert.equal(withSites(['https://b.example.com', 'https://a.example.com']).policyDigest, withSites(['https://a.example.com', 'https://b.example.com']).policyDigest,
    'site order is not new consent');
  assert.notEqual(withSites(['https://a.example.com', 'https://b.example.com']).policyDigest, withSites(['https://a.example.com']).policyDigest,
    'a new site is new consent');
  assert.throws(() => pkg({ network: ['https://api.example.com'] }), /requires its direct:<hostname> permission/);
  assert.throws(() => pkg({ permissions: [...manifest.permissions, 'direct:api.example.com'] }), /Unsupported permissions/, 'no consent without a site');
  assert.throws(() => pkg({ network: ['https://api.pcbjam.com'], permissions: [...manifest.permissions, 'direct:api.pcbjam.com'] }), /network: each site/);
});

test('remote providers cannot declare sites', () => {
  assert.throws(() => validatePackage([{ path: 'manifest.json', text: JSON.stringify({ apiVersion: 1, kind: 'remote-provider', id: 'acme-parts', name: 'Acme',
    version: '1.0.0', description: '', surfaces: ['editor:eeschema'], permissions: [...PROVIDER_PERMISSIONS], provider: { origin: 'https://kicad.acme.example' },
    network: ['https://api.example.com'] }) }]));
});
