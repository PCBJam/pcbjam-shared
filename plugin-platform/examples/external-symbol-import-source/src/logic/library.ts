import { isForm, parseLibrary, quote, unquote, type Form } from './sexpr';

export interface SymbolLibrary {
  names: string[];
  nickname: string;
  resolve(name: string): Form;
}

/** Match a derived symbol's fields with the parent fields they replace. */
function fieldKey(node: Form): string {
  if (isForm(node, 'property')) return 'property:' + unquote(node[1]);
  if (isForm(node, 'symbol')) return 'unit:' + unquote(node[1])?.replace(/^.*(_\d+_\d+)$/, '$1');
  return node[0];
}

export function readLibrary(text: string, filename: string): SymbolLibrary {
  const root = parseLibrary(text);
  const symbols = new Map<string, Form>();
  for (const node of root.slice(1)) {
    if (!isForm(node, 'symbol')) continue;
    const name = unquote(node[1]);
    if (!name || name.length > 160 || symbols.has(name)) throw new Error('Invalid or duplicate symbol name.');
    symbols.set(name, node);
  }
  if (!symbols.size || symbols.size > 2000) throw new Error('Choose a library containing 1–2000 symbols.');

  function resolve(name: string, seen = new Set<string>()): Form {
    if (seen.has(name) || seen.size > 16) throw new Error('Circular or overly deep symbol inheritance.');
    const current = symbols.get(name);
    if (!current) throw new Error('Missing parent symbol: ' + name);
    seen.add(name);

    const parentName = unquote(current.find(node => isForm(node, 'extends'))?.[1]);
    const parent: Form = parentName ? resolve(parentName, seen) : ['symbol', quote(name)];
    const children = new Map<string, Form>();
    for (const child of [...parent.slice(2), ...current.slice(2)]) {
      if (!Array.isArray(child) || typeof child[0] !== 'string') continue;
      if (['extends', 'in_pos_files', 'embedded_fonts'].includes(child[0])) continue;
      let value = child as Form;
      if (isForm(child, 'symbol')) {
        const suffix = unquote(child[1])?.match(/_\d+_\d+$/)?.[0];
        if (!suffix) throw new Error('Invalid symbol unit name.');
        value = ['symbol', quote(name + suffix), ...child.slice(2)];
      }
      children.set(fieldKey(value), value);
    }
    return ['symbol', quote(name), ...children.values()];
  }

  return {
    names: [...symbols.keys()],
    nickname: filename.replace(/\.kicad_sym$/i, '').replace(/[:/\\]/g, '_').slice(0, 80) || 'External',
    resolve,
  };
}
