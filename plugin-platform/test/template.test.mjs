import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePackage, readZip, isTemplatePath, templateEntry } from '../package-validation.mjs';
import { zipSync, strToU8 } from 'fflate';

const manifest = { apiVersion: 1, id: 'tutorial-test', name: 'Tutorial', version: '1.0.0', description: '',
  main: 'main.js', ui: 'ui.html', surfaces: ['editor:eeschema'], permissions: ['ui:custom', 'ui:project-data'] };
const base = [{ path: 'manifest.json', text: JSON.stringify(manifest) }, { path: 'main.js', text: '1' }, { path: 'ui.html', text: '<p>UI</p>' }];
const kicad = path => ({ path, text: '(kicad_sch (version 20250114))' });
const TEMPLATE = ['template/usb.kicad_pro', 'template/usb.kicad_sch', 'template/usb.kicad_pcb', 'template/usb.kicad_dru',
  'template/sym-lib-table', 'template/fp-lib-table', 'template/libs/usb_stick.kicad_sym', 'template/libs/usb_stick.pretty/Plug.kicad_mod'];

test('a tutorial package carries its project as KiCad files under template/', () => {
  const input = [...base, ...TEMPLATE.map(kicad)];
  const folder = validatePackage(input);
  assert.deepEqual(folder.files.filter(f => f.path.startsWith('template/')).map(f => f.path).sort(), [...TEMPLATE].sort());
  const zip = validatePackage(readZip(Buffer.from(zipSync(Object.fromEntries(input.map(f => [f.path, strToU8(f.text)]))))));
  assert.equal(zip.digest, folder.digest);
  assert.notEqual(folder.digest, validatePackage(base).digest, 'the template is part of the immutable release');
  assert.equal(folder.policyDigest, validatePackage(base).policyDigest, 'the template grants nothing');
});

test('template/ takes KiCad project files only, within its limits, with a schematic or board on top', () => {
  for (const path of ['template/run.js', 'template/ui.html', 'template/notes.md', 'template/x.kicad_sch.js', 'templates/a.kicad_sch', 'template/fp-lib-table.bak']) {
    assert.throws(() => validatePackage([...base, kicad('template/a.kicad_sch'), kicad(path)]), /Unsupported package file/, path);
  }
  assert.throws(() => validatePackage([...base, kicad('template/libs/a.kicad_sym')]), /schematic or board at its top level/);
  const many = Array.from({ length: 25 }, (_, i) => kicad(`template/libs/s${i}.kicad_sym`));
  assert.throws(() => validatePackage([...base, kicad('template/a.kicad_sch'), ...many.slice(0, 24)]), /at most 24/);
  // A remote provider holds no files besides its manifest and docs.
  const provider = { apiVersion: 1, kind: 'remote-provider', id: 'prov-test', name: 'P', version: '1.0.0', description: '',
    surfaces: ['editor:eeschema'], permissions: ['provider:embed'], provider: { origin: 'https://parts.example.com' } };
  assert.throws(() => validatePackage([{ path: 'manifest.json', text: JSON.stringify(provider) }, kicad('template/a.kicad_sch')]), /hold no code/);
});

test('the entry file: the schematic named like the project, else the first schematic, else a board', () => {
  assert.equal(templateEntry(['b.kicad_sch', 'usb.kicad_pro', 'usb.kicad_sch', 'usb.kicad_pcb']), 'usb.kicad_sch');
  assert.equal(templateEntry(['b.kicad_sch', 'a.kicad_sch']), 'a.kicad_sch');
  assert.equal(templateEntry(['board.kicad_pcb', 'libs/x.kicad_sym']), 'board.kicad_pcb');
  assert.equal(templateEntry(['libs/x.kicad_sch']), null);
  assert.equal(isTemplatePath('template/sym-lib-table'), true);
  assert.equal(isTemplatePath('template/../main.js'), false);
});
