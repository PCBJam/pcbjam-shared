/**
 * Three-way rebase for the native editor's item snapshots.
 *
 * The native bridge reports complete item snapshots, not semantic operations.
 * If Y changes while a native projection is in flight, comparing that stale
 * snapshot directly with current Y would turn every stale field into a write.
 * This module instead extracts the intent in `base -> local` and applies it to
 * `current`, at the same conflict-domain boundaries as the v3 s-expression
 * encoding.
 *
 * The rule at every domain is deliberately small and deterministic:
 *
 *   local == base  -> keep current
 *   local != base  -> apply local
 *
 * Top-level fields and schema-audited semantic-ID children are the smallest
 * domains. Native snapshots do not carry Y.Map-versus-sticky-register history,
 * so recursively guessing a finer boundary is unsound. Positional atoms and
 * anonymous repeated children are atomic: the rebase never invents a hybrid
 * sequence that no editor authored.
 */

import {
  emptyKicadItems,
  unquoteAtom,
  type KicadDoc,
  type KicadItem,
  type Slot,
} from "./kicad-doc.js";
import {
  SEMANTIC_ID_HEADS,
} from "./kicad-y2.js";

type FieldSlot = Extract<Slot, { k: string }>;

const NUMERIC_ATOM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const ATOMS_DOMAIN = JSON.stringify(["atoms"]);

function fieldDomain(head: string): string {
  return JSON.stringify(["field", head]);
}

function identifiedFieldDomain(head: string, id: string): string {
  return JSON.stringify(["field", head, id]);
}

function itemDomain(uuid: string): string {
  return JSON.stringify(["item", uuid]);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneSlot(slot: Slot): Slot {
  if ("atom" in slot) return { atom: slot.atom };
  if ("item" in slot) return { item: slot.item };
  return { k: slot.k, v: slot.v.map(cloneSlot) };
}

function cloneSlots(slots: readonly Slot[]): Slot[] {
  return slots.map(cloneSlot);
}

function cloneItem(item: KicadItem): KicadItem {
  return { type: item.type, parent: item.parent, body: cloneSlots(item.body) };
}

function semanticFirstAtom(slot: FieldSlot): string | undefined {
  const first = slot.v[0];
  if (!first || !("atom" in first)) return undefined;
  const id = unquoteAtom(first.atom);
  return id !== "" && !NUMERIC_ATOM.test(id) ? id : undefined;
}

function fieldsByHead(slots: readonly Slot[]): Map<string, FieldSlot[]> {
  const result = new Map<string, FieldSlot[]>();
  for (const slot of slots) {
    if (!("k" in slot)) continue;
    const siblings = result.get(slot.k) ?? [];
    siblings.push(slot);
    result.set(slot.k, siblings);
  }
  return result;
}

/**
 * Heads whose repeated children have stable source-level identities in all
 * three snapshots.  Looking across the three views also aligns a child that
 * was the sole instance in the base with semantic siblings added later.
 */
function identifiedHeads(
  base: readonly Slot[],
  local: readonly Slot[],
  current: readonly Slot[],
): ReadonlySet<string> {
  const views = [fieldsByHead(base), fieldsByHead(local), fieldsByHead(current)];
  const heads = new Set<string>();
  for (const view of views) for (const head of view.keys()) heads.add(head);

  const identified = new Set<string>();
  for (const head of heads) {
    if (!SEMANTIC_ID_HEADS.has(head)) continue;
    const groups = views.map((view) => view.get(head) ?? []);

    const stableInEveryView = groups.every((group) => {
      const ids = group.map(semanticFirstAtom);
      return (
        ids.every((id): id is string => id !== undefined) &&
        new Set(ids).size === ids.length
      );
    });
    if (stableInEveryView) identified.add(head);
  }
  return identified;
}

interface Domain {
  readonly kind: "atoms" | "field" | "item";
  readonly slots: readonly Slot[];
}

interface DomainView {
  readonly domains: ReadonlyMap<string, Domain>;
  readonly order: readonly string[];
}

function addDomain(
  domains: Map<string, Domain>,
  order: string[],
  key: string,
  kind: Domain["kind"],
  slot: Slot,
): void {
  const old = domains.get(key);
  if (old) {
    domains.set(key, { kind, slots: [...old.slots, slot] });
    return;
  }
  domains.set(key, { kind, slots: [slot] });
  order.push(key);
}

function domainView(slots: readonly Slot[], identified: ReadonlySet<string>): DomainView {
  const domains = new Map<string, Domain>();
  const order: string[] = [];

  for (const slot of slots) {
    if ("atom" in slot) {
      addDomain(domains, order, ATOMS_DOMAIN, "atoms", slot);
    } else if ("item" in slot) {
      addDomain(domains, order, itemDomain(slot.item), "item", slot);
    } else {
      const id = identified.has(slot.k) ? semanticFirstAtom(slot) : undefined;
      const key = id === undefined ? fieldDomain(slot.k) : identifiedFieldDomain(slot.k, id);
      addDomain(domains, order, key, "field", slot);
    }
  }

  return { domains, order };
}

function hasNonLeadingAtom(slots: readonly Slot[]): boolean {
  let leftPrefix = false;
  for (const slot of slots) {
    if ("atom" in slot) {
      if (leftPrefix) return true;
    } else {
      leftPrefix = true;
    }
  }
  return false;
}

function mergeScalar<T>(base: T, local: T, current: T): T {
  return sameValue(base, local) ? current : local;
}

function mergeDomain(
  base: Domain | undefined,
  local: Domain | undefined,
  current: Domain | undefined,
): Domain | undefined {
  // Presence is a conflict domain too.  An unchanged local presence preserves
  // a remote add/delete; an intentional local add/delete wins at this rebase.
  if (!base) {
    if (local) return { kind: local.kind, slots: cloneSlots(local.slots) };
    return current
      ? { kind: current.kind, slots: cloneSlots(current.slots) }
      : undefined;
  }
  if (!local) return undefined;
  if (!current) return undefined;

  if (sameValue(base.slots, local.slots)) {
    return { kind: current.kind, slots: cloneSlots(current.slots) };
  }

  // Plain native snapshots do not expose whether this field is a Y.Map or a
  // sticky plain-JSON register left by an earlier shape. Recursing based only
  // on today's shape can therefore cross the actual Yjs conflict boundary and
  // manufacture a hybrid. Keep each top-level field (or schema-ID child) one
  // conservative rebase domain; Yjs remains finer-grained for direct Y edits.
  return { kind: local.kind, slots: cloneSlots(local.slots) };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function mergedOrder(
  base: DomainView,
  local: DomainView,
  current: DomainView,
  domains: ReadonlyMap<string, Domain>,
): string[] {
  const localReordered = !sameOrder(base.order, local.order);
  const primary = localReordered ? local.order : current.order;
  const secondary = localReordered ? current.order : local.order;
  const result: string[] = [];
  const seen = new Set<string>();

  for (const key of [...primary, ...secondary]) {
    if (!domains.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  for (const key of [...domains.keys()].sort()) {
    if (!seen.has(key)) result.push(key);
  }
  return result;
}

/**
 * Rebase one plain slot node.  Exported primarily for executable specification
 * tests and for non-item native projections that use the same slot model.
 */
export function rebaseKicadSlots(
  base: readonly Slot[],
  local: readonly Slot[],
  current: readonly Slot[],
): Slot[] {
  // These two laws are both an optimization and a guard against incidental
  // normalization when an unusual anonymous sequence is interleaved with other
  // heads: a no-intent rebase is byte-structurally the current authored value,
  // and rebasing onto the base is byte-structurally the local authored value.
  if (sameValue(base, local)) return cloneSlots(current);
  if (sameValue(base, current)) return cloneSlots(local);

  // Atoms are positional in the source format.  The normal shape is a leading
  // run; for an unusual interleaved atom there is no safe source identity, so
  // conservatively make the entire node one domain.
  if (
    hasNonLeadingAtom(base) ||
    hasNonLeadingAtom(local) ||
    hasNonLeadingAtom(current)
  ) {
    return cloneSlots(sameValue(base, local) ? current : local);
  }

  const identified = identifiedHeads(base, local, current);
  const baseView = domainView(base, identified);
  const localView = domainView(local, identified);
  const currentView = domainView(current, identified);
  const keys = new Set([
    ...baseView.domains.keys(),
    ...localView.domains.keys(),
    ...currentView.domains.keys(),
  ]);
  const domains = new Map<string, Domain>();

  for (const key of [...keys].sort()) {
    const merged = mergeDomain(
      baseView.domains.get(key),
      localView.domains.get(key),
      currentView.domains.get(key),
    );
    if (merged) domains.set(key, merged);
  }

  return mergedOrder(baseView, localView, currentView, domains)
    .flatMap((key) => cloneSlots(domains.get(key)!.slots));
}

/** Rebase a stale native item onto the current canonical Y item. */
export function rebaseKicadItem(
  base: KicadItem,
  local: KicadItem,
  current: KicadItem,
): KicadItem {
  return {
    type: mergeScalar(base.type, local.type, current.type),
    parent: mergeScalar(base.parent, local.parent, current.parent),
    body: rebaseKicadSlots(base.body, local.body, current.body),
  };
}

/**
 * Rebase a complete stale native item snapshot onto current canonical Y items.
 *
 * Item presence follows the same three-way rule as fields.  In particular, an
 * unchanged local item does not resurrect a remotely deleted item; an explicit
 * local delete wins over a concurrent remote edit.  UUID collisions between
 * two concurrent additions resolve to the local authored item at this rebase.
 */
export function rebaseKicadItems(
  base: Readonly<Record<string, KicadItem>>,
  local: Readonly<Record<string, KicadItem>>,
  current: Readonly<Record<string, KicadItem>>,
): Record<string, KicadItem> {
  const uuids = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(current)]);
  const result = emptyKicadItems();

  for (const uuid of [...uuids].sort()) {
    const baseItem = base[uuid];
    const localItem = local[uuid];
    const currentItem = current[uuid];

    if (!baseItem) {
      if (localItem) result[uuid] = cloneItem(localItem);
      else if (currentItem) result[uuid] = cloneItem(currentItem);
      continue;
    }
    if (!localItem || !currentItem) continue;
    result[uuid] = rebaseKicadItem(baseItem, localItem, currentItem);
  }

  return result;
}

/** Rebase only `items`; `root` and `layout` remain the current Y projection. */
export function rebaseKicadDocItems(
  base: KicadDoc,
  local: KicadDoc,
  current: KicadDoc,
): KicadDoc {
  return {
    root: current.root,
    layout: cloneSlots(current.layout),
    items: rebaseKicadItems(base.items, local.items, current.items),
  };
}
