import type { PluginCommands } from './contracts';
import { readLibrary, type SymbolLibrary } from './logic/library';
import { buildPlacement } from './logic/placement';

// These handlers run in QuickJS. React and browser APIs belong in src/ui/.
let library: SymbolLibrary | undefined;

pcbjam.handle('chooseLibrary', async (): Promise<PluginCommands['chooseLibrary']['result']> => {
  const file = await pcbjam.files.choose({ extensions: ['.kicad_sym'] });
  if (!file) return { cancelled: true };

  try {
    const text = await pcbjam.files.readText(file.handle);
    const parsed = readLibrary(text, file.name);
    library = parsed;
    return { fileName: file.name, names: parsed.names };
  } finally {
    await pcbjam.files.close(file.handle);
  }
});

pcbjam.handle('placeSymbol', async (params: unknown): Promise<PluginCommands['placeSymbol']['result']> => {
  // TypeScript helps authors; runtime checks still protect against malformed UI messages.
  if (!params || typeof params !== 'object' || Array.isArray(params) ||
      Object.keys(params).length !== 1 || !('name' in params) || typeof params.name !== 'string') {
    throw new Error('Choose a symbol by name.');
  }
  const name = params.name;
  if (!library || !library.names.includes(name)) {
    throw new Error('Choose a symbol from the loaded library.');
  }

  const context = await pcbjam.context.get();
  if (context.tool !== 'eeschema' || context.readOnly || !context.canPlaceItems) {
    throw new Error('Open an editable schematic with placement support.');
  }
  const proposal = buildPlacement(library, name, pcbjam.randomUUID());
  return pcbjam.editor.requestPlacement(proposal);
});
