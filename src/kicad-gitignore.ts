/**
 * The `.gitignore` PCBJam writes into a new Git repository's first commit
 * (git-integration 0017) and into a new KiCad project at a repository root
 * (new-kicad-project 0001).
 *
 * The rules are GitHub's KiCad template, verbatim
 * (https://github.com/github/gitignore/blob/main/KiCad.gitignore, CC0-1.0),
 * read 2026-10-05. PCBJam adds only the header comment.
 */
export const KICAD_GITIGNORE = `# KiCad .gitignore, written by PCBJam.
# Rules from https://github.com/github/gitignore/blob/main/KiCad.gitignore (CC0-1.0).

# For PCBs designed using KiCad: https://www.kicad.org/
# Format documentation: https://kicad.org/help/file-formats/

# Temporary files
*.000
*.bak
*.bck
*.kicad_pcb-bak
*.kicad_sch-bak
*-backups
*-cache*
*-bak
*-bak*
*~
~*
_autosave-*
\\#auto_saved_files\\#
*.tmp
*-save.pro
*-save.kicad_pcb
fp-info-cache
~*.lck
\\#auto_saved_files#

# Netlist files (exported from Eeschema)
*.net

# Autorouter files (exported from Pcbnew)
*.dsn
*.ses

# Exported BOM files
*.xml
*.csv

# Archived Backups (KiCad 6.0)
**/*-backups/*.zip

# Local git-based history (KiCad 9.0+)
.history

# Local project settings
*.kicad_prl
`;
