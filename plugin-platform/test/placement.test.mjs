import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';

const compiled=await build({entryPoints:[new URL('../src/placement-semantics.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {validatePlacementSemantics:validate}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));

test('the downloadable importer produces valid base and inherited symbol proposals',async()=>{
  const code=await build({stdin:{contents:`export {readLibrary} from './examples/external-symbol-import-source/src/logic/library'; export {buildPlacement} from './examples/external-symbol-import-source/src/logic/placement';`,resolveDir:new URL('../',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'node'});
  const {readLibrary,buildPlacement}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].contents).toString('base64'));
  const library=readLibrary(await readFile(new URL('../examples/sample-symbols.kicad_sym',import.meta.url),'utf8'),'sample-symbols.kicad_sym');
  for(const name of library.names)validate(buildPlacement(library,name,'11111111-1111-4111-8111-111111111111').sexpr,'eeschema');
});
const symbol=`(lib_symbols (symbol "test:Part" (pin_numbers hide) (pin_names (offset 0) hide)
  (property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
  (symbol "Part_0_1" (rectangle (start -1 -2) (end 1 2) (stroke (width 0.25) (type default)) (fill (type none))))
  (symbol "Part_1_1" (pin passive line (at 0 3 270) (length 1) (name "~" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))
(symbol (lib_id "test:Part") (at 0 0 0) (unit 1) (uuid "11111111-1111-4111-8111-111111111111") (property "Reference" "R?" (at 2 2 0) (effects (font (size 1 1)))))`;

test('accepts self-contained symbols, current and legacy visibility syntax',()=>{
  validate(symbol,'eeschema');
  validate(symbol.replace('(pin_numbers hide)','(pin_numbers (hide yes))').replace('(offset 0) hide','(offset 0) (hide yes)'),'eeschema');
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
test('bounds input size, nesting and forms before parsing',()=>{
  for(const input of ['('.repeat(49)+')'.repeat(49),'()'.repeat(12001),'x'.repeat(512*1024+1),symbol+'\0'])assert.throws(()=>validate(input,'eeschema'));
});
test('deterministic malformed-input corpus terminates without accepting partial data',()=>{
  for(let i=0;i<symbol.length;i+=7)assert.throws(()=>validate(symbol.slice(0,i),'eeschema'));
  for(const tail of ['(sheet)','(symbol)','(image)','(wire)','garbage'])assert.throws(()=>validate(symbol+tail,'eeschema'));
});
