import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  activeKicadState,
  applyDeltaToY,
  compactYdocUpdate,
  docToY,
  kicadItemsMap,
  kicadMetaMap,
  seedDocToY,
  syncLayoutToY,
  upsertLibSymbolsToY,
  upsertDocToY,
  Y_KDOC_REVERT_AT,
  Y_KDOC_REVERT_NONCE,
  Y_KDOC_REVERT_REASON,
  Y_KDOC_STATE,
  Y_KDOC_STATE_ACTIVE,
  ydocSexprVersion,
  yToDoc,
} from "../src/kicad-y.js";
import { emptyKicadDelta } from "../src/kicad-delta.js";
import { docToFile, fileToDoc, type KicadDoc } from "../src/kicad-doc.js";
import {
  analyzeKicadDocGraph,
  canonicalizeKicadDocGraph,
} from "../src/kicad-graph.js";
import {
  SEXPR_VERSION_CURRENT,
  Y_KDOC_SEXPR_VERSION,
} from "../src/kicad-y2.js";

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [values.slice()];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

function materializedFile(ydoc: Y.Doc): string {
  return docToFile(yToDoc(ydoc));
}

const SEED_FILES = [
  `(kicad_sch
    (version 20250114)
    (paper "A4")
    (lib_symbols (symbol "Device:R" (pin_numbers hide)))
    (wire (pts (xy 0 0) (xy 10 0)) (uuid "wire-a")))`,
  `(kicad_sch
    (version 20250114)
    (paper "A3")
    (lib_symbols (symbol "Device:C" (pin_names hide)))
    (junction (at 20 20) (diameter 0) (uuid "junction-b")))`,
  `(kicad_sch
    (version 20250114)
    (paper "A5")
    (lib_symbols (symbol "Device:L" (exclude_from_sim no)))
    (wire (pts (xy 30 30) (xy 40 30)) (uuid "wire-c")))`,
] as const;

describe("v3 atomic first-seed epoch", () => {
  it("converges to one complete seed across every delivery order, duplicate, and batch", () => {
    const candidates = SEED_FILES.map(fileToDoc);
    const expectedFiles = candidates.map((doc) => docToFile(doc));
    const seedUpdates = candidates.map((doc, index) => {
      const replica = new Y.Doc();
      seedDocToY(doc, replica, `seed-${index}`, `nonce-${index}`);
      return Y.encodeStateAsUpdate(replica);
    });

    let convergedFile: string | undefined;
    for (const order of permutations([0, 1, 2])) {
      // Re-deliver frames both before and after other writers. Yjs update
      // idempotence must not affect which complete active epoch wins.
      const delivery = [order[0]!, order[1]!, order[0]!, order[2]!, order[2]!, order[1]!];
      const receiver = new Y.Doc();
      for (const index of delivery) Y.applyUpdate(receiver, seedUpdates[index]!);

      const actual = materializedFile(receiver);
      expect(expectedFiles).toContain(actual);
      convergedFile ??= actual;
      expect(actual).toBe(convergedFile);

      // Applying the same update set in batches is observationally identical.
      const batched = new Y.Doc();
      Y.applyUpdate(
        batched,
        Y.mergeUpdates(delivery.slice(0, 3).map((index) => seedUpdates[index]!)),
      );
      Y.applyUpdate(
        batched,
        Y.mergeUpdates(delivery.slice(3).map((index) => seedUpdates[index]!)),
      );
      expect(materializedFile(batched)).toBe(convergedFile);
    }
  });
});

const LEGACY_BASE = `(kicad_pcb
  (version 20241229)
  (generator pcbjam)
  (paper "A4")
  (footprint "Device:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (property "Reference" "R1" (at 0 -2) (uuid "field-1"))
    (pad "1" smd (at 0 0) (size 1 1) (uuid "pad-1")))
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1")))`;

const LEGACY_EDITED = `(kicad_pcb
  (version 20241229)
  (generator pcbjam)
  (paper "A3")
  (footprint "Device:R" (layer "B.Cu") (uuid "fp-1") (at 10 10)
    (property "Reference" "R2" (at 0 -2) (uuid "field-1"))
    (pad "1" smd (at 0 0) (size 2 1) (uuid "pad-1")))
  (segment (start 0 0) (end 1 1) (width 0.4) (uuid "seg-1"))
  (via (at 5 5) (size 0.8) (uuid "via-1")))`;

function legacyYdoc(version: 1 | 2, source: KicadDoc): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.getMap("kdoc_meta").set(Y_KDOC_SEXPR_VERSION, version);
  docToY(source, ydoc, `v${version}-seed`);
  return ydoc;
}

function hydrate(update: Uint8Array): Y.Doc {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, update);
  return ydoc;
}

describe.each([1, 2] as const)("v%d to v3 migration", (legacyVersion) => {
  it("preserves the loaded document and accepts a semantic v3 upsert", () => {
    const source = fileToDoc(LEGACY_BASE);
    const edited = fileToDoc(LEGACY_EDITED);
    const legacy = legacyYdoc(legacyVersion, source);

    expect(activeKicadState(legacy)).toBeNull();
    expect(ydocSexprVersion(legacy)).toBe(legacyVersion);
    expect(materializedFile(legacy)).toBe(docToFile(source));

    const migration = compactYdocUpdate(Y.encodeStateAsUpdate(legacy));
    expect(migration).toMatchObject({
      fromVersion: legacyVersion,
      reason: "version-upgrade",
    });

    const migrated = hydrate(migration!.update);
    expect(activeKicadState(migrated)).not.toBeNull();
    expect(ydocSexprVersion(migrated)).toBe(SEXPR_VERSION_CURRENT);
    expect(materializedFile(migrated)).toBe(docToFile(source));

    upsertDocToY(edited, migrated, "post-migration-upsert");
    expect(materializedFile(migrated)).toBe(docToFile(edited));
    expect(ydocSexprVersion(migrated)).toBe(SEXPR_VERSION_CURRENT);

    // A healthy migrated epoch is already canonical: migration is idempotent.
    expect(compactYdocUpdate(Y.encodeStateAsUpdate(migrated))).toBeNull();
  });
});

describe("unsupported schema versions fail closed", () => {
  function withAuthoritativeVersion(version: unknown): Y.Doc {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(LEGACY_BASE), ydoc, "seed");
    kicadMetaMap(ydoc).set(Y_KDOC_SEXPR_VERSION, version);
    return ydoc;
  }

  it("leaves a future-version blob untouched at the migration boundary", () => {
    const ydoc = withAuthoritativeVersion(SEXPR_VERSION_CURRENT + 1);
    const before = Y.encodeStateAsUpdate(ydoc);

    expect(compactYdocUpdate(before)).toBeNull();
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  });

  it("refuses to decode a future-version epoch with current-version semantics", () => {
    const ydoc = withAuthoritativeVersion(SEXPR_VERSION_CURRENT + 1);
    expect(() => yToDoc(ydoc)).toThrow(/unsupported|future|version/i);
  });

  it("refuses to rewrite a future-version epoch", () => {
    const ydoc = withAuthoritativeVersion(SEXPR_VERSION_CURRENT + 1);
    const before = Y.encodeStateAsUpdate(ydoc);

    expect(() => upsertDocToY(fileToDoc(LEGACY_EDITED), ydoc, "must-refuse")).toThrow(
      /unsupported|future|version/i,
    );
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  });

  it.each([0, 2.5, "three"])("does not migrate unknown version %j as legacy v1", (version) => {
    const ydoc = withAuthoritativeVersion(version);
    const before = Y.encodeStateAsUpdate(ydoc);

    expect(compactYdocUpdate(before)).toBeNull();
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  });

  it.each([0, 2.5, "three"])("does not decode unknown version %j", (version) => {
    const ydoc = withAuthoritativeVersion(version);
    expect(() => yToDoc(ydoc)).toThrow(/invalid|unsupported|version/i);
  });

  it.each([0, 2.5, "three"])("does not rewrite unknown version %j", (version) => {
    const ydoc = withAuthoritativeVersion(version);
    const before = Y.encodeStateAsUpdate(ydoc);

    expect(() => upsertDocToY(fileToDoc(LEGACY_EDITED), ydoc, "must-refuse")).toThrow(
      /invalid|unsupported|version/i,
    );
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  });
});

const GRAPH_BASE = `(kicad_pcb
  (version 20241229)
  (segment (start 0 0) (end 1 1) (uuid "item-a"))
  (segment (start 2 2) (end 3 3) (uuid "item-b"))
  (segment (start 4 4) (end 5 5) (uuid "item-c")))`;

describe("merged graph normalization", () => {
  it("terminates, converges, restores every invariant, and is idempotent", () => {
    const base = new Y.Doc();
    docToY(fileToDoc(GRAPH_BASE), base, "seed");
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const baseVector = Y.encodeStateVector(base);

    const branchUpdate = (mutate: (ydoc: Y.Doc) => void): Uint8Array => {
      const branch = hydrate(baseUpdate);
      mutate(branch);
      return Y.encodeStateAsUpdate(branch, baseVector);
    };
    const branches = [
      branchUpdate((ydoc) => kicadItemsMap(ydoc).get("item-a")!.set("parent", "item-b")),
      branchUpdate((ydoc) => kicadItemsMap(ydoc).get("item-b")!.set("parent", "item-a")),
      branchUpdate((ydoc) =>
        kicadItemsMap(ydoc).get("item-c")!.set("parent", "missing-parent"),
      ),
    ];

    let expected: string | undefined;
    for (const order of permutations([0, 1, 2])) {
      const merged = hydrate(baseUpdate);
      for (const index of [...order, order[0]!]) Y.applyUpdate(merged, branches[index]!);

      const normalized = yToDoc(merged);
      expect(analyzeKicadDocGraph(normalized)).toMatchObject({ valid: true, issues: [] });
      expect(canonicalizeKicadDocGraph(normalized)).toBe(normalized);

      const rendered = docToFile(normalized);
      expected ??= rendered;
      expect(rendered).toBe(expected);
    }
  });
});

describe("the active v3 envelope fails closed", () => {
  const source = fileToDoc(LEGACY_BASE);
  const edited = fileToDoc(LEGACY_EDITED);

  function withInvalidActiveVersion(version: 1 | 2): Y.Doc {
    const ydoc = new Y.Doc();
    docToY(source, ydoc, "seed");
    kicadMetaMap(ydoc).set(Y_KDOC_SEXPR_VERSION, version);
    return ydoc;
  }

  const writers: Array<[string, (ydoc: Y.Doc) => unknown]> = [
    ["docToY", (ydoc) => docToY(edited, ydoc, "write")],
    ["upsertDocToY", (ydoc) => upsertDocToY(edited, ydoc, "write")],
    ["seedDocToY", (ydoc) => seedDocToY(edited, ydoc, "write", "other-seed")],
    ["applyDeltaToY", (ydoc) => applyDeltaToY(ydoc, emptyKicadDelta(), "write")],
    ["syncLayoutToY", (ydoc) => syncLayoutToY(edited, ydoc, "write")],
    [
      "upsertLibSymbolsToY",
      (ydoc) => upsertLibSymbolsToY(
        ydoc,
        { "Device:X": `(symbol "Device:X")` },
        "write",
      ),
    ],
  ];

  it("does not confuse a locally observed empty state root with a broken v3 epoch", () => {
    const ydoc = new Y.Doc();
    const observed = ydoc.getMap<unknown>(Y_KDOC_STATE);
    observed.observe(() => {});

    expect(activeKicadState(ydoc)).toBeNull();
    expect(ydocSexprVersion(ydoc)).toBe(1);
    expect(() => docToY(source, ydoc, "first-seed")).not.toThrow();
    expect(activeKicadState(ydoc)).not.toBeNull();
    expect(ydocSexprVersion(ydoc)).toBe(SEXPR_VERSION_CURRENT);
  });

  it.each([1, 2] as const)("every writer refuses an active epoch declaring v%d", (version) => {
    for (const [name, write] of writers) {
      const ydoc = withInvalidActiveVersion(version);
      const before = Y.encodeStateAsUpdate(ydoc);
      expect(() => write(ydoc), name).toThrow(/active epoch declares|invalid.*v3/i);
      expect(Y.encodeStateAsUpdate(ydoc), name).toEqual(before);
    }
  });

  it.each(["deleted", "wrong-type"] as const)(
    "refuses to fall back to legacy roots when active is %s",
    (failure) => {
      const ydoc = new Y.Doc();
      docToY(source, ydoc, "seed");
      const stateRoot = ydoc.getMap<unknown>(Y_KDOC_STATE);
      if (failure === "deleted") stateRoot.delete(Y_KDOC_STATE_ACTIVE);
      else stateRoot.set(Y_KDOC_STATE_ACTIVE, "corrupt");

      expect(() => activeKicadState(ydoc)).toThrow(/active epoch/i);
      expect(() => kicadItemsMap(ydoc)).toThrow(/active epoch/i);
      expect(() => yToDoc(ydoc)).toThrow(/active epoch/i);
      expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc), { ratio: 0 })).toBeNull();
    },
  );
});

describe("compaction is fail-closed and metadata-preserving", () => {
  it("does not compact a document with an unregistered root", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(LEGACY_BASE), ydoc, "seed");
    ydoc.getMap("plugin_future_state").set("must-survive", { nested: [1, 2, 3] });
    const update = Y.encodeStateAsUpdate(ydoc);

    expect(compactYdocUpdate(update, { ratio: 0 })).toBeNull();
  });

  it("returns no replacement for a malformed registered root", () => {
    const ydoc = new Y.Doc();
    docToY(fileToDoc(LEGACY_BASE), ydoc, "seed");
    activeKicadState(ydoc)!.set("layoutBase", "not-an-array");

    expect(() => compactYdocUpdate(
      Y.encodeStateAsUpdate(ydoc),
      { ratio: 0 },
    )).not.toThrow();
    expect(compactYdocUpdate(Y.encodeStateAsUpdate(ydoc), { ratio: 0 })).toBeNull();
  });

  it("preserves durable revert and custom metadata but drops the seed nonce", () => {
    const ydoc = new Y.Doc();
    seedDocToY(fileToDoc(LEGACY_BASE), ydoc, "seed", "ephemeral-seed");
    const meta = kicadMetaMap(ydoc);
    meta.set(Y_KDOC_REVERT_NONCE, "revert-1");
    meta.set(Y_KDOC_REVERT_REASON, "invalid merge");
    meta.set(Y_KDOC_REVERT_AT, "2026-08-22T12:00:00.000Z");
    meta.set("customDurableMetadata", { nested: ["kept", 42] });

    const compacted = compactYdocUpdate(Y.encodeStateAsUpdate(ydoc), { ratio: 0 });
    expect(compacted?.reason).toBe("compaction");
    const out = hydrate(compacted!.update);
    const outMeta = kicadMetaMap(out);
    expect(outMeta.get(Y_KDOC_REVERT_NONCE)).toBe("revert-1");
    expect(outMeta.get(Y_KDOC_REVERT_REASON)).toBe("invalid merge");
    expect(outMeta.get(Y_KDOC_REVERT_AT)).toBe("2026-08-22T12:00:00.000Z");
    expect(outMeta.get("customDurableMetadata")).toEqual({ nested: ["kept", 42] });
    expect(outMeta.get("seedNonce")).toBeUndefined();
  });
});
