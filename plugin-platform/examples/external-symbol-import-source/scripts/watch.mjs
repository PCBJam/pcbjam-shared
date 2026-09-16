// Runs only on the author's machine. Never uploads or executes a plugin in PCBJam.
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let running = false, pending = false, stopped = false, timer, compiler;
async function typecheck(config) {
  await new Promise((resolve, reject) => {
    compiler = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
      cwd: root, stdio: 'inherit',
    });
    compiler.once('error', reject);
    compiler.once('exit', code => code === 0 ? resolve() : reject(new Error('Fix the TypeScript errors, then save again.')));
  });
  compiler = undefined;
}
async function rebuild() {
  pending = true;
  if (running || stopped) return;
  running = true;
  try {
    while (pending && !stopped) {
      pending = false;
      try {
        await typecheck('tsconfig.logic.json');
        await typecheck('tsconfig.ui.json');
        if (stopped) break;
        const result = await buildPlugin();
        console.log(`Built ${result.zip}\nTo try these changes: increase manifest.version if already installed, then upload and approve the new version in Plugins → Add plugin…`);
      } catch (error) {
        console.error(error.message);
      }
    }
  } finally { running = false; }
}
const watcher = watch(root, { recursive: true }, (_event, file) => {
  const name = String(file ?? '').replaceAll('\\', '/');
  if (!/^(src\/|types\/|manifest\.json$|tsconfig[^/]*\.json$)/.test(name)) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void rebuild(); }, 150);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopped = true;
  clearTimeout(timer);
  watcher.close();
  compiler?.kill();
});
console.log('Watching source, types and manifest. Restart this command after changing build scripts or dependencies.');
void rebuild();
