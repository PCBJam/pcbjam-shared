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
export {
  DEFAULT_SYNC_MUTATION_QUEUE_LIMITS,
  SyncLayer,
  SyncMutationQueueFullError,
} from "./layer.js";
export type {
  LayerChange,
  SyncLayerDeps,
  SyncMutationQueueFullReason,
  SyncMutationQueueLimits,
} from "./layer.js";
export { idbStore, memStore } from "./store.js";
export type {
  LayerStore,
  LayerStoreCommit,
  LayerStoreSnapshotResult,
} from "./store.js";
export { peekNamespaces } from "./peek.js";
export type { NamespacePeek } from "./peek.js";
export {
  createMuxChannelFactory,
  defaultChannelFactory,
  httpLayer,
  SyncRoomMovedError,
} from "./transport.js";
export type {
  ChannelFactory,
  BodyRequest,
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
