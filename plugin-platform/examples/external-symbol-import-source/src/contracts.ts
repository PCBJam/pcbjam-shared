/** Shared between QuickJS logic and the React UI. No browser or host objects. */
export interface PluginCommands {
  chooseLibrary: {
    params: Record<string, never>;
    result: { cancelled: true } | { fileName: string; names: string[] };
  };
  placeSymbol: {
    params: { name: string };
    result: { status: 'placed' | 'queued' | 'cancelled' };
  };
}

export type LoadedLibrary = Exclude<PluginCommands['chooseLibrary']['result'], { cancelled: true }>;
