export {};
// Injected before publisher UI by the separate UI server.
const parentOrigin = '__PLUGIN_PARENT_ORIGIN__';
const nonce = location.hash.slice(1);
let port: MessagePort | undefined, id = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let readyResolve!: () => void;
const ready = new Promise<void>(resolve => { readyResolve = resolve; });
Object.defineProperty(window, 'pcbjamUI', { value: Object.freeze({
  ready,
  async call(command: string, params: unknown = {}) {
    await ready;
    if (pending.size) throw new Error('Wait for the current plugin action');
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Plugin action timed out. Restart the plugin.')); }, 120000);
      pending.set(requestId, { resolve, reject, timer });
      try { port!.postMessage({ id: requestId, command, params }); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
    });
  },
}) });
addEventListener('message', event => {
  if (port || event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'plugin-connect' || event.data?.nonce !== nonce || event.data?.version !== 1 || event.ports.length !== 1) return;
  port = event.ports[0];
  port.onmessage = event => {
    const entry = pending.get(event.data?.id); if (!entry) return;
    pending.delete(event.data.id); clearTimeout(entry.timer);
    if (event.data.ok) entry.resolve(event.data.result); else entry.reject(new Error(event.data.error ?? 'Plugin failed'));
  };
  port.postMessage({ type: 'connected', version: 1 }); readyResolve();
});
parent.postMessage({ type: 'plugin-ui-ready', version: 1, nonce }, parentOrigin);
