import type { FabProfile } from "./fab-profile.js";

/**
 * The manufacturing disclaimer (new-kicad-project 0001), one sentence shared
 * by the New KiCad project dialog and the docs site. Informative, not a gate.
 * Null for the KiCad default template, which claims nothing about a fab.
 */
export function fabDisclaimer(profile: FabProfile): string | null {
  if (profile.kind !== "fab") return null;
  return (
    `Rules based on ${profile.name}'s published capabilities as of ${profile.reviewedAt}. ` +
    "Check them against your order before manufacturing; PCBJam isn't responsible for manufacturing results."
  );
}
