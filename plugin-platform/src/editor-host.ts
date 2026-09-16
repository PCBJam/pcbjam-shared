const runtimeAsset = (name: string) => new URL(name, import.meta.url).href;
import { workerRuntime } from "./runtime";
import type { Scope, Snapshot } from "./types";

/** Trusted editor adapter. The UI can request only this bundled inspection. */
export async function mountEditorPlugin(container: HTMLElement, options: {
  snapshot(scope: Scope): Snapshot;
  signal: AbortSignal;
  /** Trusted host configuration (the editor uses the fixed default). */
  uiUrl?: string;
  onDisconnected(): void;
}) {
  const { signal } = options;
  signal.throwIfAborted();
  const asset = async (name: string) => {
    const response = await fetch(runtimeAsset(name), { signal, credentials: "omit" });
    if (!response.ok) throw new Error("Plugin assets unavailable. Run pnpm editor:install in the POC.");
    return response;
  };
  const [wasm, guest] = await Promise.all([
    asset("quickjs.wasm").then(r => r.arrayBuffer()), asset("guest.js").then(r => r.text()),
  ]);
  const runtime = await workerRuntime({ wasm, guest, assetLoadMs: 0 }, { url: runtimeAsset("worker.js"), signal });
  if (signal.aborted) { await runtime.dispose(); signal.throwIfAborted(); }
  const frame = document.createElement("iframe");
  frame.title = "Board Inspector plugin";
  frame.sandbox.add("allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.style.cssText = "border:0;width:100%;height:100%;display:block;color-scheme:dark";
  const nonce = crypto.randomUUID();
  const channel = new MessageChannel();
  let closed = false, connected = false, offered = false, busy = false, loads = 0, lastId = 0;
  let recent: number[] = [];
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", dispose);
    window.removeEventListener("message", handshake);
    channel.port1.close(); channel.port2.close(); frame.remove();
    void runtime.dispose(); rejectReady(new Error("Plugin stopped"));
  };
  const disconnect = () => { dispose(); options.onDisconnected(); };
  function handshake(event: MessageEvent) {
    if (closed || offered || event.source !== frame.contentWindow || event.origin !== "null" || event.data?.type !== "ui-ready" || event.data?.version !== 1 || event.data?.nonce !== nonce) return;
    offered = true;
    frame.contentWindow!.postMessage({ type: "connect", version: 1, nonce }, "*", [channel.port2]);
    window.removeEventListener("message", handshake);
  }
  channel.port1.onmessage = async event => {
    const message = event.data;
    if (closed) return;
    if (!connected && message?.type === "connected" && message.version === 1) {
      connected = true; clearTimeout(timer); resolveReady(); return;
    }
    if (!connected || !message || typeof message !== "object" || Object.keys(message).length !== 3 || !Number.isSafeInteger(message.id) || message.id <= lastId || typeof message.method !== "string" || message.method.length > 80) { disconnect(); return; }
    lastId = message.id;
    const now = performance.now();
    recent = recent.filter(time => now - time < 10000); recent.push(now);
    if (recent.length > 20) { disconnect(); return; }
    const reply = (value: object) => { if (!closed) channel.port1.postMessage({ id: message.id, ...value }); };
    if (message.method !== "inspect") { reply({ ok: false, error: "This plugin cannot call that method." }); return; }
    const params = message.params;
    if (!params || typeof params !== "object" || Object.keys(params).length !== 1 || (params.scope !== "selection" && params.scope !== "board")) { reply({ ok: false, error: "Choose selection or board." }); return; }
    if (busy) { reply({ ok: false, error: "An inspection is already running." }); return; }
    busy = true;
    try {
      // Read the CURRENT document/selection at request time, under host control.
      // No UI-chosen project IDs, raw documents, credentials or write handles.
      const snapshot = options.snapshot(params.scope);
      await runtime.load(snapshot);
      const result = await runtime.run({ scope: params.scope, passes: 1 });
      const { footprints, pads, tracks, referencedNets, digest } = result.report;
      reply({ ok: true, result: { footprints, pads, tracks, referencedNets, digest } });
    } catch {
      reply({ ok: false, error: "Inspection failed. Try a smaller selection or restart the plugin." });
    } finally { busy = false; }
  };
  frame.addEventListener("load", () => { if (++loads > 1) disconnect(); });
  signal.addEventListener("abort", dispose, { once: true });
  try {
    // Fixed platform-owned UI endpoint, served from a separate loopback origin.
    // It authorizes only localhost:3048 as its parent via response CSP.
    frame.src = (options.uiUrl ?? "http://127.0.0.1:4318/editor-ui") + "#" + nonce;
    window.addEventListener("message", handshake);
    container.append(frame);
    timer = setTimeout(() => rejectReady(new Error("Plugin UI unavailable. Start the plugin POC server on port 4318.")), 10000);
    await ready;
    return { dispose };
  } catch (error) { dispose(); throw error; }
}
