import { inspectBoard } from "./plugin";
import { snapshotAPI } from "./snapshot";
import type { BoardAPI, Patch, Snapshot, Workload } from "./types";

declare const __read: ((method: string, argument: string) => string) | undefined;
let replica: ReturnType<typeof snapshotAPI> | undefined;
const bridge: BoardAPI = {
  catalog: () => JSON.parse(__read!("catalog", "")),
  item: id => JSON.parse(__read!("item", id)),
  net: id => JSON.parse(__read!("net", id)),
};
Object.assign(globalThis, {
  __load: (text: string) => { replica = snapshotAPI(JSON.parse(text) as Snapshot); },
  __patch: (text: string) => { if (!replica) throw new Error("No replica"); replica.apply(JSON.parse(text) as Patch); },
  __run: (text: string) => JSON.stringify(inspectBoard(replica ?? bridge, JSON.parse(text) as Workload)),
});
