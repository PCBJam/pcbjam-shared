export type Mode = "main" | "worker";
export type Scope = "selection" | "board";
export interface Workload { scope: Scope; passes: number }
export interface ItemView {
  id: string;
  type: string;
  parent: string | null;
  reference: string;
  number: string;
  net: string;
  x: number;
  y: number;
  endX: number;
  endY: number;
  layer: string;
  pads: string[];
}
export interface NetView { id: string; name: string }
export interface Catalog { footprints: string[]; tracks: string[]; revision: number }
export interface Snapshot extends Catalog { items: ItemView[]; nets: NetView[] }
export interface Patch { fromRevision: number; revision: number; items: ItemView[] }
export interface BoardAPI {
  catalog(): Catalog;
  item(id: string): ItemView;
  net(id: string): NetView;
}
export interface InspectionReport {
  revision: number;
  footprints: number;
  pads: number;
  tracks: number;
  unassignedPads: number;
  referencedNets: number;
  coordinateChecksum: number;
  digest: string;
  nets: { id: string; name: string; pads: number; tracks: number }[];
}
export interface MemoryStats {
  quickjsUsedBytes: number;
  quickjsAllocatedBytes: number;
  wasmCapacityBytes: number;
}
export interface EngineResult {
  report: InspectionReport;
  executionMs: number;
  bridgeCalls: number;
  bridgeStringCodeUnits: number;
  memory: MemoryStats;
}
export interface Runtime {
  mode: Mode;
  bootMs: number;
  load(snapshot: Snapshot): Promise<{ loadMs: number; guestLoadMs: number; payloadBytes: number }>;
  patch(patch: Patch): Promise<{ updateMs: number; guestUpdateMs: number; payloadBytes: number }>;
  run(workload: Workload): Promise<Omit<EngineResult, "memory">>;
  memory(): Promise<MemoryStats>;
  probe(code: string, deadlineMs?: number): Promise<unknown>;
  networkProbe?(): Promise<{ blocked: boolean; nativeEvalBlocked: boolean; nativeImportsBlocked: boolean; origin: string; nativeIndexedDBAvailable: boolean }>;
  dispose(): Promise<void>;
}
export interface Assets { wasm: ArrayBuffer; guest: string; assetLoadMs: number }
export interface ProbeStats {
  durationMs: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  maxTimerDelayMs: number;
  frames: number;
  longTasks: number | null;
  longTaskMs: number | null;
}
export interface RunSample extends EngineResult {
  wallMs: number;
  responsiveness: ProbeStats;
}
export interface Trial {
  mode: Mode;
  access: "direct" | "snapshot";
  scope: Scope;
  passes: number;
  bootMs: number;
  prepareMs: number;
  loadMs: number;
  guestLoadMs: number;
  payloadBytes: number;
  first: RunSample;
  warm: RunSample[];
  update: {
    hostEditMs: number;
    prepareMs: number;
    updateMs: number;
    guestUpdateMs: number;
    payloadBytes: number;
    run: RunSample;
  };
  disposeMs: number;
  firstUseMs: number;
  firstUseResponsiveness: ProbeStats;
  matching: boolean;
}
