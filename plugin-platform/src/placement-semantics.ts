import { parseSexpr, type SNode } from '../../src/sexpr';
import { validatePlacementStructure } from './placement-validation';

type Form = SNode[];
function fail(message:string):never {throw new Error('Unsupported import: '+message);}
const atom=(node:SNode|undefined):string=>typeof node==='string'?node:fail('expected an atom');
const form=(node:SNode):Form=>Array.isArray(node)&&typeof node[0]==='string'?node:fail('expected a named form');
const tag=(node:Form)=>atom(node[0]);
function quoted(node:SNode|undefined,max=4096) {
  const value=atom(node);
  if(!value.startsWith('"')||!value.endsWith('"')||value.length>max+2)fail('invalid string');
  const result=value.slice(1,-1).replace(/\\(["\\])/g,'$1');
  if(/[\x00-\x1f\x7f]/.test(result))fail('control characters');
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
function coordinate(node:Form,dimensions:number,min=-1000,max=1000){exact(node,dimensions);node.slice(1).forEach(v=>number(v,min,max));}
function position(node:Form){coordinate(node,3);if(![0,90,180,270].includes(number(node[3])))fail('invalid angle');}
function fields(node:Form,start:number,allowed:string[],repeat:string[]=[]) {
  const seen=new Set<string>();
  return node.slice(start).map(value=>{
    const child=form(value),name=tag(child);
    if(!allowed.includes(name))fail(name+' is not supported in '+tag(node));
    if(seen.has(name)&&!repeat.includes(name))fail('duplicate '+name);
    seen.add(name);return child;
  });
}
function effects(node:Form) {
  for(const child of fields(node,1,['font','justify','hide'])){
    if(tag(child)==='font')for(const value of fields(child,1,['size','thickness','bold','italic'])){
      if(tag(value)==='size')coordinate(value,2,0.001,100);
      else if(tag(value)==='thickness')coordinate(value,1,0,10);
      else exact(value,0);
    }
    else if(tag(child)==='hide')enumeration(child,['yes','no']);
    else {if(child.length>4)fail('invalid text justification');for(const v of child.slice(1))if(!['left','right','top','bottom','mirror'].includes(atom(v)))fail('invalid text justification');}
  }
}
function property(node:Form) {
  const name=quoted(node[1],100),value=quoted(node[2]);
  // These are inert labels. Resource-bearing simulation fields are not accepted.
  if(/^(?:sim\.|simulation|include|model|path|file)/i.test(name))fail('resource-bearing property');
  if(name==='Footprint'&&value&&!/^[A-Za-z0-9_.:+ -]+$/.test(value))fail('external footprint reference');
  for(const child of fields(node,3,['at','effects','hide','id','show_name','do_not_autoplace'])){
    if(tag(child)==='at')position(child);
    else if(tag(child)==='effects')effects(child);
    else if(tag(child)==='id'){exact(child,1);number(child[1],0,1000,true);}
    else if(tag(child)==='hide')enumeration(child,['yes','no']);
    else exact(child,0);
  }
}
function stroke(node:Form){for(const child of fields(node,1,['width','type'])){
  if(tag(child)==='width')coordinate(child,1,0,10);
  else enumeration(child,['default','solid','dash','dot','dash_dot','dash_dot_dot']);
}}
function shape(node:Form) {
  const name=tag(node),start=name==='text'?2:1;
  if(name==='text')quoted(node[1]);
  const allowed:Record<string,string[]>={
    arc:['start','mid','end','stroke','fill'],circle:['center','radius','stroke','fill'],
    rectangle:['start','end','stroke','fill'],polyline:['pts','stroke','fill'],bezier:['pts','stroke','fill'],text:['at','effects'],
  };
  for(const child of fields(node,start,allowed[name]??[])){
    const kind=tag(child);
    if(kind==='stroke')stroke(child);
    else if(kind==='fill')for(const type of fields(child,1,['type']))enumeration(type,['none','outline','background']);
    else if(kind==='effects')effects(child);
    else if(kind==='radius')coordinate(child,1,0.000001,1000);
    else if(kind==='pts'){
      const points=fields(child,1,['xy'],['xy']);
      if(points.length<2||points.length>2048||(name==='bezier'&&points.length!==4))fail('invalid point count');
      points.forEach(p=>coordinate(p,2));
    }else coordinate(child,kind==='at'?3:2);
  }
  const required:Record<string,string[]>={arc:['start','mid','end'],circle:['center','radius'],rectangle:['start','end'],polyline:['pts'],bezier:['pts'],text:['at','effects']};
  for(const requiredField of required[name]??[])if(!node.some(n=>Array.isArray(n)&&n[0]===requiredField))fail('missing '+requiredField);
}
function pin(node:Form) {
  if(!['input','output','bidirectional','tri_state','passive','free','unspecified','power_in','power_out','open_collector','open_emitter','no_connect'].includes(atom(node[1])))fail('invalid pin type');
  if(!['line','inverted','clock','inverted_clock','input_low','clock_low','output_low','edge_clock_high','non_logic'].includes(atom(node[2])))fail('invalid pin shape');
  let rest=node.slice(3);if(rest[0]==='hide')rest=rest.slice(1);
  const children=fields(['pin',...rest],1,['at','length','name','number']);
  if(children.length!==4)fail('pin geometry and labels are required');
  for(const child of children){
    if(tag(child)==='at')position(child);
    else if(tag(child)==='length')coordinate(child,1,0,1000);
    else {quoted(child[1],256);for(const e of fields(child,2,['effects']))effects(e);}
  }
}
function uniqueProperties(node:Form) {
  const names=new Set<string>();
  for(const child of node)if(Array.isArray(child)&&child[0]==='property'){
    const name=quoted(child[1],100);if(names.has(name))fail('duplicate property');names.add(name);
  }
}
function definition(node:Form) {
  const name=quoted(node[1],256).split(':').at(-1)!;
  uniqueProperties(node);
  const units=new Set<string>();
  for(const child of fields(node,2,['symbol','property','pin_names','pin_numbers','exclude_from_sim','in_bom','on_board','power'],['symbol','property'])) {
    switch(tag(child)){
      case 'symbol':
        {const unitName=quoted(child[1],256),match=unitName.match(/^(.+)_(\d+)_(\d+)$/);
        if(!match||match[1]!==name||Number(match[2])>64||Number(match[3])>2||units.has(unitName))fail('invalid or duplicate symbol unit');
        units.add(unitName);}
        for(const drawing of fields(child,2,['arc','circle','rectangle','polyline','bezier','text','pin'],['arc','circle','rectangle','polyline','bezier','text','pin']))tag(drawing)==='pin'?pin(drawing):shape(drawing);
        break;
      case 'property':property(child);break;
      case 'power':exact(child,0);break;
      case 'pin_names':case 'pin_numbers':
        // KiCad emits both the legacy bare `hide` atom and `(hide yes)`.
        {const options=child.map((part,index)=>index>0&&part==='hide'?['hide','yes']:part);
        for(const option of fields(options,1,tag(child)==='pin_names'?['offset','hide']:['hide']))tag(option)==='hide'?enumeration(option,['yes','no']):coordinate(option,1,0,100);}
        break;
      default:enumeration(child,['yes','no']);
    }
  }
  if(!units.size)fail('symbol has no drawing units');
  return units;
}

/** A deliberately bounded symbol-import subset, before the live native parser. */
export function validatePlacementSemantics(text:string,tool:string) {
  validatePlacementStructure(text,tool);
  // Footprint semantics need their own full allowlist. Never route unvalidated
  // footprint/model data through the hosted symbol-import capability.
  if(tool!=='eeschema')fail('hosted import currently supports schematic symbols');
  const roots=parseSexpr(text).map(form);
  if(roots[0]!.length!==2)fail('exactly one self-contained definition is required');
  const units=definition(form(roots[0]![1]!));
  const instance=roots[1]!;
  uniqueProperties(instance);
  let unit=1,convert=1;
  for(const child of fields(instance,1,['lib_id','at','unit','convert','exclude_from_sim','in_bom','on_board','dnp','uuid','property','mirror'],['property'])) {
    switch(tag(child)){
      case 'lib_id':case 'uuid':exact(child,1);quoted(child[1],256);break;
      case 'at':position(child);break;
      case 'unit':exact(child,1);unit=number(child[1],1,64,true);break;
      case 'convert':exact(child,1);convert=number(child[1],1,2,true);break;
      case 'property':property(child);break;
      case 'mirror':enumeration(child,['x','y']);break;
      default:enumeration(child,['yes','no']);
    }
  }
  for(const required of ['at','unit'])if(!instance.some(n=>Array.isArray(n)&&n[0]===required))fail('missing symbol '+required);
  if(![...units].some(name=>{const match=name.match(/_(\d+)_(\d+)$/)!;return [0,unit].includes(Number(match[1]))&&[0,convert].includes(Number(match[2]));}))fail('instance unit is not defined');
}
