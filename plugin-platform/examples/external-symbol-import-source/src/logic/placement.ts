import type { SymbolLibrary } from './library';
import { isForm, print, quote, unquote, type Form } from './sexpr';

/** Build KiCad clipboard text; PCBJam owns confirmation and the native placement tool. */
export function buildPlacement(library: SymbolLibrary, name: string, uuid: string) {
  const symbol = library.resolve(name);
  const libId = library.nickname + ':' + name;
  const property = (key: string, fallback = '') =>
    unquote(symbol.find(node => isForm(node, 'property') && unquote(node[1]) === key)?.[2]) ?? fallback;
  const reference = property('Reference', 'U').replace(/\?+$/, '') + '?';
  const effects = '(effects (font (size 1.27 1.27)))';
  const properties = [
    `(property "Reference" ${quote(reference)} (at 2.54 -1.27 0) ${effects})`,
    `(property "Value" ${quote(property('Value', name))} (at 2.54 1.27 0) ${effects})`,
    `(property "Footprint" ${quote(property('Footprint'))} (at 0 0 0) (hide yes) ${effects})`,
    `(property "Datasheet" ${quote(property('Datasheet'))} (at 0 0 0) (hide yes) ${effects})`,
  ];
  const definition: Form = ['symbol', quote(libId), ...symbol.slice(2)];
  const instance = `(symbol (lib_id ${quote(libId)}) (at 0 0 0) (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid ${quote(uuid)}) ${properties.join('\n')})`;
  return { label: libId.slice(0, 100), sexpr: `(lib_symbols ${print(definition)})\n${instance}` };
}
