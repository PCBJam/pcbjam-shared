import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';

const load=async(entry)=>{const c=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});return import('data:text/javascript;base64,'+Buffer.from(c.outputFiles[0].contents).toString('base64'));};
const {sanitizeFootprint,validateFootprintSemantics,checkFootprintStructure}=await load('../src/footprint-semantics.ts');
const {parseSexpr,printSexpr}=await load('../../src/sexpr.ts');
const fixture=await readFile(new URL('../examples/sample-footprint.kicad_mod',import.meta.url),'utf8');
const accept=(text,name='X')=>{const out=sanitizeFootprint(text,name);validateFootprintSemantics(out);return out;};
const reject=(text,pattern,name='X')=>assert.throws(()=>accept(text,name),pattern);
/** The e2e smoke fixture: one SMD pad, two properties. */
const minimal=(extra='',pad='(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))')=>`(footprint "R_0603" (version 20241229) (generator "pcbjam-e2e") (generator_version "0.1")
  (layer "F.Cu") (attr smd)
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R_0603" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  ${pad} ${extra})`;

test('accepts the smoke fixture and a real footprint carrying a model and embedded files',()=>{
  accept(minimal());
  const out=accept(fixture,'BGA96');
  const root=parseSexpr(out)[0];
  assert.equal(root[1],'"BGA96"','renamed to the requested name');
  const heads=root.slice(2).map(n=>n[0]);
  assert.ok(heads.includes('pad')&&heads.includes('fp_line')&&heads.includes('property'));
  assert.ok(!out.includes('embedded_files')&&!out.includes('(model')&&!out.includes('kicad-embed'),'model and embedded files are gone');
  assert.ok(accept(minimal('(embedded_fonts yes)')).includes('(embedded_fonts no)'),'embedded fonts are forced off');
  assert.equal(parseSexpr(out).length,1);
});

test('strips embedded_files and model at any depth and stores compact text',()=>{
  const out=accept(minimal('(model "/abs/path.step" (offset (xyz 0 0 0))) (embedded_files (file (name "x") (type other) (data |AAAA|)))'));
  assert.ok(!/model|embedded_files/.test(out));
  assert.equal(out,printSexpr(parseSexpr(out)[0]),'sanitized text is the printer\'s canonical form');
  // A model hidden inside a pad's primitives is also removed.
  const nested=accept(minimal('',`(pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu") (primitives (gr_line (start 0 0) (end 1 1) (width 0.1)) (model "x.step")))`));
  assert.ok(!nested.includes('model'));
});

test('rejection corpus',()=>{
  reject(minimal('','(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND"))'),/net is not supported in pad/);
  reject(minimal('(net_tx_pins "1")'),/net_tx_pins is not supported/);
  reject(minimal('(fp_line (start 5000 0) (end 0 0) (layer "F.SilkS") (stroke (width 0.1) (type solid)))'),/out of range/);
  reject(minimal('','(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (solder_paste_margin -1518.48))'),/out of range/);
  reject(minimal('(property "Sim.Device" "C" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1))))'),/resource-bearing/);
  reject(minimal('(property "Model" "x" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1))))'),/resource-bearing/);
  reject(minimal('(property "Reference" "twice" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1))))'),/duplicate property/);
  reject(minimal('(fp_text user "hi" (at 0 0) (layer "F.Fab") (effects (font (face "/usr/share/fonts/x.ttf") (size 1 1))))'),/font face path/);
  reject(minimal('(fp_line (start 0 0) (end 1 1) (layer "F.SilkS") (stroke (width 0.1) (type solid)))'),/layer name|control/);
  reject(minimal('(descr "badchar")'),/control characters/);
  reject(minimal().replace('(attr smd)','(attr rocket)'),/invalid attr/);
  reject(minimal('(attr smd)'),/duplicate attr/);
  reject(minimal('','(pad "1" smd blob (at 0 0) (size 1 1) (layers "F.Cu"))'),/invalid pad shape/);
  reject(minimal('','(pad "1" smd rect (size 1 1) (layers "F.Cu"))'),/pad needs at and size/);
  reject(minimal('(zone (layer "F.Cu") (net 1) (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))'),/net is not supported in zone/);
  reject('(kicad_pcb (version 1))',/expected one footprint/);
  reject(minimal()+' (footprint "second")',/expected one footprint/);
  reject(minimal(),/invalid footprint name/,'has/slash');
  reject(minimal(),/invalid footprint name/,'has:colon');
  reject(minimal(),/invalid footprint name/,'');
});

test('counts and sizes are bounded',()=>{
  const pads=Array.from({length:4097},(_,i)=>`(pad "${i}" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`).join(' ');
  reject(minimal('',pads),/too many pads/);
  const pts=Array.from({length:2049},(_,i)=>`(xy ${i%100} 0)`).join(' ');
  reject(minimal(`(fp_poly (pts ${pts}) (layer "F.SilkS") (stroke (width 0.1) (type solid)))`),/invalid point count/);
  // Under the raw cap but over the stored cap once nothing can be stripped.
  const big=minimal(`(descr "${'d'.repeat(4000)}") `+Array.from({length:200},(_,i)=>`(fp_text user "${'t'.repeat(3000)}" (at ${i} 0) (layer "F.Fab") (effects (font (size 1 1))))`).join(' '));
  reject(big,/too large after removing embedded files/);
  assert.throws(()=>checkFootprintStructure('x'.repeat(8*1024*1024+1)),/too large/);
  assert.throws(()=>checkFootprintStructure('('.repeat(49)),/limits|unbalanced/);
  assert.throws(()=>checkFootprintStructure('(footprint "x"'),/unbalanced/);
  assert.throws(()=>checkFootprintStructure('(footprint "x" (descr "open))'),/unbalanced/);
});

test('real-world syntax variants are accepted',()=>{
  accept(minimal('(property ki_fp_filters "C_*")'));                                             // bare-atom property name
  accept(minimal('(fp_text reference "REF**" (at 0 -3.35) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))) (tstamp b8c057d5-dc17-453d-912f-05b30d7e612e))'));   // bare tstamp
  accept('(footprint "MH" (version 20221018) (generator pcbnew) (layer "F.Cu") (attr exclude_from_pos_files exclude_from_bom) (pad "" np_thru_hole circle (at 0 0) (size 2.7 2.7) (drill 2.7) (layers "F&B.Cu" "*.Mask")))');
  accept(minimal('','(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (tenting (front none) (back none)) (uuid "9aeb1959-d76f-41ba-b5d7-db1e58206843"))'));
  accept(minimal('','(pad "1" thru_hole oval (at 0 0 90) (size 2 1.2) (drill oval 1 0.6 (offset 0.1 0)) (layers "*.Cu" "*.Mask") (tenting front back) (remove_unused_layers no))'));
  accept(minimal('(descr "line one\nline two")'));                                              // KiCad writes literal newlines in descr
  accept(minimal('(dimension (type orthogonal) (layer "Dwgs.User") (pts (xy 1 1) (xy 2 2)) (height 1) (orientation 1) (format (prefix "") (units 3) (suppress_zeroes yes)) (style (thickness 0.1) (arrow_length 1.27) (arrow_direction outward) (keep_text_aligned yes)) (gr_text "30" (at 1 1 90) (layer "Dwgs.User") (effects (font (size 1 1)))))'));
  accept(minimal('(fp_arc (start 0 0) (mid 1 1) (end 2 0) (layer "F.SilkS") (stroke (width 0.1) (type solid))) (fp_circle (center 0 0) (end 1 0) (layer "F.CrtYd") (stroke (width 0.05) (type default)) (fill no))'));
});

test('the validation worker answers both message shapes',async()=>{
  const c=await build({entryPoints:[new URL('../src/placement-validation-worker.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',platform:'browser'});
  const replies=[];
  const self={postMessage:m=>replies.push(m),onmessage:null};
  new Function('self',c.outputFiles[0].text)(self);
  const symbol=`(lib_symbols (symbol "t:P" (pin_numbers hide) (pin_names (offset 0) hide) (property "Reference" "R" (at 0 0 90) (effects (font (size 1 1)))) (symbol "P_0_1" (rectangle (start -1 -2) (end 1 2) (stroke (width 0.25) (type default)) (fill (type none)))) (symbol "P_1_1" (pin passive line (at 0 3 270) (length 1) (name "~" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))
(symbol (lib_id "t:P") (at 0 0 0) (unit 1) (uuid "11111111-1111-4111-8111-111111111111") (property "Reference" "R?" (at 2 2 0) (effects (font (size 1 1)))))`;
  self.onmessage({data:{text:symbol,tool:'eeschema'}});
  assert.deepEqual(replies.pop(),{ok:true});
  self.onmessage({data:{text:symbol,tool:'eeschema',kind:'symbol'}});
  assert.deepEqual(replies.pop(),{ok:true});
  self.onmessage({data:{text:fixture,tool:'pcbnew',kind:'footprint',name:'BGA96'}});
  const fp=replies.pop();
  assert.equal(fp.ok,true);assert.ok(fp.text.startsWith('(footprint "BGA96"')&&!fp.text.includes('embedded_files'));
  self.onmessage({data:{text:fixture,tool:'pcbnew',kind:'footprint'}});
  assert.equal(replies.pop().ok,false,'footprint validation needs a name');
  self.onmessage({data:{text:minimal('','(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND"))'),tool:'pcbnew',kind:'footprint',name:'X'}});
  assert.match(replies.pop().error,/net is not supported/);
  self.onmessage({data:{text:symbol,tool:'eeschema',kind:'other'}});
  assert.equal(replies.pop().ok,false);
  self.onmessage({data:{text:fixture,tool:'pcbnew'}});
  assert.equal(replies.pop().ok,false,'a footprint through the symbol path is still refused');
});
