import type * as Y from "yjs";
import { listThreads } from "./comments-y.js";
import { PRESENCE_COLORS } from "./presence-wire.js";

/**
 * Deterministic palette slots for COMMENT AUTHORS (collab-presence 0009 C):
 * authors take colors round-robin by FIRST APPEARANCE over the doc's threads
 * (thread order = createdAt+id, then replies in order) — every client computes
 * the identical map from the identical doc, no coordination. Two uses:
 *
 *  - offline authors' pins/panel entries get a stable palette color instead
 *    of the old name hash (which could collide with a live peer's claim);
 *  - live presence claims treat these slots as USED (lowestFreeColor) so a
 *    joining user avoids the doc's existing authors' colors while free slots
 *    remain, and an author rejoining prefers their own comment color — the
 *    pin and the cursor agree.
 */
export function commentAuthorColors(doc: Y.Doc): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of listThreads(doc)) {
    for (const author of [t.createdBy, ...t.messages.map((m) => m.author)]) {
      if (!map.has(author)) {
        map.set(author, PRESENCE_COLORS[map.size % PRESENCE_COLORS.length]!);
      }
    }
  }
  return map;
}
