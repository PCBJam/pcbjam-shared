// The simulation library, as the app reads it (simulation 0004): the format of a part and of
// a published snapshot, the client that downloads one, the matcher that says which part a
// schematic symbol gets, the rules for a placed part's settings, and the step that writes the
// circuit a simulator runs from KiCad's netlist and the matched parts.
//
// Pure and isomorphic: no editor, no DOM beyond fetch and crypto.subtle. The parts themselves
// and the step that publishes them are not here.
export * from "./format.js";
export { WIDGETS, PLACEMENTS, type WidgetNeeds } from "./widgets.js";
export { LIBRARY_REQUEST_MS, LIBRARY_SLOW_BYTES_PER_SECOND, openLibrary, sha256, type LoadedPart, type OpenOptions, type SimLibrary } from "./client.js";
export {
  FIELD_PART, FIELD_SETTINGS, matchSymbols, resolvePins,
  type Candidate, type Match, type MatchOptions, type PinResult, type SchematicSymbol,
} from "./match.js";
export {
  readEditorNetlist, readEditorSymbols,
  type EditorNetlist, type EditorSchematic, type EditorSymbol, type NetlistItem, type NetlistLine, type NetlistMessage,
} from "./editor.js";
export {
  LEFT_OUT_TIE, LIVE_GEAR, LIVE_TRAN, buildDeck, kicadModels, prepareRun, unusableLines, valuesRead, withoutCommands,
  type BuildOptions, type Deck, type DeckCodePart, type DeckFile, type DeckInput, type DeckSignal, type DeckWire, type NotOnWire, type PlacedPart,
  type PrepareOptions, type PreparedRun, type Unusable, type ValueRead,
} from "./netlist.js";
export { isRating, plainValue, ratedValue, type PassiveKind, type RatedValue } from "./values.js";
export {
  CLOCK_AUTO, CLOCK_MAX_HZ, CLOCK_MIN_HZ, CRYSTAL_MIN_HZ, chipClock, clockSentence, clockSettingValue, clockSource, crystalOn, frequencyText, isCrystal, readFrequency,
  type ChipClock,
} from "./clock.js";
export {
  LEFT_OUT_ORDER, NOTHING_TO_SIMULATE, hasNothingToSimulate, isProtectionDiode, isPassiveRef, leftOutBy, leftOutGroup, leftOutMatters, leftOutName, leftOutNotice, leftOutRemark, leftOutSentence, leftOutSymbols, leftOutWords,
  type LeftOut, type LeftOutOptions, type LeftOutReason,
} from "./left-out.js";
export { analogParams, formatSettings, parseSettings, resolveSettings, settingAllows, settingFromValue, type ResolvedSettings } from "./settings.js";
export {
  SUPPLY_OHMS, fedParts, isSupplyWithoutVolts, namedVolts, powerByName, supplyLines,
  type AssumedSource, type NamedSupply, type Passing, type Power, type Socket, type Unpowered,
} from "./supplies.js";
export {
  CODE_MODEL_LINE_MAX, chipFile, chipModel, codeModelLines, findSource, hasElement, subcircuits, symbolsNamed, withExternalSources, type Subcircuit,
} from "./spice-text.js";
export {
  AIR_PARAM, AIR_PINS, FIELD_THERMAL, THERMAL_PIN, THERMAL_SHOWN, THERMAL_SIGNAL, THERMAL_SUFFIX, WIRE_NAME,
  findWire, overlayOf, thermalFile, thermalModel, thermalPins, thermalRoles, wireProblemText, wiresOf, wiresSaid,
  type ThermalPin, type ThermalSources, type WireProblem,
} from "./thermal.js";
