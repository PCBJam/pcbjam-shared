import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePackage, readZip, PROVIDER_PERMISSIONS } from '../package-validation.mjs';
import { providerPermissions } from '../remote-provider-contract.mjs';
import { zipSync, strToU8 } from 'fflate';

const ORIGIN = 'https://kicad.acme-parts.example';
const manifest = { apiVersion: 1, kind: 'remote-provider', id: 'acme-parts', name: 'Acme Parts', version: '1.0.0',
  description: 'Search and place Acme parts', surfaces: ['editor:eeschema'], permissions: [...PROVIDER_PERMISSIONS], provider: { origin: ORIGIN } };
const files = (patch, extra = []) => [{ path: 'manifest.json', text: JSON.stringify({ ...manifest, ...patch }) }, ...extra];
const zip = input => readZip(Buffer.from(zipSync(Object.fromEntries(input.map(file => [file.path, strToU8(file.text)])))));

test('a remote-provider package is manifest-only and validates from a folder or a ZIP', () => {
  const folder = validatePackage(files({}, [{ path: 'README.md', text: '# Acme' }, { path: 'LICENSE.txt', text: 'MIT' }]));
  const zipped = validatePackage(zip(files({}, [{ path: 'README.md', text: '# Acme' }, { path: 'LICENSE.txt', text: 'MIT' }])));
  assert.equal(folder.manifest.kind, 'remote-provider');
  assert.equal(folder.manifest.provider.origin, ORIGIN);
  assert.equal(folder.validationVersion, 4);
  assert.equal(zipped.digest, folder.digest);
  assert.equal(zipped.policyDigest, folder.policyDigest);
  assert.deepEqual(Object.keys(folder.fileMetadata), ['LICENSE.txt', 'README.md', 'manifest.json']);
  const wrapped = validatePackage(files({}).map(f => ({ ...f, path: 'acme-parts/' + f.path })));
  assert.equal(wrapped.digest, validatePackage(files({})).digest, 'one wrapping folder is stripped like for plugins');
});

test('the policy digest pins the provider origin and nothing else', () => {
  const base = validatePackage(files({}));
  assert.equal(validatePackage(files({ name: 'Renamed', description: 'x', version: '2.0.0' })).policyDigest, base.policyDigest, 'cosmetic edits keep consent');
  assert.notEqual(validatePackage(files({ name: 'Renamed' })).digest, base.digest, 'but the release digest changes');
  assert.notEqual(validatePackage(files({ provider: { origin: 'https://kicad.other-parts.example' } })).policyDigest, base.policyDigest, 'a new origin is new consent');
  assert.equal(validatePackage(files({ permissions: [...PROVIDER_PERMISSIONS].reverse() })).policyDigest, base.policyDigest, 'permission order is irrelevant');
  const plugin = validatePackage([{ path: 'manifest.json', text: JSON.stringify({ apiVersion: 1, id: 'acme-parts', name: 'Acme', version: '1.0.0', description: '',
    main: 'main.js', ui: 'ui.html', surfaces: ['editor:eeschema'], permissions: ['ui:custom', 'ui:project-data', 'editor:place-items'] }) },
    { path: 'main.js', text: '1' }, { path: 'ui.html', text: '<p>UI</p>' }]);
  assert.notEqual(plugin.policyDigest, base.policyDigest, 'a plugin with overlapping permissions never shares a provider digest');
  assert.deepEqual(providerPermissions(ORIGIN), { 'provider:embed': 'Show ' + ORIGIN + ' inside PCBJam', 'provider:download': 'Download parts you choose from ' + ORIGIN + ' into a team library' });
});

test('plugins keep working with and without an explicit kind', () => {
  const plugin = [{ path: 'manifest.json', text: JSON.stringify({ apiVersion: 1, kind: 'plugin', id: 'plain-plugin', name: 'Plain', version: '1.0.0', description: '',
    main: 'main.js', ui: 'ui.html', surfaces: ['editor:eeschema'], permissions: ['ui:custom', 'ui:project-data'] }) }, { path: 'main.js', text: '1' }, { path: 'ui.html', text: '<p>UI</p>' }];
  assert.equal(validatePackage(plugin).manifest.kind, 'plugin');
  assert.throws(() => validatePackage([{ ...plugin[0], text: plugin[0].text.replace('"plugin"', '"widget"') }, plugin[1], plugin[2]]), /Unsupported package kind/);
});

test('provider packages refuse code, wrong surfaces, wrong permissions and unsafe origins', () => {
  const cases = [
    [files({}, [{ path: 'main.js', text: '1' }]), /hold no code/],
    [files({}, [{ path: 'ui.html', text: '<p>' }]), /hold no code/],
    [files({}, [{ path: 'sdk.d.ts', text: '' }]), /hold no code/],
    [files({ main: 'main.js' }), /Unknown manifest field/],
    [files({ endpoints: { backend: { origin: ORIGIN, paths: ['/x'], methods: ['GET'], auth: 'none' } } }), /Unknown manifest field/],
    [files({ uiSize: { width: 400, height: 400 } }), /Unknown manifest field/],
    [files({ provider: undefined }), /Unknown manifest field/],
    [files({ provider: { origin: ORIGIN, panel: '/p' } }), /Unknown manifest field/],
    [files({ provider: { origin: 'http://kicad.acme-parts.example' } }), /https origin/],
    [files({ provider: { origin: ORIGIN + '/panel' } }), /https origin/],
    [files({ provider: { origin: 'https://localhost' } }), /https origin/],
    [files({ provider: { origin: 'https://kicad.acme-parts.example:8443' } }), /https origin/],
    [files({ provider: { origin: 'https://app.pcbjam.com' } }), null],
    [files({ surfaces: ['editor:pcbnew'] }), /editor:eeschema/],
    [files({ surfaces: ['editor:eeschema', 'editor:pcbnew'] }), /editor:eeschema/],
    [files({ permissions: ['provider:embed', 'provider:download'] }), /exactly provider:embed/],
    [files({ permissions: [...PROVIDER_PERMISSIONS, 'documents:read'] }), /exactly provider:embed/],
    [files({ permissions: [...PROVIDER_PERMISSIONS, 'provider:embed'] }), /exactly provider:embed/],
    [files({ id: 'Acme' }), /plugin ID/],
    [files({ version: '1.0' }), /plugin ID or version/],
    [files({ name: '' }), /name or description/],
  ];
  for (const [input, pattern] of cases) {
    if (pattern) assert.throws(() => validatePackage(input), pattern, input[0].text);
    else validatePackage(input); // pcbjam.com origins are refused later, at approval time, like backends
  }
});
