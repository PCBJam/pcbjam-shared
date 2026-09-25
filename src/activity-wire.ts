/**
 * Editing-activity wire shape (git-integration 0006, R-§6): what a
 * collaboration backend reports about who changed which items of a document
 * between two persists. The attribution POLICY (who is named, the summary
 * text, retention) is the backend's own; this is only the shape, so the GPL
 * backend can ignore it safely.
 *
 * Changes are counted per item TYPE (the s-expr head of a top-level item:
 * `footprint`, `segment`, `symbol`, `wire`, …) with a few item references
 * (footprint/symbol `Reference` values) for readable summaries. Non-item
 * edits (layout order, document meta, library symbols) count as `other`.
 */

export interface ActivityTypeCounts {
  added: number;
  removed: number;
  changed: number;
  /** A few references (e.g. `U1`, `C4`), capped at {@link ACTIVITY_REF_CAP}. */
  refs?: string[];
}

export interface ActivityChanges {
  items: Record<string, ActivityTypeCounts>;
  other?: number;
}

/** One authenticated writer's changes since the room's last report. */
export interface ActivityReportEntry {
  /** The connection's authenticated user slug (never a client claim). */
  user: string;
  changes: ActivityChanges;
}

export const ACTIVITY_REF_CAP = 12;

export function emptyActivityChanges(): ActivityChanges {
  return { items: {} };
}

export function isEmptyActivityChanges(c: ActivityChanges): boolean {
  return !c.other && Object.values(c.items).every((t) => !t.added && !t.removed && !t.changed);
}

/** Count one item change into `into` (mutates and returns it). */
export function noteItemChange(
  into: ActivityChanges,
  type: string,
  op: "added" | "removed" | "changed",
  ref?: string | null,
): ActivityChanges {
  const t = (into.items[type] ??= { added: 0, removed: 0, changed: 0 });
  t[op] += 1;
  if (ref) {
    const refs = (t.refs ??= []);
    if (!refs.includes(ref) && refs.length < ACTIVITY_REF_CAP) refs.push(ref);
  }
  return into;
}

/** Sum two change sets (refs unioned up to the cap). */
export function mergeActivityChanges(a: ActivityChanges, b: ActivityChanges): ActivityChanges {
  const out: ActivityChanges = { items: {} };
  for (const src of [a, b]) {
    for (const [type, t] of Object.entries(src.items)) {
      const o = (out.items[type] ??= { added: 0, removed: 0, changed: 0 });
      o.added += t.added;
      o.removed += t.removed;
      o.changed += t.changed;
      for (const r of t.refs ?? []) {
        const refs = (o.refs ??= []);
        if (!refs.includes(r) && refs.length < ACTIVITY_REF_CAP) refs.push(r);
      }
    }
    if (src.other) out.other = (out.other ?? 0) + src.other;
  }
  return out;
}

/** Defensive parse of a stored/received change set; null when malformed. */
export function parseActivityChanges(raw: unknown): ActivityChanges | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { items?: unknown; other?: unknown };
  if (!r.items || typeof r.items !== "object") return null;
  const out: ActivityChanges = { items: {} };
  for (const [type, v] of Object.entries(r.items as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(type) || !v || typeof v !== "object") return null;
    const t = v as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
    out.items[type] = { added: n(t.added), removed: n(t.removed), changed: n(t.changed) };
    if (Array.isArray(t.refs)) {
      out.items[type]!.refs = t.refs
        .filter((x): x is string => typeof x === "string" && x.length <= 64)
        .slice(0, ACTIVITY_REF_CAP);
    }
  }
  if (typeof r.other === "number" && Number.isInteger(r.other) && r.other > 0) out.other = r.other;
  return out;
}
