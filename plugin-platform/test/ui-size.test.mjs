import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePackage, readZip } from '../package-validation.mjs';
import { zipSync, strToU8 } from 'fflate';

const manifest = { apiVersion: 1, id: 'sizing-test', name: 'Sizing', version: '1.0.0', description: '',
  main: 'main.js', ui: 'ui.html', surfaces: ['editor:eeschema'], permissions: ['ui:custom', 'ui:project-data'] };
const files = patch => [{ path: 'manifest.json', text: JSON.stringify({ ...manifest, ...patch }) },
  { path: 'main.js', text: '1' }, { path: 'ui.html', text: '<p>UI</p>' }];

test('optional UI dimensions survive folder/ZIP validation without expanding permissions', () => {
  const original = validatePackage(files({}));
  assert.equal(original.manifest.uiSize, undefined);
  for (const uiSize of [{ width: 640, height: 480 }, { width: 280, height: 240 }, { width: 4096, height: 4096 }]) {
    const input = files({ uiSize });
    const folder = validatePackage(input);
    const zip = validatePackage(readZip(Buffer.from(zipSync(Object.fromEntries(input.map(file => [file.path, strToU8(file.text)]))))));
    assert.deepEqual(folder.manifest.uiSize, uiSize);
    assert.equal(zip.digest, folder.digest);
    assert.notEqual(folder.digest, original.digest, 'Sizing is part of the immutable release');
    assert.equal(folder.policyDigest, original.policyDigest, 'Sizing adds no capability grant');
  }
});

test('UI dimensions reject malformed, oversized and CSS-bearing input', () => {
  for (const uiSize of [null, [], 640, '640x480', {}, { width: 640 }, { height: 480 },
    { width: '640', height: 480 }, { width: '100vw', height: 480 }, { width: 640.5, height: 480 },
    { width: 279, height: 480 }, { width: 640, height: 239 }, { width: 4097, height: 480 },
    { width: 640, height: 4097 }, { width: -1, height: 480 }, { width: null, height: 480 },
    { width: 640, height: 480, position: 'fixed' }, { width: 640, height: 480, sandbox: 'allow-same-origin' }]) {
    assert.throws(() => validatePackage(files({ uiSize })), /manifest field|uiSize/);
  }
});
