import { Engine } from "./engine";

let booted = false;
addEventListener("message", async (event: MessageEvent) => {
  if (booted || event.data?.type !== "init" || event.ports.length !== 1) return;
  booted = true;
  const port = event.ports[0]!;
  try {
    const engine = await Engine.create(event.data.wasm, event.data.guest);
    let busy = false;
    port.onmessage = async message => {
      const { id, op, data } = message.data ?? {};
      if (!Number.isSafeInteger(id) || typeof op !== "string") return;
      if (busy) { port.postMessage({ id, ok: false, error: "Runtime busy" }); return; }
      busy = true;
      try {
        let result: unknown;
        switch (op) {
          case "load":
          case "patch": {
            if (!(data instanceof ArrayBuffer) || data.byteLength > 32 * 1024 * 1024) throw new Error("Invalid projection payload");
            const text = new TextDecoder().decode(data);
            result = { guestMs: op === "load" ? engine.load(text) : engine.patch(text) };
            break;
          }
          case "run": result = engine.run(data); break;
          case "memory": result = engine.memory(); break;
          case "probe": result = engine.evaluate(data.code, data.deadlineMs); break;
          case "network-probe": {
            // Trusted diagnostic: tests the Worker's response CSP as well as
            // the absence of fetch inside QuickJS. Guest code cannot call this.
            let blocked = false;
            try { await fetch(data); } catch { blocked = true; }
            let nativeEvalBlocked = false;
            try { new Function("return 1")(); } catch { nativeEvalBlocked = true; }
            let nativeImportsBlocked = false;
            try { (self as unknown as { importScripts(url: string): void }).importScripts(data); } catch { nativeImportsBlocked = true; }
            result = { blocked, nativeEvalBlocked, nativeImportsBlocked, origin: self.origin, nativeIndexedDBAvailable: typeof indexedDB !== "undefined" }; break;
          }
          default: throw new Error("Unknown benchmark operation");
        }
        port.postMessage({ id, ok: true, result });
      } catch (error) {
        port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally { busy = false; }
    };
    port.start();
    port.postMessage({ op: "ready" });
  } catch (error) {
    port.postMessage({ op: "fatal", error: String(error) });
  }
});
