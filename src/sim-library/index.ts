// The simulation library, as the app reads it (simulation 0004): the format of a part and of
// a published snapshot, the client that downloads one, the matcher that says which part a
// schematic symbol gets, the rules for a placed part's settings, and the step that writes the
// circuit a simulator runs from KiCad's netlist and the matched parts.
//
// Pure and isomorphic: no editor, no DOM beyond fetch and crypto.subtle. The parts themselves
// and the step that publishes them are not here.
export * from "./format.js";
export { WIDGETS, PLACEMENTS, type WidgetNeeds } from "./widgets.js";
export { openLibrary, sha256, type LoadedPart, type OpenOptions, type SimLibrary } from "./client.js";
export {
  FIELD_PART, FIELD_SETTINGS, matchSymbols, resolvePins,
  type Candidate, type Match, type MatchOptions, type PinResult, type SchematicSymbol,
} from "./match.js";
export {
  readEditorNetlist, readEditorSymbols,
  type EditorNetlist, type EditorSchematic, type EditorSymbol, type NetlistItem, type NetlistLine, type NetlistMessage,
} from "./editor.js";
export {
  LEFT_OUT_TIE, LIVE_TRAN, buildDeck, kicadModels, prepareRun, unusableLines,
  type BuildOptions, type Deck, type DeckCodePart, type DeckFile, type DeckInput, type DeckSignal, type PlacedPart,
  type PrepareOptions, type PreparedRun, type Unusable,
} from "./netlist.js";
export { analogParams, formatSettings, parseSettings, resolveSettings, settingAllows, settingFromValue, type ResolvedSettings } from "./settings.js";
export {
  CODE_MODEL_LINE_MAX, codeModelLines, findSource, hasElement, subcircuits, withExternalSources, type Subcircuit,
} from "./spice-text.js";
