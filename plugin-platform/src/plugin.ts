import type { BoardAPI, InspectionReport, Workload } from "./types";

// The exact same plugin is bundled into both QuickJS environments. No DOM,
// Yjs, raw pointers, network, or runtime-specific branches occur in this file.
export function inspectBoard(board: BoardAPI, workload: Workload): InspectionReport {
  const catalog = board.catalog();
  let output!: InspectionReport;
  for (let pass = 0; pass < workload.passes; pass++) {
    const nets = new Map<string, { id: string; name: string; pads: number; tracks: number }>();
    let pads = 0, unassignedPads = 0, checksum = 0;
    let hash = 2166136261;
    const absorb = (text: string) => {
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    };
    const net = (id: string) => {
      let entry = nets.get(id);
      if (!entry) {
        const info = board.net(id);
        entry = { id, name: info.name, pads: 0, tracks: 0 };
        nets.set(id, entry);
        absorb(info.id + ":" + info.name);
      }
      return entry;
    };
    for (const id of catalog.footprints) {
      const footprint = board.item(id);
      absorb(id + footprint.reference + footprint.layer);
      checksum += Math.round(footprint.x * 1000) + Math.round(footprint.y * 1000);
      for (const padId of footprint.pads) {
        const pad = board.item(padId);
        if (pad.parent !== id) throw new Error("Invalid footprint/pad relationship");
        absorb(pad.id + pad.number + pad.net + pad.layer);
        checksum += Math.round(pad.x * 1000) + Math.round(pad.y * 1000);
        pads++;
        if (pad.net === "0" || pad.net === "") unassignedPads++;
        net(pad.net).pads++;
      }
    }
    for (const id of catalog.tracks) {
      const track = board.item(id);
      absorb(id + track.type + track.net + track.layer);
      checksum += Math.round(track.x * 1000) + Math.round(track.y * 1000)
        + Math.round(track.endX * 1000) + Math.round(track.endY * 1000);
      net(track.net).tracks++;
    }
    absorb(String(checksum));
    output = {
      revision: catalog.revision,
      footprints: catalog.footprints.length,
      pads,
      tracks: catalog.tracks.length,
      unassignedPads,
      referencedNets: nets.size,
      coordinateChecksum: checksum,
      digest: hash.toString(16).padStart(8, "0"),
      nets: [...nets.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    };
  }
  return output;
}
