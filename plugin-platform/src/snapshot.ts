import type { BoardAPI, Patch, Snapshot } from "./types";

// A purpose-specific read replica, NOT a full Y.Doc and NOT a shared host object.
export function snapshotAPI(snapshot: Snapshot): BoardAPI & { apply(patch: Patch): void } {
  const items = new Map(snapshot.items.map(item => [item.id, item]));
  const nets = new Map(snapshot.nets.map(net => [net.id, net]));
  let revision = snapshot.revision;
  return {
    catalog: () => ({ footprints: snapshot.footprints, tracks: snapshot.tracks, revision }),
    item(id) {
      const item = items.get(id);
      if (!item) throw new Error("Item outside this snapshot: " + id);
      return item;
    },
    net(id) {
      const net = nets.get(id);
      if (!net) throw new Error("Net outside this snapshot: " + id);
      return net;
    },
    apply(patch) {
      if (patch.fromRevision !== revision || patch.revision !== revision + 1) {
        throw new Error("Snapshot revision gap: reload required");
      }
      for (const item of patch.items) {
        if (!items.has(item.id)) throw new Error("Patch cannot introduce an out-of-scope item");
        if (!nets.has(item.net)) throw new Error("Patch requires a net catalog reload");
      }
      for (const item of patch.items) items.set(item.id, item);
      revision = patch.revision;
    },
  };
}
