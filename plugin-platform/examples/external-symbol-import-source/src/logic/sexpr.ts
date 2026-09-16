/** Small bounded parser for library files, which can exceed the SDK helper's text limit. */
export type Node = string | Node[];
export type Form = [string, ...Node[]];

export function isForm(node: Node | undefined, tag: string): node is Form {
  return Array.isArray(node) && node[0] === tag;
}

export function quote(value: string): string {
  return '"' + value.replace(/[\\"]/g, character => '\\' + character) + '"';
}

export function unquote(value: Node | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/gs, '$1') : value;
}

export function print(node: Node): string {
  return Array.isArray(node) ? '(' + node.map(print).join(' ') + ')' : node;
}

export function parseLibrary(text: string): Form {
  if (text.length > 4 * 1024 * 1024) throw new Error('Library is too large.');
  const roots: Node[] = [];
  const stack: Node[][] = [roots];
  let position = 0;
  let nodes = 0;

  while (position < text.length) {
    const character = text[position]!;
    if (/\s/.test(character)) { position++; continue; }
    if (++nodes > 120000) throw new Error('Library is too complex.');
    const parent = stack[stack.length - 1]!;

    if (character === '(') {
      if (stack.length > 48) throw new Error('Library nesting is too deep.');
      const list: Node[] = [];
      parent.push(list);
      stack.push(list);
      position++;
      continue;
    }
    if (character === ')') {
      if (stack.length === 1) throw new Error('Unexpected closing parenthesis.');
      stack.pop();
      position++;
      continue;
    }

    const start = position;
    if (character === '"') {
      position++;
      let closed = false;
      while (position < text.length) {
        if (text[position] === '\\') { position += 2; continue; }
        if (text[position++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated string.');
    } else {
      while (position < text.length && !/[\s()"]/.test(text[position]!)) position++;
    }
    parent.push(text.slice(start, position));
  }

  if (stack.length !== 1 || roots.length !== 1 || !isForm(roots[0], 'kicad_symbol_lib')) {
    throw new Error('Expected one complete .kicad_sym library.');
  }
  return roots[0];
}
