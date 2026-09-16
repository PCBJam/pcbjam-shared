// This entire module executes INSIDE QuickJS, under its CPU and memory limits.
import { parseSexpr, printSexpr, type SNode } from '../../src/sexpr';
import { fileToDoc, docToFile, slotFromSexpr, type KicadItem, type Slot } from '../../src/kicad-doc';
import { docDelta } from '../../src/kicad-delta';
const MAX = 512 * 1024;
function checkText(text: unknown): asserts text is string {
    if (typeof text !== 'string' || text.length > MAX || /[\0\x01-\x08\x0b\x0e-\x1f]/.test(text))
        throw new Error('Invalid or oversized s-expression');
    let depth = 0, forms = 0, quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted && c === '\\') {
            i++;
            continue;
        }
        if (c === '"') {
            quoted = !quoted;
            continue;
        }
        if (quoted)
            continue;
        if (c === '(' && (++depth > 48 || ++forms > 12000))
            throw new Error('S-expression structure exceeds limits');
        if (c === ')' && --depth < 0)
            throw new Error('Unbalanced s-expression');
    }
    if (depth || quoted)
        throw new Error('Unbalanced s-expression');
}
export function parse(text: string) { checkText(text); return parseSexpr(text); }
export function print(nodes: SNode[]) {
    let count = 0, chars = 0;
    const active = new Set<object>();
    function check(node: SNode, depth: number): void {
        if (++count > 50000 || depth > 48)
            throw new Error('S-expression structure exceeds limits');
        if (typeof node === 'string') {
            chars += node.length;
            if (chars > MAX)
                throw new Error('S-expression exceeds size limit');
            const atom = parse(node);
            if (atom.length !== 1 || typeof atom[0] !== 'string')
                throw new Error('Invalid s-expression atom');
            return;
        }
        if (!Array.isArray(node) || active.has(node))
            throw new Error('Invalid s-expression nodes');
        active.add(node);
        node.forEach(x => check(x, depth + 1));
        active.delete(node);
    }
    if (!Array.isArray(nodes))
        throw new Error('Expected an array of forms');
    nodes.forEach(node => check(node, 0));
    const text = nodes.map(printSexpr).join('\n');
    checkText(text);
    return text;
}
export function diff(before: string, after: string) {
    checkText(before);
    checkText(after);
    const a = fileToDoc(before), b = fileToDoc(after);
    if (a.root !== b.root)
        throw new Error('Cannot diff different document kinds');
    const result = docDelta(a, b);
    return { added: result.added.map(item => item.uuid), updated: result.updated.map(item => item.uuid), removed: result.removed, layoutChanged: JSON.stringify(a.layout) !== JSON.stringify(b.layout) };
}
export function serializeSnapshot(snapshot: any): string {
    const items: Record<string, KicadItem> = Object.create(null);
    for (const item of snapshot.items)
        items[item.id] = { type: item.type, parent: item.parent, body: item.body };
    const layout: Slot[] = snapshot.layout;
    if (snapshot.libSymbols.length) {
        const definitions = snapshot.libSymbols.map((text: string) => { checkText(text); return slotFromSexpr(text, items); });
        const at = layout.findIndex(slot => 'k' in slot && slot.k === 'lib_symbols');
        if (at >= 0)
            layout[at] = { k: 'lib_symbols', v: definitions };
        else
            layout.unshift({ k: 'lib_symbols', v: definitions });
    }
    const text = docToFile({ root: snapshot.root, items, layout });
    if (text.length > 1024 * 1024)
        throw new Error('Serialized document exceeds size limit');
    return text;
}
