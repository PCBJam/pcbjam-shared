// The overlay widgets the app has. A library part names one of these and says what it is
// bound to; a part never ships drawing code of its own.
//
// `needs` is what the publish step checks a part's overlay entry against. The widgets
// themselves are React components in the app; this list is the contract between the two.

export interface WidgetNeeds {
  /** The widget drives an input of this type. */
  input?: "momentary" | "range";
  /** The widget shows one signal. */
  signal?: true;
  /** The widget shows exactly this many signals. */
  signals?: number;
}

export const WIDGETS: Record<string, { needs: WidgetNeeds; about: string }> = {
  "press-zone": { needs: { input: "momentary" }, about: "a zone to hold down" },
  slider: { needs: { input: "range" }, about: "a slider under the symbol" },
  glow: { needs: { signal: true }, about: "light that follows a current" },
  "seven-segment": { needs: { signals: 7 }, about: "a digit whose segments follow seven currents" },
  "chip-box": { needs: {}, about: "a frame around a chip that runs code" },
};

/** The ways a widget can be placed on its symbol. */
export const PLACEMENTS = ["over", "at", "below", "rect"] as const;
