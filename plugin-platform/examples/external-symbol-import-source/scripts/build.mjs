import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

/** Build on the author's machine. PCBJam never executes this script on upload. */
export async function buildPlugin(outputRoot = path.join(root, 'dist')) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(manifest.id) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Use a valid plugin ID and major.minor.patch version in manifest.json.');
  }
  if (manifest.apiVersion !== 1 || manifest.main !== 'main.js' || manifest.ui !== 'ui.html') {
    throw new Error('This starter targets PCBJam API v1 with main.js and ui.html entries.');
  }

  const common = {
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    // React's production bundle fits the UI budget and needs no eval or CDN.
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'inline',
    logLevel: 'warning',
  };
  const [logic, ui] = await Promise.all([
    build({ ...common, entryPoints: ['src/main.ts'], outfile: 'main.js', minify: false }),
    build({ ...common, entryPoints: ['src/ui/main.tsx'], outfile: 'ui.js', jsx: 'automatic', minify: true }),
  ]);
  for (const result of [logic, ui]) {
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some(item => item.external)) throw new Error('Bundle every runtime dependency locally.');
    }
  }
  // Keep the QuickJS bundle independent of React/browser scheduling APIs.
  if (Object.keys(logic.metafile.inputs).some(name => /node_modules\/(react|react-dom|scheduler)\//.test(name))) {
    throw new Error('Import React only from src/ui/, not from plugin logic.');
  }

  const outputText = (result, extension) => result.outputFiles.find(file => file.path.endsWith(extension))?.text ?? '';
  const main = outputText(logic, '.js');
  const script = outputText(ui, '.js').replace(/<\/script/gi, '<\\/script');
  const css = outputText(ui, '.css');
  if (/<\/style/i.test(css)) throw new Error('CSS cannot contain a closing style tag.');
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>External Symbol Import</title><style>${css}</style></head>
<body><div id="root"></div><script>${script}</script></body>
</html>`;
  if (Buffer.byteLength(main) > 1024 * 1024 || Buffer.byteLength(html) > 512 * 1024) {
    throw new Error('Bundle exceeds PCBJam’s 1 MiB logic or 512 KiB UI limit.');
  }
  const reactRequire = createRequire(require.resolve('react-dom/package.json'));
  const licenses = await Promise.all(['react', 'react-dom', 'scheduler'].map(async name =>
    `${name}\n${await readFile(path.join(path.dirname((name === 'scheduler' ? reactRequire : require).resolve(name + '/package.json')), 'LICENSE'), 'utf8')}`));
  const files = {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'main.js': main,
    'ui.html': html,
    'sdk.d.ts': await readFile(path.join(root, 'types/logic.d.ts'), 'utf8') + await readFile(path.join(root, 'types/ui.d.ts'), 'utf8'),
    'LICENSE.txt': licenses.join('\n\n'),
    'README.md': '# External Symbol Import\n\nInstall this folder or its ZIP through PCBJam’s Plugins sidebar. Choose a local .kicad_sym library, select a symbol and approve placement. Click the canvas to place; Esc cancels and Undo removes it.\n\nThis is compiled output. For readable TypeScript and React source, download the source starter from Plugins → Developer guide. Change the manifest version, build, and reinstall to test an update.\n',
  };
  const folder = path.join(outputRoot, 'plugin');
  // Only remove the generated plugin subfolder, so removed files cannot leak into a release.
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(folder, name), text);
  const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) =>
    [name, [strToU8(text), { mtime: new Date('2020-01-01T00:00:00Z') }]])), { level: 9 });
  const zip = path.join(outputRoot, manifest.id + '.zip');
  await writeFile(zip, archive);
  return { folder, zip, files, logicBytes: Buffer.byteLength(main), uiBytes: Buffer.byteLength(html) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildPlugin();
  console.log(`Built ${result.zip}\nInstall that ZIP or the ${result.folder} folder in PCBJam.\nLogic: ${result.logicBytes} bytes; UI: ${result.uiBytes} bytes.`);
}
