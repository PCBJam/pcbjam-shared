export interface PluginRates { uiCommandsPer10s: number; hostCallsPer10s: number }
export const DEFAULT_RATES: Readonly<PluginRates>;
export const RATE_CEILINGS: Readonly<PluginRates>;
export function validateLimits(input: unknown): Partial<PluginRates> | undefined;
export function effectiveRates(limits: Partial<PluginRates> | undefined): PluginRates;
