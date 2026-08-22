import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  fileToDoc,
  field,
  scalar,
  type KicadItem,
  type Slot,
} from "../src/kicad-doc.js";
import { docToY, kicadItemsMap } from "../src/kicad-y.js";
import {
  rebaseKicadItem,
  rebaseKicadItems,
  rebaseKicadSlots,
} from "../src/native-rebase.js";

function atoms(...values: string[]): Slot[] {
  return values.map((atom) => ({ atom }));
}

function item(body: Slot[], parent: string | null = null): KicadItem {
  return { type: "segment", parent, body };
}

function setField(body: Slot[], key: string, value: Slot[]): Slot[] {
  return body.map((slot) => "k" in slot && slot.k === key ? { k: key, v: value } : slot);
}

describe("native snapshot three-way rebase", () => {
  it("preserves a newer remote width while applying a stale native layer edit", () => {
    const base = item([
      { k: "width", v: atoms("0.2") },
      { k: "layer", v: atoms('"F.Cu"') },
    ]);
    const local = item(setField(base.body, "layer", atoms('"B.Cu"')));
    const current = item(setField(base.body, "width", atoms("0.4")));

    const rebased = rebaseKicadItem(base, local, current);

    expect(scalar(rebased.body, "width")).toBe("0.4");
    expect(scalar(rebased.body, "layer")).toBe('"B.Cu"');
  });

  it("uses the local authored value deterministically for a same-domain conflict", () => {
    const base = item([{ k: "width", v: atoms("0.2") }]);
    const local = item([{ k: "width", v: atoms("0.3") }]);
    const current = item([{ k: "width", v: atoms("0.4") }]);

    expect(scalar(rebaseKicadItem(base, local, current).body, "width")).toBe("0.3");
  });

  it("rebases type and parent as independent domains", () => {
    const base = item([], "parent-a");
    const local = { ...base, type: "arc" };
    const current = { ...base, parent: "parent-b" };

    expect(rebaseKicadItem(base, local, current)).toMatchObject({
      type: "arc",
      parent: "parent-b",
    });
  });

  it("treats positional leading atoms as one atomic intent domain", () => {
    const base = atoms('"1"', "smd", "rect");
    const local = atoms('"1"', "smd", "roundrect");
    const current = atoms('"1"', "thru_hole", "rect", "locked");

    expect(rebaseKicadSlots(base, local, current)).toEqual(local);
  });

  it("obeys the no-local-intent and no-remote-change identity laws exactly", () => {
    const base: Slot[] = [
      { k: "xy", v: atoms("0", "0") },
      { k: "stroke", v: [{ k: "width", v: atoms("0.1") }] },
      { k: "xy", v: atoms("1", "1") },
    ];
    const local: Slot[] = [
      { k: "xy", v: atoms("7", "7") },
      { k: "stroke", v: [{ k: "width", v: atoms("0.1") }] },
      { k: "xy", v: atoms("1", "1") },
    ];
    const current: Slot[] = [
      { k: "xy", v: atoms("9", "9") },
      { k: "stroke", v: [{ k: "width", v: atoms("0.2") }] },
      { k: "xy", v: atoms("0", "0") },
      { k: "xy", v: atoms("1", "1") },
    ];

    expect(rebaseKicadSlots(base, base, current)).toEqual(current);
    expect(rebaseKicadSlots(base, local, base)).toEqual(local);
  });

  it("merges audited semantic-ID children but keeps each child atomic", () => {
    const base: Slot[] = [
      {
        k: "property",
        v: [
          ...atoms('"Reference"', '"R1"'),
          { k: "at", v: atoms("0", "0") },
          { k: "effects", v: [{ k: "font", v: [{ k: "size", v: atoms("1", "1") }] }] },
        ],
      },
      {
        k: "property",
        v: [...atoms('"Value"', '"10k"'), { k: "at", v: atoms("1", "1") }],
      },
    ];
    const local = structuredClone(base);
    const reference = local[0]! as Extract<Slot, { k: string }>;
    reference.v[1] = { atom: '"R2"' };
    const current = structuredClone(base);
    const value = current[1]! as Extract<Slot, { k: string }>;
    value.v[1] = { atom: '"22k"' };
    const refEffects = field((current[0]! as Extract<Slot, { k: string }>).v, "effects")!;
    const font = field(refEffects, "font")!;
    font.push({ k: "thickness", v: atoms("0.15") });

    const rebased = rebaseKicadSlots(base, local, current);
    const ref = (rebased[0]! as Extract<Slot, { k: string }>).v;
    const val = (rebased[1]! as Extract<Slot, { k: string }>).v;

    expect((ref[1]! as { atom: string }).atom).toBe('"R2"');
    expect(field(field(ref, "effects")!, "font")).not.toContainEqual({
      k: "thickness",
      v: atoms("0.15"),
    });
    expect((val[1]! as { atom: string }).atom).toBe('"22k"');
  });

  it("keeps an anonymous repeated sequence atomic instead of making a hybrid", () => {
    const base: Slot[] = [{
      k: "pts",
      v: [
        { k: "xy", v: atoms("0", "0") },
        { k: "xy", v: atoms("1", "1") },
      ],
    }];
    const local: Slot[] = [{
      k: "pts",
      v: [
        { k: "xy", v: atoms("7", "7") },
        { k: "xy", v: atoms("1", "1") },
      ],
    }];
    const current: Slot[] = [{
      k: "pts",
      v: [
        { k: "xy", v: atoms("9", "9") },
        { k: "xy", v: atoms("0", "0") },
        { k: "xy", v: atoms("1", "1") },
      ],
    }];

    expect(field(rebaseKicadSlots(base, local, current), "pts")).toEqual(field(local, "pts"));
  });

  it("does not infer identities for arbitrary string-first children", () => {
    const base: Slot[] = [{
      k: "container",
      v: [
        { k: "foo", v: atoms('"a"', "0") },
        { k: "foo", v: atoms('"b"', "1") },
      ],
    }];
    const local: Slot[] = [{
      k: "container",
      v: [
        { k: "foo", v: atoms('"a"', "7") },
        { k: "foo", v: atoms('"b"', "1") },
      ],
    }];
    const current: Slot[] = [{
      k: "container",
      v: [
        { k: "foo", v: atoms('"new"', "9") },
        { k: "foo", v: atoms('"a"', "0") },
        { k: "foo", v: atoms('"b"', "1") },
      ],
    }];

    expect(rebaseKicadSlots(base, local, current)).toEqual(local);
  });

  it("aligns an audited singleton identity across a one-to-two transition", () => {
    const base: Slot[] = [{ k: "property", v: atoms('"Reference"', '"R1"') }];
    const local: Slot[] = [{ k: "property", v: atoms('"Reference"', '"R2"') }];
    const current: Slot[] = [
      { k: "property", v: atoms('"Reference"', '"R1"') },
      { k: "property", v: atoms('"Value"', '"10k"') },
    ];

    expect(rebaseKicadSlots(base, local, current)).toEqual([
      { k: "property", v: atoms('"Reference"', '"R2"') },
      { k: "property", v: atoms('"Value"', '"10k"') },
    ]);
  });

  it("keeps a structured field atomic because plain snapshots lack sticky storage history", () => {
    const base: Slot[] = [{
      k: "effects",
      v: [{ k: "font", v: [{ k: "size", v: atoms("1", "1") }] }],
    }];
    const local: Slot[] = [{
      k: "effects",
      v: [{ k: "font", v: [{ k: "size", v: atoms("2", "2") }] }],
    }];
    const current: Slot[] = [{
      k: "effects",
      v: [{
        k: "font",
        v: [
          { k: "size", v: atoms("1", "1") },
          { k: "thickness", v: atoms("0.15") },
        ],
      }],
    }];

    expect(rebaseKicadSlots(base, local, current)).toEqual(local);
  });

  it("uses the same anonymous conflict domain as the actual v3 plain register", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(
      `(kicad_pcb
        (mystery
          (container (foo "a" 0) (foo "b" 1))
          (uuid "item-1")))`,
    ), ydoc, "seed");
    const body = kicadItemsMap(ydoc).get("item-1")!.get("body");
    expect(body).toBeInstanceOf(Y.Map);
    const container = (body as Y.Map<unknown>).get("container#1");
    expect(Array.isArray(container)).toBe(true);

    const base = (container as Slot[]).map((slot) => structuredClone(slot));
    const local = structuredClone(base);
    (local[0] as Extract<Slot, { k: string }>).v[1] = { atom: "7" };
    const current = [
      { k: "foo", v: atoms('"new"', "9") },
      ...structuredClone(base),
    ];
    expect(rebaseKicadSlots(base, local, current)).toEqual(local);
  });

  it("preserves unrelated remote additions while applying local add and remove intent", () => {
    const unchanged = item([{ k: "width", v: atoms("0.2") }]);
    const removed = item([{ k: "size", v: atoms("0.8") }]);
    const localAdded = item([{ k: "layer", v: atoms('"F.Cu"') }]);
    const remoteAdded = item([{ k: "layer", v: atoms('"B.Cu"') }]);
    const remotelyEditedRemoved = item([{ k: "size", v: atoms("1.0") }]);

    const rebased = rebaseKicadItems(
      { unchanged, removed },
      { unchanged, "local-added": localAdded },
      { unchanged, removed: remotelyEditedRemoved, "remote-added": remoteAdded },
    );

    expect(Object.keys(rebased).sort()).toEqual(["local-added", "remote-added", "unchanged"]);
    expect(rebased["local-added"]).toEqual(localAdded);
    expect(rebased["remote-added"]).toEqual(remoteAdded);
  });

  it("does not resurrect a remote deletion when local item presence was unchanged", () => {
    const base = item([{ k: "width", v: atoms("0.2") }]);
    const local = item([{ k: "width", v: atoms("0.3") }]);
    expect(rebaseKicadItems({ x: base }, { x: local }, {})).toEqual({});
  });
});
