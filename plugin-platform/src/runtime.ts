import { Engine } from "./engine";
import type { Assets, BoardAPI, Runtime } from "./types";

export async function mainRuntime(assets: Assets, api?: BoardAPI): Promise<Runtime> {
  const start = performance.now();
  const engine = await Engine.create(assets.wasm, assets.guest, api);
  return {
    mode: "main", bootMs: performance.now() - start,
    // Used only by the optional same-snapshot control; the primary main-thread
    // POC reads through its host API and never calls these methods.
    load: async snapshot => {
      const start = performance.now();
      const text = JSON.stringify(snapshot);
      const payloadBytes = new TextEncoder().encode(text).byteLength;
      const guestLoadMs = engine.load(text);
      return { loadMs: performance.now() - start, guestLoadMs, payloadBytes };
    },
    patch: async patch => {
      const start = performance.now();
      const text = JSON.stringify(patch);
      const payloadBytes = new TextEncoder().encode(text).byteLength;
      const guestUpdateMs = engine.patch(text);
      return { updateMs: performance.now() - start, guestUpdateMs, payloadBytes };
    },
    run: async workload => engine.run(workload),
    memory: async () => engine.memory(),
    probe: async (code, deadlineMs) => engine.evaluate(code, deadlineMs),
    dispose: async () => engine.dispose(),
  };
}

export async function workerRuntime(assets: Assets, options: { url?: string; signal?: AbortSignal } = {}): Promise<Runtime> {
  options.signal?.throwIfAborted();
  const start = performance.now();
  // A fixed platform-owned HTTP script with its OWN restrictive response CSP.
  // Publisher code is supplied as data and evaluated only inside QuickJS.
  const worker = new Worker(options.url ?? "/worker.js", { name: "pcbjam-plugin-runtime" });
  const channel = new MessageChannel();
  let nextId = 0, closed = false;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const failAll = (message: string) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
  };
  const rpc = (op: string, data?: unknown, transfers: Transferable[] = []): Promise<any> => {
    if (closed) return Promise.reject(new Error("Runtime disposed"));
    if (pending.size >= 4) return Promise.reject(new Error("Too many pending benchmark calls"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Worker operation timed out: " + op));
        abort();
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      channel.port1.postMessage({ id, op, data }, transfers);
    });
  };
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  channel.port1.onmessage = event => {
    const message = event.data;
    if (message?.op === "ready") { readyResolve(); return; }
    if (message?.op === "fatal") { readyReject(new Error(message.error)); failAll(message.error); abort(); return; }
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? "Worker error"));
  };
  worker.onerror = () => {
    const error = new Error("Direct Worker bootstrap/execution failed; check its CSP/COEP response headers");
    readyReject(error); failAll(error.message); abort();
  };
  const abort = () => {
    if (closed) return;
    options.signal?.removeEventListener("abort", abort);
    closed = true;
    worker.terminate(); channel.port1.close(); channel.port2.close();
    readyReject(new Error("Runtime disposed")); failAll("Runtime disposed");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const wasm = assets.wasm.slice(0);
  worker.postMessage({ type: "init", wasm, guest: assets.guest }, [channel.port2, wasm]);
  const bootTimer = setTimeout(() => readyReject(new Error("Direct Worker bootstrap timed out")), 10000);
  try { await ready; }
  catch (error) {
    options.signal?.removeEventListener("abort", abort);
    abort(); throw error;
  }
  finally { clearTimeout(bootTimer); }
  const bootMs = performance.now() - start;
  const sendJSON = async (op: string, value: unknown) => {
    const started = performance.now();
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("Projection exceeds the POC's 32 MiB transfer limit");
    const payloadBytes = bytes.byteLength;
    const result = await rpc(op, bytes.buffer, [bytes.buffer]);
    return { totalMs: performance.now() - started, guestMs: result.guestMs, payloadBytes };
  };
  return {
    mode: "worker", bootMs,
    load: async snapshot => {
      const result = await sendJSON("load", snapshot);
      return { loadMs: result.totalMs, guestLoadMs: result.guestMs, payloadBytes: result.payloadBytes };
    },
    patch: async patch => {
      const result = await sendJSON("patch", patch);
      return { updateMs: result.totalMs, guestUpdateMs: result.guestMs, payloadBytes: result.payloadBytes };
    },
    run: workload => rpc("run", workload),
    memory: () => rpc("memory"),
    probe: (code, deadlineMs) => rpc("probe", { code, deadlineMs }),
    networkProbe: () => rpc("network-probe", location.origin + "/blocked-probe"),
    dispose: async () => {
      if (closed) return;
      closed = true;
      failAll("Runtime disposed");
      // terminate() requests shutdown synchronously; the browser provides no
      // acknowledgement of physical thread reclamation. UI never owns this handle.
      options.signal?.removeEventListener("abort", abort);
      worker.terminate(); channel.port1.close(); channel.port2.close();
    },
  };
}
