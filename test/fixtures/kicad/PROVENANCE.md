# KiCad test fixtures — provenance

These `.kicad_pcb` / `.kicad_sch` files are **real KiCad documents** copied verbatim
from the upstream KiCad source tree (the `kicad` submodule, under `qa/data/` and
`demos/`). They are used **only as test data** for the s-expr round-trip suite — they
are not linked, imported, or distributed as part of the `@pcbjam/shared` package
(`"files": ["src"]` keeps `test/` out of any publish).

They remain under their original upstream license (KiCad project — GPL, and KiCad
demo/library content where applicable). They are not relicensed by inclusion here.

Sources (relative to the `kicad` submodule):

- `issue7241.kicad_pcb` — `qa/data/pcbnew/issue7241.kicad_pcb`
- `test_pads_inside_pads.kicad_pcb` — `demos/test_pads_inside_pads/test_pads_inside_pads.kicad_pcb`
- `groups_load_save.kicad_sch` — `qa/data/eeschema/groups_load_save.kicad_sch`
- `flat_hierarchy.kicad_sch` — `demos/flat_hierarchy/flat_hierarchy.kicad_sch`
- `rectifier.kicad_sch` — `demos/simulation/rectifier/rectifier.kicad_sch`

**To add coverage:** drop any `.kicad_pcb` / `.kicad_sch` / `.kicad_wks` / `.kicad_sym`
file into this directory (or a subdirectory) and re-run `pnpm test` — the round-trip
suite discovers fixtures automatically.
