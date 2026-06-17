/**
 * `@pcbjam/sync-client` — browser client for the generic R2⇄IndexedDB sync bridge
 * (docs/features/r2-idb-sync). A layered, locally-served cache with realtime
 * updates. No KiCad/lib vocabulary: callers map their own ids onto namespaces and
 * their items onto paths.
 *
 * Wire types/codecs come from `@pcbjam/shared` (`sync-wire.ts`).
 */
export { SyncStack } from "./stack.js";
export type { MergedChange, SyncStackOptions } from "./stack.js";
export { SyncLayer } from "./layer.js";
export type { SyncLayerDeps } from "./layer.js";
export { idbStore, memStore } from "./store.js";
export type { LayerStore } from "./store.js";
export {
  defaultChannelFactory,
  httpLayer,
} from "./transport.js";
export type {
  ChannelFactory,
  LayerHttp,
  PutResult,
  RealtimeChannel,
} from "./transport.js";

// Re-export the wire types so consumers need only one import.
export type {
  LayerDescriptor,
  ServerMsg,
  ClientMsg,
  SyncChange,
  SyncEntry,
  SyncManifest,
} from "@pcbjam/shared";
