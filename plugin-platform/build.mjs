import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const quickRequire = createRequire(require.resolve('quickjs-emscripten'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const WORKER_CSP = "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";

/** No private-repository inputs, timestamps, machine paths or mutable URLs. */
export async function buildPluginRuntime(outputDirectory) {
  const files = new Map();
  for (const name of ['package-host', 'package-worker', 'package-prelude', 'package-ui-sdk', 'placement-validation-worker', 'editor-host', 'worker', 'guest']) {
    const result = await build({
      absWorkingDir: root, entryPoints: [`src/${name}.ts`], bundle: true,
      platform: 'browser', target: 'es2022', conditions: ['browser'],
      format: name.endsWith('host') ? 'esm' : 'iife', write: false,
      minify: true, legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    files.set(`${name}.js`, result.outputFiles[0].contents);
  }
  files.set('quickjs.wasm', await readFile(quickRequire.resolve('@jitl/quickjs-wasmfile-release-sync/wasm')));
  const manifest = {
    protocolVersion: 1, apiVersion: 1, quickjsVersion: '0.32.0',
    files: Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length }])),
  };
  const encoded = JSON.stringify(manifest);
  const version = sha256(encoded);
  const directory = path.join(outputDirectory, version);
  await mkdir(directory, { recursive: true });
  await Promise.all([...files].map(([name, bytes]) => writeFile(path.join(directory, name), bytes)));
  await writeFile(path.join(directory, 'manifest.json'), encoded + '\n');
  return { version, manifest, directory, base: `/plugin-runtime/${version}/` };
}

export const runtimeHeaders = `/plugin-runtime/*\n  Content-Security-Policy: ${WORKER_CSP}\n  X-Content-Type-Options: nosniff\n  Cross-Origin-Resource-Policy: same-origin\n  Cache-Control: public, max-age=31536000, immutable\n`;
