// The overlay widgets the app has. A library part names one of these and says what it is
// bound to; a part never ships drawing code of its own.
//
// `needs` is what the publish step checks a part's overlay entry against. The widgets
// themselves are React components in the app; this list is the contract between the two.

export interface WidgetNeeds {
  /** The widget drives an input of this type. */
  input?: "momentary" | "range" | "toggle";
  /** The widget shows one signal. */
  signal?: true;
  /** The widget shows exactly this many signals, or from so many to so many. */
  signals?: number | [number, number];
}

export const WIDGETS: Record<string, { needs: WidgetNeeds; about: string }> = {
  "press-zone": { needs: { input: "momentary" }, about: "a zone to hold down" },
  slider: { needs: { input: "range" }, about: "a slider under the symbol" },
  "toggle-zone": { needs: { input: "toggle" }, about: "a zone to click: on, and on the next click off" },
  glow: { needs: { signal: true }, about: "light that follows a current" },
  "glow-mix": { needs: { signals: [2, 3] }, about: "one light that mixes the colours of two or three currents" },
  meter: { needs: { signal: true }, about: "a number with a unit" },
  contact: { needs: { signal: true }, about: "the contacts of a part that moves them by itself, drawn where they are now" },
  spin: { needs: { signal: true }, about: "a mark that goes round on a part that turns, as fast and the way it turns" },
  sound: { needs: { signal: true }, about: "rings that spread from a part while it sounds, more of them the louder it is" },
  "seven-segment": { needs: { signals: [7, 8] }, about: "a digit whose segments follow seven currents, an eighth is its point" },
  "chip-box": { needs: {}, about: "a frame around a chip that runs code" },
};

/** The ways a widget can be placed on its symbol. */
export const PLACEMENTS = ["over", "at", "below", "rect"] as const;
