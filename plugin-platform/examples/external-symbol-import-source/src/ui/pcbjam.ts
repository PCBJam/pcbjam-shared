import type { PluginCommands } from '../contracts';

/** A typed wrapper around PCBJam's supplied iframe bridge. */
export function callPlugin<Command extends keyof PluginCommands>(
  command: Command,
  params: PluginCommands[Command]['params'],
): Promise<PluginCommands[Command]['result']> {
  return pcbjamUI.call(command, params);
}
