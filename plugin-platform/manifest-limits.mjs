// A plugin's own rate limits (plugins 0025 §5.3): a busy panel (an agent that edits in bursts)
// may ask for more than the defaults, up to the platform's ceilings. Reviewed with its permissions.
export const DEFAULT_RATES = Object.freeze({ uiCommandsPer10s: 20, hostCallsPer10s: 40 });
export const RATE_CEILINGS = Object.freeze({ uiCommandsPer10s: 120, hostCallsPer10s: 400 });

export function validateLimits(input) {
  if (input === undefined) return undefined;
  const fail = () => {
    throw new Error(`limits: an object of ${Object.keys(RATE_CEILINGS).join(', ')}, each an integer from its default up to ${JSON.stringify(RATE_CEILINGS)}`);
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  for (const [key, value] of Object.entries(input))
    if (!(key in RATE_CEILINGS) || !Number.isInteger(value) || value < DEFAULT_RATES[key] || value > RATE_CEILINGS[key]) fail();
  return { ...input };
}
/** The rates a running plugin gets: its declared ones within the ceilings, else the defaults. */
export function effectiveRates(limits) {
  const out = { ...DEFAULT_RATES };
  for (const key of Object.keys(out)) {
    const v = limits?.[key];
    if (Number.isInteger(v)) out[key] = Math.min(Math.max(v, DEFAULT_RATES[key]), RATE_CEILINGS[key]);
  }
  return out;
}
