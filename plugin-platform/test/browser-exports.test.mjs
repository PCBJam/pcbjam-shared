import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {unzipSync} from 'fflate';

// Plugin exports in the browser (plugins 0029): the store that stands in for the server's export rows.
const compiled=await build({entryPoints:[new URL('../src/browser-exports.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const code=Buffer.from(compiled.outputFiles[0].contents);
const {browserExportStore,BROWSER_EXPORT_LIMITS}=await import('data:text/javascript;base64,'+code.toString('base64'));

const text=value=>new TextEncoder().encode(value);
const gerbers=()=>({kind:'gerbers',files:[{name:'board-F_Cu.gbr',bytes:text('G04 front*')},{name:'board-job.gbrjob',bytes:text('{}')}]});
const components=()=>({kind:'fab-components',files:[{name:'fab-components.json',bytes:text(JSON.stringify({footprints:[{ref:'R1'}]}))}]});
const HOUR=60*60*1000;

test('exports get ids, names and sizes; JSON is read by name; bytes stay in the store',()=>{
  const store=browserExportStore();
  const [g,c]=store.add([gerbers(),components()]);
  assert.match(g.exportId,/^[0-9a-f-]{36}$/);
  assert.deepEqual(g.files,[{name:'board-F_Cu.gbr',size:10},{name:'board-job.gbrjob',size:2}]);
  assert.equal(c.kind,'fab-components');
  assert.ok(store.isExport(g.exportId)&&!store.isExport(crypto.randomUUID())&&!store.isBundle(g.exportId));
  assert.deepEqual(store.readJson(c.exportId,'fab-components.json'),{footprints:[{ref:'R1'}]});
  assert.throws(()=>store.readJson(g.exportId,'board-F_Cu.gbr'),/No such JSON file/);
  assert.throws(()=>store.readJson(c.exportId,'missing.json'),/No such JSON file/);
});

test('a bundle follows the server\'s rules: renames, plugin files, unique names',()=>{
  const store=browserExportStore();
  const [g,c]=store.add([gerbers(),components()]);
  const bundle=store.bundle({parts:[{exportId:g.exportId},{exportId:c.exportId,rename:{'fab-components.json':'parts.json'}}],extraFiles:[{name:'PCBWay_bom.csv',text:'R1,1\r\n'}],zipName:'board.zip'});
  assert.deepEqual(bundle.files.map(f=>f.name),['board-F_Cu.gbr','board-job.gbrjob','parts.json','PCBWay_bom.csv']);
  const kept=store.bundleBytes(bundle.bundleId);
  assert.equal(kept.name,'board.zip');
  assert.equal(kept.bytes.length,bundle.size);
  assert.deepEqual(Object.keys(unzipSync(kept.bytes)),['board-F_Cu.gbr','board-job.gbrjob','parts.json','PCBWay_bom.csv']);
  assert.throws(()=>store.bundle({parts:[{exportId:g.exportId},{exportId:g.exportId}],zipName:'x.zip'}),/Two files in the bundle are named board-F_Cu\.gbr/);
  assert.throws(()=>store.bundle({parts:[{exportId:g.exportId,rename:{'missing.gbr':'x.gbr'}}],zipName:'x.zip'}),/Cannot rename missing file/);
  assert.throws(()=>store.bundle({parts:[{exportId:crypto.randomUUID()}],zipName:'x.zip'}),/Export not found or expired/);
  // A file may carry the name of something every object has.
  const [named]=store.add([{kind:'drill',files:[{name:'constructor',bytes:text('M48')}]}]);
  assert.deepEqual(store.bundle({parts:[{exportId:named.exportId}],zipName:'x.zip'}).files,[{name:'constructor',size:3}]);
});

test('the same files give the same ZIP in every timezone, the one the server (UTC) writes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'browser-exports-'));
  try {
    const module=join(dir,'store.mjs');
    writeFileSync(module,code);
    const script=`import {browserExportStore} from ${JSON.stringify(module)};import {createHash} from 'node:crypto';
      const s=browserExportStore();const [g]=s.add([{kind:'gerbers',files:[{name:'a.gbr',bytes:new TextEncoder().encode('G04*')}]}]);
      const b=s.bundle({parts:[{exportId:g.exportId}],zipName:'x.zip'});
      process.stdout.write(createHash('sha256').update(s.bundleBytes(b.bundleId).bytes).digest('hex'));`;
    const digest=zone=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:zone},encoding:'utf8'});
    const utc=digest('UTC');
    assert.match(utc,/^[0-9a-f]{64}$/);
    assert.equal(digest('Europe/Budapest'),utc);
    assert.equal(digest('America/Los_Angeles'),utc);
    assert.equal(digest('Pacific/Kiritimati'),utc);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('exports and bundles live an hour',()=>{
  let now=1_000_000;
  const store=browserExportStore(()=>now);
  const [g]=store.add([gerbers()]);
  const bundle=store.bundle({parts:[{exportId:g.exportId}],zipName:'x.zip'});
  now+=HOUR-1;
  assert.ok(store.isExport(g.exportId)&&store.isBundle(bundle.bundleId));
  now+=1;
  assert.ok(!store.isExport(g.exportId)&&!store.isBundle(bundle.bundleId));
  assert.throws(()=>store.bundleBytes(bundle.bundleId),/Bundle not found or expired/);
  assert.throws(()=>store.bundle({parts:[{exportId:g.exportId}],zipName:'x.zip'}),/Export not found or expired/);
});

test('a run over 32 MiB is refused; past the retained limit the oldest go first',()=>{
  let now=0;
  const store=browserExportStore(()=>now);
  const big=size=>({kind:'gerbers',files:[{name:'a.gbr',bytes:new Uint8Array(size)}]});
  assert.throws(()=>store.add([big(BROWSER_EXPORT_LIMITS.runBytes+1)]),/Export exceeds 32 MiB/);
  const ids=[];
  for(let i=0;i<4;i++){now+=1000;ids.push(store.add([big(BROWSER_EXPORT_LIMITS.runBytes)])[0].exportId);}
  assert.ok(ids.every(id=>store.isExport(id)));
  now+=1000;
  const [fifth]=store.add([big(BROWSER_EXPORT_LIMITS.runBytes)]);
  assert.deepEqual(ids.map(id=>store.isExport(id)),[false,true,true,true]);
  assert.ok(store.isExport(fifth.exportId));
});

test('twelve exports a minute, a batch counting one per kind',()=>{
  let now=0;
  const store=browserExportStore(()=>now);
  store.spend(4);store.spend(4);store.spend(4);
  assert.throws(()=>store.spend(1),error=>error.code==='RATE_LIMITED'&&/Too many plugin requests/.test(error.message));
  now+=59_999;
  assert.throws(()=>store.spend(1),/Too many plugin requests/);
  now+=1;
  store.spend(12);
  // A refused batch counts nothing.
  now+=60_000;
  assert.throws(()=>store.spend(13),/Too many plugin requests/);
  store.spend(12);
});

test('a bundle is stored on the server once per activation, again before it expires there or after a failure',async()=>{
  let now=0;
  const store=browserExportStore(()=>now);
  const [g]=store.add([gerbers()]);
  const {bundleId}=store.bundle({parts:[{exportId:g.exportId}],zipName:'board.zip'});
  const posts=[];
  let release;
  const slow=bundle=>{posts.push(bundle.name);return new Promise(resolve=>{release=()=>resolve('server-'+posts.length);});};
  // Two uploads at once post the bytes once.
  const first=store.serverBundle(bundleId,'activation-a',slow),second=store.serverBundle(bundleId,'activation-a',slow);
  release();
  assert.deepEqual(await Promise.all([first,second]),['server-1','server-1']);
  assert.equal(await store.serverBundle(bundleId,'activation-a',slow),'server-1');
  assert.deepEqual(posts,['board.zip']);
  // Another activation does not own that server row.
  const other=store.serverBundle(bundleId,'activation-b',slow);
  release();
  assert.equal(await other,'server-2');
  // Five minutes before the server's hour is up, it is stored again.
  now+=HOUR-BROWSER_EXPORT_LIMITS.stagingMarginMs-1;
  assert.equal(await store.serverBundle(bundleId,'activation-b',slow),'server-2');
  now+=1;
  // (the bundle itself is still alive in the store for a moment longer)
  const renewed=store.serverBundle(bundleId,'activation-b',slow);
  release();
  assert.equal(await renewed,'server-3');
  // A failed post is not remembered.
  const fresh=browserExportStore();
  const [f]=fresh.add([gerbers()]);
  const made=fresh.bundle({parts:[{exportId:f.exportId}],zipName:'board.zip'});
  await assert.rejects(fresh.serverBundle(made.bundleId,'a',()=>Promise.reject(new Error('offline'))),/offline/);
  assert.equal(await fresh.serverBundle(made.bundleId,'a',async()=>'server-ok'),'server-ok');
  await assert.rejects(fresh.serverBundle(crypto.randomUUID(),'a',async()=>'x'),/Bundle not found or expired/);
});

test('clear forgets every export and bundle, not the minute\'s count',()=>{
  const store=browserExportStore();
  store.spend(12);
  const [g]=store.add([gerbers()]);
  const {bundleId}=store.bundle({parts:[{exportId:g.exportId}],zipName:'x.zip'});
  store.clear();
  assert.ok(!store.isExport(g.exportId)&&!store.isBundle(bundleId));
  assert.throws(()=>store.spend(1),/Too many plugin requests/);
});
