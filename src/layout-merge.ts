/**
 * Three-way merge of non-item document state (proposal 21, WP1 — sync audit
 * SYNC-06b, layer-drift case 3).
 *
 * `syncLayoutToY` used to replace a changed header head (`title_block`, `setup`,
 * `layers`, …) wholesale. Its baseline only says WHICH head the writer changed,
 * so a stale writer who changed one field of a head also wrote back every other
 * field of it it still held — a revision edit wiped a peer's title, a design-rule
 * edit wiped a peer's 4-layer stackup.
 *
 * `merge3Slots(base, mine, theirs)` keeps a sub-slot from `mine` only where
 * `mine` differs from `base` (the writer's actual edit); everywhere else the
 * current doc (`theirs`) wins. `(k …)` children are matched by identity:
 *  - a kind occurring once in its list → its head;
 *  - a repeated kind → its unquoted FIRST ATOM when unique among its siblings
 *    (stackup `(layer "In1.Cu" …)`, root `(property "k" …)`, and — unlike the
 *    item codec — numeric ids too: `title_block (comment 1 …)`, where the number
 *    IS the identity);
 *  - otherwise the kind's occurrence index.
 * Positional atoms are matched by index. When both sides changed the same
 * `(k …)` child the merge recurses into it; two different edits of the same
 * leaf are last-writer-wins for the writer (`mine`) — the caller's transaction
 * is the latest write.
 *
 * Pure and deterministic; no Y types.
 */
import { unquoteAtom, type Slot } from "./kicad-doc.js";

type Keyed = { key: string; slot: Slot };

/** Kinds that occur more than once in `slots`. */
function repeatedKinds(slots: readonly Slot[]): Set<string> {
  const seen = new Set<string>();
  const rep = new Set<string>();
  for (const s of slots) {
    if (!("k" in s)) continue;
    if (seen.has(s.k)) rep.add(s.k);
    seen.add(s.k);
  }
  return rep;
}

/**
 * `repeated`: kinds repeated in ANY of the three lists being merged — keyed by
 * first atom in all of them, so `(comment 2 …)` alone in the base still matches
 * `(comment 2 …)` next to a new `(comment 1 …)`.
 */
function keyed(slots: readonly Slot[], repeated: ReadonlySet<string>): Keyed[] {
  const byKind = new Map<string, number[]>();
  slots.forEach((s, i) => {
    if (!("k" in s)) return;
    const list = byKind.get(s.k) ?? [];
    list.push(i);
    byKind.set(s.k, list);
  });
  const keys = new Array<string>(slots.length);
  for (const [kind, idxs] of byKind) {
    if (idxs.length === 1 && !repeated.has(kind)) {
      keys[idxs[0]!] = `k:${kind}`;
      continue;
    }
    const firsts = idxs.map((i) => {
      const first = (slots[i] as { v: Slot[] }).v[0];
      return first && "atom" in first ? unquoteAtom(first.atom) : undefined;
    });
    const counts = new Map<string, number>();
    for (const f of firsts) if (f !== undefined) counts.set(f, (counts.get(f) ?? 0) + 1);
    let occurrence = 0;
    idxs.forEach((i, j) => {
      const f = firsts[j];
      keys[i] = f !== undefined && counts.get(f) === 1 ? `k:${kind}#${f}` : `k:${kind}@${occurrence++}`;
    });
  }
  let atomIdx = 0;
  return slots.map((slot, i) => {
    if ("item" in slot) return { key: `item:${slot.item}`, slot };
    if ("atom" in slot) return { key: `atom@${atomIdx++}`, slot };
    return { key: keys[i]!, slot };
  });
}

const same = (a: Slot | undefined, b: Slot | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/** Three-way merge of an ordered slot list (see module doc). */
export function merge3Slots(base: readonly Slot[], mine: readonly Slot[], theirs: readonly Slot[]): Slot[] {
  const repeated = new Set([...repeatedKinds(base), ...repeatedKinds(mine), ...repeatedKinds(theirs)]);
  const kb = keyed(base, repeated);
  const km = keyed(mine, repeated);
  const kt = keyed(theirs, repeated);
  const B = new Map(kb.map((k) => [k.key, k.slot]));
  const M = new Map(km.map((k) => [k.key, k.slot]));
  const T = new Map(kt.map((k) => [k.key, k.slot]));

  const pick = (key: string): Slot | undefined => {
    const b = B.get(key);
    const m = M.get(key);
    const t = T.get(key);
    if (same(m, b)) return t; // the writer didn't touch it: the doc's version stands
    if (m === undefined) return undefined; // the writer deleted it
    if (same(t, b) || t === undefined) return m; // only the writer changed it (or theirs dropped it: resurrect the edit)
    // Both changed: recurse into structured children, else the writer wins.
    if (b && "k" in b && "k" in m && "k" in t && m.k === t.k) {
      return { k: m.k, v: merge3Slots(b.v, m.v, t.v) };
    }
    return m;
  };

  // Order: the writer's order for the keys it holds; keys only the doc holds
  // (a peer's additions — not in base, so not something the writer deleted)
  // stay right after their predecessor in the doc's order.
  const out: Keyed[] = [];
  for (const { key } of km) {
    const slot = pick(key);
    if (slot !== undefined) out.push({ key, slot });
  }
  let prev: string | undefined;
  for (const { key } of kt) {
    if (!M.has(key)) {
      const slot = B.has(key) ? pick(key) : T.get(key);
      if (slot !== undefined && !out.some((o) => o.key === key)) {
        const at = prev === undefined ? 0 : out.findIndex((o) => o.key === prev) + 1;
        out.splice(at, 0, { key, slot });
      }
    }
    if (out.some((o) => o.key === key)) prev = key;
  }
  return out.map((o) => o.slot);
}
