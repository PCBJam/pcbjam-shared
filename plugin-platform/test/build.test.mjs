import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPluginRuntime } from '../build.mjs';
import { validatePackage } from '../package-validation.mjs';
import { renderPluginUI } from '../render-ui.mjs';

test('runtime builds are deterministic and every emitted asset matches its manifest',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'pcbjam-runtime-'));
  try {
    const a=await buildPluginRuntime(path.join(directory,'one'));
    const b=await buildPluginRuntime(path.join(directory,'two'));
    assert.equal(a.version,b.version);
    for(const [name,meta] of Object.entries(a.manifest.files)){
      const bytes=await readFile(path.join(a.directory,name));assert.equal(bytes.length,meta.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.sha256);
      assert.deepEqual(bytes,await readFile(path.join(b.directory,name)));
    }
    const host=await readFile(path.join(a.directory,'package-host.js'),'utf8');
    assert(!host.includes('/Users/'));assert(!host.includes('tools/plugin-runtime-poc'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('package digest ordering is byte-deterministic and independent of picker/ZIP order',()=>{
  const files=[{path:'manifest.json',text:JSON.stringify({apiVersion:1,id:'test-plugin',name:'Test',version:'1.0.0',description:'',main:'main.js',ui:'ui.html',surfaces:['editor:eeschema'],permissions:['ui:custom','ui:project-data']})},
    {path:'main.js',text:'1'},{path:'ui.html',text:'<p>UI</p>'},{path:'README.md',text:'Read me'}];
  const a=validatePackage(files),b=validatePackage([...files].reverse());
  assert.equal(a.digest,b.digest);assert.deepEqual(a.files.map(f=>f.path),['README.md','main.js','manifest.json','ui.html']);
  assert.equal(a.fileMetadata['main.js'].bytes,1);assert.equal(a.validationVersion,2);
});
test('rendered HTML integrity and CSP include the injected SDK and inline styles',()=>{
  const ui=renderPluginUI('<style>p{color:red}</style><script>window.x=1</script>', 'parent.postMessage(1,"__PLUGIN_PARENT_ORIGIN__")','https://editor.example',['https://editor.example']);
  assert.equal(ui.digest,createHash('sha256').update(ui.body).digest('hex'));
  assert(ui.headers['Content-Security-Policy'].includes("sandbox allow-scripts;"));
  assert(!ui.headers['Content-Security-Policy'].includes('allow-same-origin'));
  const directive=name=>ui.headers['Content-Security-Policy'].split('; ').find(part=>part.startsWith(name+' '));
  assert.equal(directive('img-src'),'img-src data: blob:');
  assert.equal(directive('connect-src'),"connect-src 'none'");
  for(const name of ['font-src','media-src','style-src-attr'])assert.equal(directive(name),undefined);
  for(const match of ui.body.matchAll(/<(script|style)>([\s\S]*?)<\/(?:script|style)>/g))assert(ui.headers['Content-Security-Policy'].includes(createHash('sha256').update(match[2]).digest('base64')));
  assert.throws(()=>renderPluginUI('','', 'https://evil.example', ['https://editor.example']));
});
