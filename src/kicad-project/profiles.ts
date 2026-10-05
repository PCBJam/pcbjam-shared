import { fabProfileSchema, type FabProfile } from "./fab-profile.js";
import kicadDefault from "./profiles/kicad-default.json" with { type: "json" };
import pcbway from "./profiles/pcbway.json" with { type: "json" };
import jlcpcb from "./profiles/jlcpcb.json" with { type: "json" };

/**
 * The built-in fab profiles, in the order the New KiCad project dialog shows
 * them: KiCad default, then PCBWay, then JLCPCB. Parsed once at import so a
 * malformed profile fails loudly (and the shared test suite catches it).
 */
export const BUILTIN_FAB_PROFILES: readonly FabProfile[] = [kicadDefault, pcbway, jlcpcb].map((p) =>
  fabProfileSchema.parse(p),
);

export function builtinFabProfile(id: string): FabProfile | undefined {
  return BUILTIN_FAB_PROFILES.find((p) => p.id === id);
}
