/**
 * Total validation and deterministic repair for the flattened KicadDoc item
 * graph.  KicadDoc has two representations of containment:
 *
 *   - each item declares its `parent`; and
 *   - exactly one `{ item: uuid }` slot places it in that parent's body (or in
 *     the document layout when `parent === null`).
 *
 * The parent field is the repair authority.  A merged CRDT state can contain
 * stale, duplicate, or missing references, but it cannot tell us which stale
 * reference was the user's intended one.  Canonicalization therefore repairs
 * the parent forest first and then makes references agree with that forest.
 */

import {
  assertKicadDoc,
  emptyKicadItems,
  unquoteAtom,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "./kicad-doc.js";

export type KicadGraphIssue =
  | { kind: "missing-parent"; uuid: string; parent: string }
  | { kind: "self-parent"; uuid: string }
  | { kind: "parent-cycle"; cycle: string[] }
  | { kind: "dangling-reference"; uuid: string; owner: string | null; path: string }
  | {
      kind: "parent-reference-mismatch";
      uuid: string;
      declaredParent: string | null;
      owner: string | null;
      path: string;
    }
  | { kind: "duplicate-reference"; uuid: string; paths: string[] }
  | { kind: "orphan-item"; uuid: string }
  | { kind: "missing-item-uuid"; uuid: string }
  | { kind: "duplicate-item-uuid"; uuid: string; count: number }
  | { kind: "item-uuid-mismatch"; uuid: string; actual: string | null };

export interface KicadGraphAnalysis {
  valid: boolean;
  issues: KicadGraphIssue[];
  /** Every reference path, including wrong-parent and duplicate occurrences. */
  references: ReadonlyMap<string, readonly string[]>;
}

interface ParentView {
  readonly uuids: readonly string[];
  readonly parentOf: (uuid: string) => string | null;
  readonly has: (uuid: string) => boolean;
}

/**
 * Find every cycle in a functional parent graph.  The walk has explicit local
 * and completed sets, so malformed parent cycles cannot make validation hang.
 */
function parentCycles(view: ParentView): string[][] {
  const completed = new Set<string>();
  const cycles: string[][] = [];

  for (const start of view.uuids) {
    if (completed.has(start)) continue;

    const path: string[] = [];
    const localIndex = new Map<string, number>();
    let current: string | null = start;

    while (current !== null && view.has(current) && !completed.has(current)) {
      const seenAt = localIndex.get(current);
      if (seenAt !== undefined) {
        const raw = path.slice(seenAt);
        // A self-parent has its own, more useful issue and is not repeated as a
        // parent-cycle.  Longer cycles are rotated to a stable representation.
        if (raw.length > 1) {
          let first = 0;
          for (let i = 1; i < raw.length; i++) {
            if (raw[i]! < raw[first]!) first = i;
          }
          cycles.push([...raw.slice(first), ...raw.slice(0, first)]);
        }
        break;
      }

      localIndex.set(current, path.length);
      path.push(current);
      const parent = view.parentOf(current);
      if (parent === current) break;
      current = parent;
    }

    for (const uuid of path) completed.add(uuid);
  }

  return cycles;
}

function visitReferences(
  slots: Slot[],
  owner: string | null,
  path: string,
  visit: (uuid: string, owner: string | null, path: string) => void,
): void {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const slotPath = `${path}[${i}]`;
    if ("item" in slot) visit(slot.item, owner, slotPath);
    else if ("k" in slot) visitReferences(slot.v, owner, `${slotPath}.v`, visit);
  }
}

/**
 * Analyze every graph invariant from the correctness contract.  This function
 * terminates for cyclic parent graphs and reports all graph errors in one pass;
 * structural errors still fail at the explicit KicadDoc boundary.
 */
export function analyzeKicadDocGraph(doc: KicadDoc): KicadGraphAnalysis {
  assertKicadDoc(doc);
  const uuids = Object.keys(doc.items).sort();
  const issues: KicadGraphIssue[] = [];
  const references = new Map<string, string[]>();

  for (const uuid of uuids) {
    const item = doc.items[uuid]!;
    const parent = item.parent;
    if (parent === uuid) issues.push({ kind: "self-parent", uuid });
    else if (parent !== null && !Object.hasOwn(doc.items, parent)) {
      issues.push({ kind: "missing-parent", uuid, parent });
    }

    const uuidSlots = item.body.filter(
      (slot): slot is Extract<Slot, { k: string }> => "k" in slot && slot.k === "uuid",
    );
    if (uuidSlots.length === 0) {
      issues.push({ kind: "missing-item-uuid", uuid });
    } else if (uuidSlots.length > 1) {
      issues.push({ kind: "duplicate-item-uuid", uuid, count: uuidSlots.length });
    } else {
      const value = uuidSlots[0]!.v;
      const actual = value.length === 1 && "atom" in value[0]!
        ? unquoteAtom(value[0]!.atom)
        : null;
      if (actual !== uuid) issues.push({ kind: "item-uuid-mismatch", uuid, actual });
    }
  }

  const cycles = parentCycles({
    uuids,
    parentOf: (uuid) => doc.items[uuid]!.parent,
    has: (uuid) => Object.hasOwn(doc.items, uuid),
  });
  for (const cycle of cycles) issues.push({ kind: "parent-cycle", cycle });

  const recordReference = (uuid: string, owner: string | null, path: string): void => {
    const paths = references.get(uuid) ?? [];
    paths.push(path);
    references.set(uuid, paths);

    const target = doc.items[uuid];
    if (!target) {
      issues.push({ kind: "dangling-reference", uuid, owner, path });
    } else if (target.parent !== owner) {
      issues.push({
        kind: "parent-reference-mismatch",
        uuid,
        declaredParent: target.parent,
        owner,
        path,
      });
    }
  };

  visitReferences(doc.layout, null, "layout", recordReference);
  for (const uuid of uuids) {
    visitReferences(doc.items[uuid]!.body, uuid, `items[${JSON.stringify(uuid)}].body`, recordReference);
  }

  for (const uuid of uuids) {
    const paths = references.get(uuid) ?? [];
    if (paths.length === 0) issues.push({ kind: "orphan-item", uuid });
    else if (paths.length > 1) {
      issues.push({ kind: "duplicate-reference", uuid, paths: [...paths] });
    }
  }

  return { valid: issues.length === 0, issues, references };
}

function describeIssue(issue: KicadGraphIssue): string {
  switch (issue.kind) {
    case "missing-parent":
      return `item ${JSON.stringify(issue.uuid)} has missing parent ${JSON.stringify(issue.parent)}`;
    case "self-parent":
      return `item ${JSON.stringify(issue.uuid)} is its own parent`;
    case "parent-cycle":
      return `parent cycle ${issue.cycle.map((uuid) => JSON.stringify(uuid)).join(" -> ")}`;
    case "dangling-reference":
      return `dangling reference ${JSON.stringify(issue.uuid)} at ${issue.path}`;
    case "parent-reference-mismatch":
      return `reference ${JSON.stringify(issue.uuid)} at ${issue.path} belongs to ${JSON.stringify(issue.declaredParent)}, not ${JSON.stringify(issue.owner)}`;
    case "duplicate-reference":
      return `item ${JSON.stringify(issue.uuid)} is referenced more than once (duplicate references at ${issue.paths.join(", ")})`;
    case "orphan-item":
      return `orphan item ${JSON.stringify(issue.uuid)} is not referenced exactly once`;
    case "missing-item-uuid":
      return `item ${JSON.stringify(issue.uuid)} has no direct uuid field`;
    case "duplicate-item-uuid":
      return `item ${JSON.stringify(issue.uuid)} has ${issue.count} direct uuid fields`;
    case "item-uuid-mismatch":
      return `item key ${JSON.stringify(issue.uuid)} disagrees with direct uuid ${JSON.stringify(issue.actual)}`;
  }
}

/** Strong KicadDoc assertion: structural shape plus the complete graph contract. */
export function assertValidKicadDoc(doc: KicadDoc): KicadDoc {
  const analysis = analyzeKicadDocGraph(doc);
  if (!analysis.valid) {
    throw new Error(`invalid KicadDoc graph: ${analysis.issues.map(describeIssue).join("; ")}`);
  }
  return doc;
}

/** More explicit alias for callers that use the contract's WellFormed wording. */
export const assertWellFormedKicadDoc = assertValidKicadDoc;

function repairSlots(
  slots: Slot[],
  owner: string | null,
  items: Record<string, KicadItem>,
  kept: Set<string>,
): Slot[] {
  const repaired: Slot[] = [];
  for (const slot of slots) {
    if ("atom" in slot) {
      repaired.push({ atom: slot.atom });
      continue;
    }
    if ("k" in slot) {
      repaired.push({ k: slot.k, v: repairSlots(slot.v, owner, items, kept) });
      continue;
    }

    const target = items[slot.item];
    // Parent fields are authoritative.  Keep the first correct reference and
    // discard dangling, wrong-container, and subsequent duplicate references.
    if (target && target.parent === owner && !kept.has(slot.item)) {
      kept.add(slot.item);
      repaired.push({ item: slot.item });
    }
  }
  return repaired;
}

/** Make the record key the single authority for the native-emitted identity. */
function repairItemUuid(body: Slot[], uuid: string): Slot[] {
  const first = body.findIndex((slot) => "k" in slot && slot.k === "uuid");
  const without = body.filter((slot) => !("k" in slot && slot.k === "uuid"));
  const at = first < 0 ? without.length : Math.min(first, without.length);
  without.splice(at, 0, { k: "uuid", v: [{ atom: JSON.stringify(uuid) }] });
  return without;
}

/**
 * Convert any structurally valid merged graph into one canonical valid forest.
 *
 * Repair policy:
 *  - missing and self parents become roots;
 *  - each longer cycle is broken by rooting its lexicographically smallest id;
 *  - dangling, wrong-parent, and duplicate references are removed;
 *  - every still-unreferenced item is appended to its declared container in
 *    sorted uuid order.
 *
 * A valid document is returned by identity.  A repaired result is idempotent:
 * canonicalizing it again also returns that result by identity.
 */
export function canonicalizeKicadDocGraph(doc: KicadDoc): KicadDoc {
  const initial = analyzeKicadDocGraph(doc);
  if (initial.valid) return doc;

  const uuids = Object.keys(doc.items).sort();
  const parent = new Map<string, string | null>();
  for (const uuid of uuids) {
    const candidate = doc.items[uuid]!.parent;
    parent.set(
      uuid,
      candidate === uuid || (candidate !== null && !Object.hasOwn(doc.items, candidate))
        ? null
        : candidate,
    );
  }

  // Functional parent graphs have disjoint cycles.  Rooting one stable member
  // of every cycle turns the whole graph into a forest in one pass.
  for (const cycle of parentCycles({
    uuids,
    parentOf: (uuid) => parent.get(uuid) ?? null,
    has: (uuid) => parent.has(uuid),
  })) {
    parent.set([...cycle].sort()[0]!, null);
  }

  const items = emptyKicadItems();
  for (const uuid of uuids) {
    const source = doc.items[uuid]!;
    items[uuid] = { type: source.type, parent: parent.get(uuid) ?? null, body: [] };
  }

  const kept = new Set<string>();
  const layout = repairSlots(doc.layout, null, items, kept);
  for (const uuid of uuids) {
    items[uuid]!.body = repairItemUuid(
      repairSlots(doc.items[uuid]!.body, uuid, items, kept),
      uuid,
    );
  }

  // Information about the original nested slot location is gone once a
  // reference is missing or invalid.  Appending to the owning container is the
  // only deterministic, lossless-with-respect-to-items recovery available.
  for (const uuid of uuids) {
    if (kept.has(uuid)) continue;
    const owner = items[uuid]!.parent;
    if (owner === null) layout.push({ item: uuid });
    else items[owner]!.body.push({ item: uuid });
    kept.add(uuid);
  }

  return assertValidKicadDoc({ root: doc.root, items, layout });
}

/** Contract-language alias: graph canonicalization is graph normalization. */
export const normalizeKicadDocGraph = canonicalizeKicadDocGraph;
