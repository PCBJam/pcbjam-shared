import { parseSexpr, printSexpr, type SNode } from '../../src/sexpr';
/**
 * The footprint twin of placement-semantics.ts: an allowlist for a `(footprint …)`
 * that arrives from outside the editor (a remote provider, a plugin) before it is
 * written into a team library. Runs only inside the validation Worker.
 *
 * Two things are removed rather than refused, because providers routinely ship
 * them and neither is wanted in a team library: `embedded_files` (a footprint
 * with an embedded STEP + PDF measured 6 MiB in the demo libraries) and `model`
 * (3D delivery is a separate feature; a stray path must not reach the resolver).
 * Everything else must be on the list. Pads may not carry nets: a library
 * footprint has none, and a netted pad would connect on placement.
 */
type Form = SNode[];
function fail(message:string):never {throw new Error('Unsupported footprint: '+message);}
const atom=(node:SNode|undefined):string=>typeof node==='string'?node:fail('expected an atom');
const form=(node:SNode):Form=>Array.isArray(node)&&typeof node[0]==='string'?node:fail('expected a named form');
const tag=(node:Form)=>atom(node[0]);
function quoted(node:SNode|undefined,max=4096) {
  const value=atom(node);
  if(!value.startsWith('"')||!value.endsWith('"')||value.length>max+2)fail('invalid string');
  const result=value.slice(1,-1).replace(/\\(["\\])/g,'$1');
  // KiCad itself writes newlines and tabs inside descr/tags strings.
  if(/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(result))fail('control characters');
  return result;
}
function number(node:SNode|undefined,min=-1000,max=1000,integer=false) {
  const text=atom(node);
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))fail('invalid number');
  const value=Number(text);
  if(!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))fail('number out of range');
  return value;
}
function exact(node:Form,count:number){if(node.length!==count+1)fail('invalid '+tag(node)+' arguments');}
function enumeration(node:Form,values:string[]){exact(node,1);if(!values.includes(atom(node[1])))fail('invalid '+tag(node));}
function yesNo(node:Form){if(node.length===1)return;enumeration(node,['yes','no']);}
function coordinate(node:Form,dimensions:number,min=-1000,max=1000){exact(node,dimensions);node.slice(1).forEach(v=>number(v,min,max));}
/** `(at x y [angle])` — footprints allow any angle, unlike schematic symbols. */
function position(node:Form){if(node.length<3||node.length>4)fail('invalid at');number(node[1]);number(node[2]);if(node.length===4)number(node[3],-360,360);}
function fields(node:Form,start:number,allowed:string[],repeat:string[]=[]) {
  const seen=new Set<string>();
  return node.slice(start).map(value=>{
    const child=form(value),name=tag(child);
    if(!allowed.includes(name))fail(name+' is not supported in '+tag(node));
    if(seen.has(name)&&!repeat.includes(name))fail('duplicate '+name);
    seen.add(name);return child;
  });
}
const LAYER=/^[A-Za-z0-9_.*&-]+$/;
function layerName(node:SNode|undefined){const name=quoted(node,64);if(!LAYER.test(name))fail('invalid layer name');return name;}
function layers(node:Form){if(node.length<2||node.length>65)fail('invalid layers');node.slice(1).forEach(layerName);}
/** Quoted in current files; older `tstamp`/`generator` atoms are bare. Either way: short, no path characters. */
function token(node:SNode|undefined,max=64){const raw=atom(node);const value=raw.startsWith('"')?quoted(node,max):raw;if(value.length>max||/[\s/\\]/.test(value))fail('invalid token');return value;}
function uuid(node:Form){exact(node,1);token(node[1],64);}
function effects(node:Form) {
  for(const child of fields(node,1,['font','justify','hide'])){
    if(tag(child)==='font')for(const value of fields(child,1,['face','size','thickness','bold','italic','line_spacing','color'])){
      const kind=tag(value);
      if(kind==='size')coordinate(value,2,0.001,100);
      else if(kind==='thickness'||kind==='line_spacing')coordinate(value,1,0,10);
      else if(kind==='face'){exact(value,1);if(quoted(value[1],256).includes('/'))fail('font face path');}
      else if(kind==='color')coordinate(value,4,0,255);
      else yesNo(value);
    }
    else if(tag(child)==='hide')yesNo(child);
    else {if(child.length>4)fail('invalid text justification');for(const v of child.slice(1))if(!['left','right','top','bottom','mirror'].includes(atom(v)))fail('invalid text justification');}
  }
}
const TEXT_CHILDREN=['at','layer','uuid','tstamp','hide','unlocked','effects','locked'];
function textChildren(node:Form,start:number) {
  for(const child of fields(node,start,TEXT_CHILDREN)){
    const kind=tag(child);
    if(kind==='at')position(child);
    else if(kind==='layer'){exact(child,1);layerName(child[1]);}
    else if(kind==='uuid'||kind==='tstamp')uuid(child);
    else if(kind==='effects')effects(child);
    else yesNo(child);
  }
}
/** Property names are usually quoted; KiCad's own fields (`ki_fp_filters`) are bare atoms. */
function propertyName(node:SNode|undefined){const raw=atom(node);return raw.startsWith('"')?quoted(node,100):(/^[A-Za-z0-9_.-]{1,100}$/.test(raw)?raw:fail('invalid property name'));}
function property(node:Form) {
  const name=propertyName(node[1]);quoted(node[2]);
  // Inert labels only; resource-bearing simulation fields are not accepted.
  if(/^(?:sim\.|simulation|include|model|path|file)/i.test(name))fail('resource-bearing property');
  textChildren(node,3);
}
function stroke(node:Form){for(const child of fields(node,1,['width','type','color'])){
  if(tag(child)==='width')coordinate(child,1,0,10);
  else if(tag(child)==='color')coordinate(child,4,0,255);
  else enumeration(child,['default','solid','dash','dot','dash_dot','dash_dot_dot']);
}}
function fill(node:Form){
  if(node.length===2&&typeof node[1]==='string'){if(!['yes','no','none','solid'].includes(node[1]))fail('invalid fill');return;}
  for(const type of fields(node,1,['type']))enumeration(type,['none','solid','outline','background']);
}
const SHAPE_CHILDREN:Record<string,string[]>={
  fp_line:['start','end','layer','layers','stroke','width','uuid','tstamp','locked','fill'],
  fp_rect:['start','end','layer','layers','stroke','width','fill','uuid','tstamp','locked'],
  fp_circle:['center','end','layer','layers','stroke','width','fill','uuid','tstamp','locked'],
  fp_arc:['start','mid','end','angle','layer','layers','stroke','width','uuid','tstamp','locked'],
  fp_poly:['pts','layer','layers','stroke','width','fill','uuid','tstamp','locked'],
  gr_line:['start','end','layer','stroke','width','uuid','locked','fill'],gr_rect:['start','end','layer','stroke','width','fill','uuid','locked'],
  gr_circle:['center','end','layer','stroke','width','fill','uuid','locked'],gr_arc:['start','mid','end','layer','stroke','width','uuid','locked'],
  gr_poly:['pts','layer','stroke','width','fill','uuid','locked'],
};
function points(node:Form,max:number){
  const pts=fields(node,1,['xy','arc'],['xy','arc']);
  if(pts.length<2||pts.length>max)fail('invalid point count');
  for(const p of pts){if(tag(p)==='xy')coordinate(p,2);else for(const c of fields(p,1,['start','mid','end']))coordinate(c,2);}
}
function shape(node:Form) {
  const name=tag(node);
  for(const child of fields(node,1,SHAPE_CHILDREN[name]??[])){
    const kind=tag(child);
    if(kind==='stroke')stroke(child);
    else if(kind==='fill')fill(child);
    else if(kind==='layer'){exact(child,1);layerName(child[1]);}
    else if(kind==='layers')layers(child);
    else if(kind==='width')coordinate(child,1,0,10);
    else if(kind==='angle')coordinate(child,1,-360,360);
    else if(kind==='uuid'||kind==='tstamp')uuid(child);
    else if(kind==='locked')yesNo(child);
    else if(kind==='pts')points(child,2048);
    else coordinate(child,2);
  }
  const required:Record<string,string[]>={fp_line:['start','end'],gr_line:['start','end'],fp_rect:['start','end'],gr_rect:['start','end'],fp_circle:['center','end'],gr_circle:['center','end'],fp_arc:['start','end'],gr_arc:['start','end'],fp_poly:['pts'],gr_poly:['pts']};
  for(const requiredField of required[name]??[])if(!node.some(n=>Array.isArray(n)&&n[0]===requiredField))fail('missing '+requiredField);
}
function fpText(node:Form){
  if(!['reference','value','user'].includes(atom(node[1])))fail('invalid fp_text type');
  quoted(node[2]);textChildren(node,3);
}
const PAD_CHILDREN=['at','size','drill','layers','property','remove_unused_layers','keep_end_layers','roundrect_rratio','chamfer_ratio','chamfer','rect_delta',
  'solder_mask_margin','solder_paste_margin','solder_paste_margin_ratio','clearance','thermal_bridge_width','thermal_gap','thermal_bridge_angle','zone_connect',
  'die_length','pinfunction','pintype','uuid','tstamp','options','primitives','zone_layer_connections','tenting','teardrops','locked','free'];
function pad(node:Form) {
  quoted(node[1],64);
  if(!['smd','thru_hole','np_thru_hole','connect'].includes(atom(node[2])))fail('invalid pad type');
  if(!['circle','rect','oval','trapezoid','roundrect','custom'].includes(atom(node[3])))fail('invalid pad shape');
  let primitives=0;
  for(const child of fields(node,4,PAD_CHILDREN,['property'])){
    const kind=tag(child);
    if(kind==='at')position(child);
    else if(kind==='size')coordinate(child,2,0.001,1000);
    else if(kind==='drill'){
      let rest=child.slice(1);if(rest[0]==='oval')rest=rest.slice(1);
      const dims=rest.filter(v=>typeof v==='string');if(dims.length<1||dims.length>2)fail('invalid drill');dims.forEach(d=>number(d,0,100));
      for(const extra of rest.filter(v=>Array.isArray(v)))for(const c of fields(['drill',extra],1,['offset']))coordinate(c,2);
    }
    else if(kind==='layers')layers(child);
    else if(kind==='property'){exact(child,1);if(!/^pad_prop_[a-z_]+$/.test(atom(child[1])))fail('invalid pad property');}
    else if(kind==='roundrect_rratio')coordinate(child,1,0,0.5);
    else if(kind==='chamfer_ratio')coordinate(child,1,0,0.5);
    else if(kind==='chamfer'){if(child.length<2||child.length>5)fail('invalid chamfer');for(const c of child.slice(1))if(!['top_left','top_right','bottom_left','bottom_right'].includes(atom(c)))fail('invalid chamfer');}
    else if(kind==='rect_delta')coordinate(child,2);
    else if(kind==='zone_connect')coordinate(child,1,0,3);
    else if(kind==='thermal_bridge_angle')coordinate(child,1,0,360);
    else if(kind==='pinfunction'||kind==='pintype'){exact(child,1);quoted(child[1],256);}
    else if(kind==='uuid'||kind==='tstamp')uuid(child);
    else if(kind==='options')for(const o of fields(child,1,['clearance','anchor'])){if(tag(o)==='clearance')enumeration(o,['outline','convexhull']);else enumeration(o,['rect','circle']);}
    else if(kind==='primitives'){for(const p of fields(child,1,['gr_line','gr_rect','gr_circle','gr_arc','gr_poly'],['gr_line','gr_rect','gr_circle','gr_arc','gr_poly'])){if(++primitives>256)fail('too many primitives');shape(p);}}
    else if(kind==='zone_layer_connections')layers(child);
    else if(kind==='tenting'){if(child.length<2||child.length>3)fail('invalid tenting');for(const c of child.slice(1)){
      if(Array.isArray(c)){const side=form(c);if(!['front','back'].includes(tag(side)))fail('invalid tenting');enumeration(side,['none','yes','no']);}
      else if(!['front','back','none'].includes(atom(c)))fail('invalid tenting');}}
    else if(kind==='teardrops')for(const t of fields(child,1,['enabled','allow_two_segments','prefer_zone_connections','best_length_ratio','max_length','best_width_ratio','max_width','curved_edges','filter_ratio'])){if(t.length===2&&['yes','no'].includes(atom(t[1])))continue;coordinate(t,1,0,1000);}
    else if(kind==='remove_unused_layers'||kind==='keep_end_layers'||kind==='locked'||kind==='free')yesNo(child);
    else coordinate(child,1);
  }
  if(!node.some(n=>Array.isArray(n)&&n[0]==='at')||!node.some(n=>Array.isArray(n)&&n[0]==='size'))fail('pad needs at and size');
}
function zone(node:Form){
  for(const child of fields(node,1,['layer','layers','name','hatch','connect_pads','min_thickness','filled_areas_thickness','keepout','fill','polygon','uuid','tstamp','priority','locked','placement','attr'],['polygon'])){
    const kind=tag(child);
    if(kind==='layer'){exact(child,1);layerName(child[1]);}
    else if(kind==='layers')layers(child);
    else if(kind==='name'){exact(child,1);quoted(child[1],256);}
    else if(kind==='hatch'){exact(child,2);enumeration(['hatch',child[1]],['none','edge','full']);number(child[2],0,100);}
    else if(kind==='connect_pads'){let rest=child.slice(1);if(typeof rest[0]==='string'){if(!['yes','no','thru_hole_only','full'].includes(rest[0]))fail('invalid connect_pads');rest=rest.slice(1);}for(const c of fields(['connect_pads',...rest],1,['clearance']))coordinate(c,1,0,100);}
    else if(kind==='min_thickness')coordinate(child,1,0,100);
    else if(kind==='keepout')for(const k of fields(child,1,['tracks','vias','pads','copperpour','footprints']))enumeration(k,['allowed','not_allowed']);
    else if(kind==='fill'){let rest=child.slice(1);if(typeof rest[0]==='string'){if(!['yes','no'].includes(rest[0]))fail('invalid fill');rest=rest.slice(1);}
      for(const f of fields(['fill',...rest],1,['mode','thermal_gap','thermal_bridge_width','smoothing','radius','island_removal_mode','island_area_min','hatch_thickness','hatch_gap','hatch_orientation','hatch_smoothing_level','hatch_smoothing_value','hatch_border_algorithm','hatch_min_hole_area'])){if(f.length===2&&/^[a-z_]+$/.test(atom(f[1])))continue;coordinate(f,1,0,1000);}}
    else if(kind==='polygon')for(const p of fields(child,1,['pts']))points(p,4096);
    else if(kind==='uuid'||kind==='tstamp')uuid(child);
    else if(kind==='priority')coordinate(child,1,0,1000);
    else if(kind==='placement')for(const p of fields(child,1,['enabled','sheetname','source_type']))if(tag(p)==='enabled')yesNo(p);else{exact(p,1);quoted(p[1],256);}
    else if(kind==='attr')for(const a of fields(child,1,['teardrop']))for(const t of fields(a,1,['type']))enumeration(t,['padvia','track_end']);
    else yesNo(child);
  }
}
const ATTRS=['smd','through_hole','board_only','exclude_from_pos_files','exclude_from_bom','allow_missing_courtyard','dnp','allow_soldermask_bridges'];
const ROOT_CHILDREN=['version','generator','generator_version','layer','descr','tags','property','attr','fp_line','fp_rect','fp_circle','fp_arc','fp_poly','fp_text','dimension','pad','zone','group',
  'embedded_fonts','solder_mask_margin','solder_paste_margin','solder_paste_margin_ratio','solder_paste_ratio','clearance','zone_connect','uuid','tstamp','tedit','locked','placed',
  'duplicate_pad_numbers_are_jumpers','sheetname','sheetfile','net_tie_pad_groups','jumper_pad_groups','private_layers'];
const ROOT_REPEAT=['property','fp_line','fp_rect','fp_circle','fp_arc','fp_poly','fp_text','dimension','pad','zone','group'];
/** A KiCad dimension object: points, a layer, text and drawing style, nothing that loads anything. */
function dimension(node:Form){
  for(const child of fields(node,1,['type','layer','uuid','tstamp','pts','height','orientation','leader_length','gr_text','format','style','locked'])){
    const kind=tag(child);
    if(kind==='type')enumeration(child,['aligned','leader','center','orthogonal','radial']);
    else if(kind==='layer'){exact(child,1);layerName(child[1]);}
    else if(kind==='uuid'||kind==='tstamp')uuid(child);
    else if(kind==='pts')points(child,8);
    else if(kind==='height'||kind==='leader_length')coordinate(child,1);
    else if(kind==='orientation')coordinate(child,1,0,3);
    else if(kind==='gr_text'){quoted(child[1]);textChildren(child,2);}
    else if(kind==='format')for(const f of fields(child,1,['prefix','suffix','units','units_format','precision','override_value','suppress_zeroes'])){exact(f,1);const v=atom(f[1]);if(v.startsWith('"'))quoted(f[1],256);else if(['yes','no'].includes(v))continue;else number(f[1],0,1000);}
    else if(kind==='style')for(const f of fields(child,1,['thickness','arrow_length','text_position_mode','arrow_direction','extension_height','extension_offset','keep_text_aligned','text_frame'])){if(f.length===2&&/^[a-z_]+$/.test(atom(f[1])))continue;if(f.length===2&&['yes','no'].includes(atom(f[1])))continue;coordinate(f,1,0,1000);}
    else yesNo(child);
  }
}

/** Bounded structural check of the raw text before the tree is built. */
export function checkFootprintStructure(text:string) {
  if(typeof text!=='string'||text.length>8*1024*1024)fail('too large');
  if(/[\0\x01-\x08\x0b\x0e-\x1f]/.test(text))fail('control characters');
  let depth=0,quotedText=false,forms=0;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quotedText){if(c==='\\')i++;else if(c==='"')quotedText=false;continue;}
    if(c==='"'){quotedText=true;continue;}
    if(c==='('){depth++;forms++;if(depth>48||forms>100000)fail('structure exceeds limits');}
    if(c===')'&&--depth<0)fail('unbalanced');
  }
  if(depth||quotedText)fail('unbalanced');
}

/**
 * The footprint as it will be stored: `embedded_files` and `model` removed at
 * any depth, `embedded_fonts` forced off, and the name atom set to `name`.
 * Returns compact text; the provider's bytes are never stored as sent.
 */
export function sanitizeFootprint(text:string,name:string):string {
  checkFootprintStructure(text);
  if(!/^[^\s/\\:"]{1,256}$/.test(name))fail('invalid footprint name');
  const roots=parseSexpr(text);
  if(roots.length!==1||!Array.isArray(roots[0])||roots[0][0]!=='footprint')fail('expected one footprint');
  const strip=(node:SNode):SNode=>{
    if(!Array.isArray(node))return node;
    const kept:SNode[]=[];
    for(const child of node){
      if(Array.isArray(child)&&(child[0]==='embedded_files'||child[0]==='model'))continue;
      if(Array.isArray(child)&&child[0]==='embedded_fonts'){kept.push(['embedded_fonts','no']);continue;}
      kept.push(strip(child));
    }
    return kept;
  };
  const root=strip(roots[0]) as Form;
  root[1]='"'+name.replace(/[\\"]/g,c=>'\\'+c)+'"';
  return printSexpr(root);
}

/** Every form in a SANITIZED footprint must be on the allowlist; throws otherwise. */
export function validateFootprintSemantics(text:string):void {
  if(new TextEncoder().encode(text).length>512*1024)fail('too large after removing embedded files');
  const roots=parseSexpr(text);
  if(roots.length!==1||!Array.isArray(roots[0])||roots[0][0]!=='footprint')fail('expected one footprint');
  const root=roots[0] as Form;
  const name=quoted(root[1],256);
  if(/[/\\:]/.test(name))fail('invalid footprint name');
  let pads=0,zones=0,groups=0;
  const propertyNames=new Set<string>();
  for(const child of fields(root,2,ROOT_CHILDREN,ROOT_REPEAT)){
    const kind=tag(child);
    if(kind==='property'){property(child);const n=propertyName(child[1]);if(propertyNames.has(n))fail('duplicate property');propertyNames.add(n);}
    else if(kind==='pad'){if(++pads>4096)fail('too many pads');pad(child);}
    else if(kind==='zone'){if(++zones>64)fail('too many zones');zone(child);}
    else if(kind==='group'){if(++groups>64)fail('too many groups');for(const g of fields(child,2,['members','uuid','locked','name'])){if(tag(g)==='members'){if(g.length>4097)fail('too many members');g.slice(1).forEach(m=>quoted(m,64));}else if(tag(g)==='uuid')uuid(g);else if(tag(g)==='name'){exact(g,1);quoted(g[1],256);}else yesNo(g);}}
    else if(kind==='fp_text')fpText(child);
    else if(kind==='dimension')dimension(child);
    else if(kind in SHAPE_CHILDREN)shape(child);
    else if(kind==='attr'){if(child.length<2)fail('invalid attr');for(const a of child.slice(1))if(!ATTRS.includes(atom(a)))fail('invalid attr');}
    else if(kind==='version')coordinate(child,1,0,99999999);
    else if(kind==='generator'||kind==='generator_version'){exact(child,1);token(child[1],256);}
    else if(kind==='descr'||kind==='tags'||kind==='sheetname'||kind==='sheetfile'){exact(child,1);quoted(child[1]);}
    else if(kind==='layer'){exact(child,1);layerName(child[1]);}
    else if(kind==='embedded_fonts')enumeration(child,['no']);
    else if(kind==='uuid'||kind==='tstamp'||kind==='tedit')uuid(child);
    else if(kind==='zone_connect')coordinate(child,1,0,3);
    else if(kind==='net_tie_pad_groups'||kind==='jumper_pad_groups'){child.slice(1).forEach(g=>quoted(g,256));}
    else if(kind==='private_layers')layers(child);
    else if(kind==='locked'||kind==='placed'||kind==='duplicate_pad_numbers_are_jumpers')yesNo(child);
    else coordinate(child,1,-100,100);
  }
}
