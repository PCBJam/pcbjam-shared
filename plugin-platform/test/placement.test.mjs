import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';

const compiled=await build({entryPoints:[new URL('../src/placement-semantics.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {validatePlacementSemantics:validate,sanitizeSymbolPlacement:sanitize}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));

test('the downloadable importer produces valid base and inherited symbol proposals',async()=>{
  const code=await build({stdin:{contents:`export {readLibrary} from './examples/external-symbol-import-source/src/logic/library'; export {buildPlacement} from './examples/external-symbol-import-source/src/logic/placement';`,resolveDir:new URL('../',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'node'});
  const {readLibrary,buildPlacement}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].contents).toString('base64'));
  const library=readLibrary(await readFile(new URL('../examples/sample-symbols.kicad_sym',import.meta.url),'utf8'),'sample-symbols.kicad_sym');
  for(const name of library.names)validate(buildPlacement(library,name,'11111111-1111-4111-8111-111111111111').sexpr,'eeschema');
});
test('the shared symbol-lib builder produces valid proposals for every sample symbol, with the Footprint rewritten',async()=>{
  const code=await build({entryPoints:[new URL('../../src/symbol-lib.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
  const {resolveSymbolDefinition,withFootprintProperty,buildSymbolClipboard,unquote,isForm}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].contents).toString('base64'));
  const text=await readFile(new URL('../examples/sample-symbols.kicad_sym',import.meta.url),'utf8');
  for(const name of ['PluginResistor','PluginResistor_10k']){
    const def=withFootprintProperty(resolveSymbolDefinition(text,name),'eda_cn:R_0603');
    const {sexpr}=buildSymbolClipboard(def,'eda_cn',name,'11111111-1111-4111-8111-111111111111');
    validate(sexpr,'eeschema');
    assert.equal(unquote(def.find(n=>isForm(n,'property')&&unquote(n[1])==='Footprint')[2]),'eda_cn:R_0603');
  }
  // A Footprint value with a path is what the allowlist refuses; the rewrite is what keeps providers honest.
  assert.throws(()=>validate(buildSymbolClipboard(withFootprintProperty(resolveSymbolDefinition(text,'PluginResistor'),'${KIPRJMOD}/x.pretty:Y'),'eda_cn','PluginResistor','11111111-1111-4111-8111-111111111111').sexpr,'eeschema'),/external footprint reference/);
});
const symbol=`(lib_symbols (symbol "test:Part" (pin_numbers hide) (pin_names (offset 0) hide)
  (property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
  (symbol "Part_0_1" (rectangle (start -1 -2) (end 1 2) (stroke (width 0.25) (type default)) (fill (type none))))
  (symbol "Part_1_1" (pin passive line (at 0 3 270) (length 1) (name "~" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))
(symbol (lib_id "test:Part") (at 0 0 0) (unit 1) (uuid "11111111-1111-4111-8111-111111111111") (property "Reference" "R?" (at 2 2 0) (effects (font (size 1 1)))))`;

test('accepts self-contained symbols, current and legacy visibility syntax',()=>{
  validate(symbol,'eeschema');
  // KiCad ≤ 8 puts a bare `hide` at the end of a property's effects.
  validate(symbol.replace('(property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))','(property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27)) hide))'),'eeschema');
  validate(symbol.replace('(pin_numbers hide)','(pin_numbers (hide yes))').replace('(offset 0) hide','(offset 0) (hide yes)'),'eeschema');
  // KiCad 9/10 symbol flags, as every current library and remote provider emits them.
  validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (duplicate_pin_numbers_are_jumpers no) (embedded_fonts no)'),'eeschema');
  assert.throws(()=>validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (embedded_fonts "x")'),'eeschema'),/Unsupported import/);
  assert.throws(()=>validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (duplicate_pin_numbers_are_jumpers)'),'eeschema'),/Unsupported import/);
  // KiCad 10's `in_pos_files` (the part in position files), on the definition: the AI chat's
  // click placement of a current library's Device:R was refused without it.
  validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (in_pos_files yes)'),'eeschema');
  assert.throws(()=>validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (in_pos_files maybe)'),'eeschema'),/Unsupported import/);
  // The rest of KiCad 10's sheet syntax, as a sheet's lib_symbols carry it once KiCad saved it:
  // flags with yes|no, private library fields, hidden pins, local power symbols.
  const ref='(property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))';
  validate(symbol.replace(ref,'(property "Reference" "R" (at 0 0 90) (show_name no) (do_not_autoplace no) (effects (font (size 1.27 1.27) (italic yes) (bold no))))'),'eeschema');
  validate(symbol.replace(ref,ref+' (property private "KLC_S3.3" "notes" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))'),'eeschema');
  validate(symbol.replace('(length 1) (name','(length 1) (hide yes) (name'),'eeschema');
  validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (power global)'),'eeschema');
  assert.throws(()=>validate(symbol.replace('(pin_numbers hide)','(pin_numbers hide) (power somewhere)'),'eeschema'),/Unsupported import/);
  assert.throws(()=>validate(symbol.replace(ref,'(property "Reference" "R" (at 0 0 90) (show_name maybe) (effects (font (size 1.27 1.27))))'),'eeschema'),/Unsupported import/);
  assert.throws(()=>validate(symbol.replace(ref,ref+' (property private "Reference" "R" (at 0 0 0))'),'eeschema'),/duplicate property/);
});
test('rejects resource-bearing forms, invalid geometry and ambiguous definitions',()=>{
  const invalid=[
    symbol.replace('(pin_numbers hide)','(extends "Other")'),
    symbol.replace('(pin_numbers hide)','(embedded_files (file "x"))'),
    symbol.replace('(pin_numbers hide)','(model "/private/file")'),
    symbol.replace('"Reference" "R"','"Sim.Model" "file:///private/file"'),
    symbol.replace('(at 0 3 270)','(at nan 3 270)'),
    symbol.replace('(at 0 3 270)','(at 0 3 1e999)'),
    symbol.replace('(at 0 3 270)','(at 0 3 13)'),
    symbol.replace('(length 1)','(length -1)'),
    symbol.replace('(unit 1)','(unit 65)'),
    symbol.replace('Part_1_1','Other_1_1'),
    symbol.replace('(lib_id "test:Part")','(lib_id "test:Part") (unit 1)'),
    symbol.replace('(lib_id "test:Part")','(lib_id "test:Different")'),
    symbol.replace('(pin_numbers hide)','(pin_numbers hide hide)'),
    symbol.replace('(start -1 -2)','(start -1 -2) (start 1 2)'),
  ];
  for(const input of invalid)assert.throws(()=>validate(input,'eeschema'));
  assert.throws(()=>validate(symbol,'pcbnew'));
});
test('a placed symbol loses the fields that can name a file, not the whole part',()=>{
  const ref='(property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))';
  const sim=(name,value)=>`(property "${name}" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))`;
  // An LED from a current library: its pin mapping is inert and stays; it places.
  const led=symbol.replace(ref,ref+' '+sim('Sim.Pins','1=K 2=A')+' '+sim('Sim.Device','D'));
  assert.equal(sanitize(led),sanitize(sanitize(led)));
  validate(sanitize(led),'eeschema');
  assert.match(sanitize(led),/Sim\.Pins/);
  // A model from a library file: the library and the model name in it go; the rest places.
  const modelled=symbol.replace(ref,ref+' '+sim('Sim.Library','${KIPRJMOD}/../secret.lib')+' '+sim('Sim.Name','Q2N')+' '+sim('Sim.Type','NPN')
    +' (property private "Spice_Lib_File" "/etc/x" (at 0 0 0))'+' '+sim('Sim.Model','file:///private/file'));
  assert.throws(()=>validate(modelled,'eeschema'),/resource-bearing/);
  const clean=sanitize(modelled);
  validate(clean,'eeschema');
  for(const gone of ['Sim.Library','Sim.Name','Spice_Lib_File','Sim.Model','secret.lib','/etc/x'])assert.ok(!clean.includes(gone),gone);
  assert.match(clean,/Sim\.Type/);
  // A Footprint that is a path: blanked, so the part places with no footprint.
  const pathed=symbol.replace('(lib_id "test:Part") (at 0 0 0)','(lib_id "test:Part") (at 0 0 0) (property "Footprint" "${KIPRJMOD}/x.pretty:Y" (at 0 0 0))');
  assert.throws(()=>validate(pathed,'eeschema'),/external footprint/);
  validate(sanitize(pathed),'eeschema');
  assert.match(sanitize(pathed),/\(property "Footprint" ""/);
});
test('bounds input size, nesting and forms before parsing',()=>{
  for(const input of ['('.repeat(49)+')'.repeat(49),'()'.repeat(12001),'x'.repeat(512*1024+1),symbol+'\0'])assert.throws(()=>validate(input,'eeschema'));
});
test('deterministic malformed-input corpus terminates without accepting partial data',()=>{
  for(let i=0;i<symbol.length;i+=7)assert.throws(()=>validate(symbol.slice(0,i),'eeschema'));
  for(const tail of ['(sheet)','(symbol)','(image)','(wire)','garbage'])assert.throws(()=>validate(symbol+tail,'eeschema'));
});
