import {exportBackendStarter} from './export-backend-starter.mjs';
import { mkdir, mkdtemp, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import path from 'node:path';
import {tmpdir} from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
import { validatePackage, readZip } from './package-validation.mjs';
import { buildPlugin } from './examples/external-symbol-import-source/scripts/build.mjs';

export async function exportStarter(out) {
await exportBackendStarter(out);
const source = path.join(ROOT, 'examples/external-symbol-import-source');
const scratch=await mkdtemp(path.join(tmpdir(),'pcbjam-plugin-build-'));
let built;
try {built=await buildPlugin(scratch);}catch(error){await rm(scratch,{recursive:true,force:true});throw error;}
const destination = path.join(out, 'external-symbol-import');
await mkdir(destination, { recursive: true });
for (const [name, text] of Object.entries(built.files)) await writeFile(path.join(destination, name), text);
const zip = path.join(out, 'external-symbol-import.zip');
await copyFile(built.zip, zip);
const packaged = validatePackage(readZip(await readFile(zip)));
await rm(scratch,{recursive:true,force:true});

// Fixed source list: dependencies, builds, local settings and secrets never enter the starter archive.
const sourceNames=[
  '.gitignore','README.md','manifest.json','package.json','package-lock.json',
  'tsconfig.json','tsconfig.logic.json','tsconfig.ui.json','scripts/build.mjs','scripts/watch.mjs',
  'types/logic.d.ts','types/ui.d.ts','src/main.ts','src/contracts.ts',
  'src/logic/sexpr.ts','src/logic/library.ts','src/logic/placement.ts',
  'src/ui/main.tsx','src/ui/App.tsx','src/ui/pcbjam.ts','src/ui/styles.css',
];
const sourceFiles = {};
for(const name of sourceNames){
  const bytes=await readFile(path.join(source,name));
  sourceFiles['external-symbol-import-source/'+name]=[bytes,{mtime:new Date('2020-01-01T00:00:00Z')}];
  const target=path.join(out,'external-symbol-import-source',name);
  await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
}
const sourceZip = path.join(out, 'external-symbol-import-source.zip');
await writeFile(sourceZip, zipSync(sourceFiles, { level: 9 }));
await copyFile(path.join(ROOT, 'examples/sample-symbols.kicad_sym'), path.join(out, 'sample-symbols.kicad_sym'));
const guides=[
  ['0008-local-plugin-development.md','DEVELOPER-GUIDE.md'],
  ['0009-plugin-api-and-permissions.md','API.md'],
  ['0010-plugin-security-and-testing.md','ARCHITECTURE.md'],
];
for(const [sourceName,outputName] of guides){
  let markdown=await readFile(path.join(ROOT,'docs',sourceName),'utf8');
  for(const [from,to] of guides) markdown=markdown.replaceAll(from,to);
  markdown=markdown.replaceAll('download/sdk.d.ts','external-symbol-import/sdk.d.ts').replaceAll('download/','');
  await writeFile(path.join(out,outputName),markdown);
}
await writeFile(path.join(out, 'START-HERE.txt'), `PCBJam TypeScript + React plugin example\n\nTo try it: open a schematic in PCBJam, use Plugins → Add plugin… → Install ZIP, select external-symbol-import.zip, and approve the permissions. Choose sample-symbols.kicad_sym through the plugin, then select a symbol and approve placement. Click the canvas to place; Esc cancels and Undo removes it.\n\nTo develop it: open the external-symbol-import-source folder in your editor. With Node.js 22+, run npm ci, then npm run build. Edit src/main.ts, src/ui/App.tsx and src/ui/styles.css. Increase manifest.json's version for changed releases. Install dist/external-symbol-import.zip or dist/plugin from that source folder.\n\nThe source ZIP is for editing, not installation. PCBJam installs the compiled ZIP/folder; it never runs uploaded build scripts. No PCBJam repository is required. See the source README and Plugins → Developer guide.\n\nPackage content SHA-256: ${packaged.digest}\n`);
return { folder: destination, zip, sourceFolder: path.join(out, 'external-symbol-import-source'), sourceZip, sample: path.join(out, 'sample-symbols.kicad_sym'), digest: packaged.digest };
}
