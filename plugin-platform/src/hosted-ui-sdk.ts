/**
 * The UI SDK for a hosted plugin UI (plugins 0025 §5.1): the page comes from the plugin's own
 * origin, so nothing renders the editor's origin into it the way a packaged ui.html gets it.
 * The editor passes its origin in the fragment next to the nonce (`#<nonce>&parent=<origin>`),
 * and the page accepts it only if it is one of the editors the page names. The page should
 * also send `Content-Security-Policy: frame-ancestors <those editors>`, so no other site can
 * frame it, plus the isolation headers in HOSTED_UI_HEADERS.
 *
 * Same calls as the packaged SDK (`pcbjamUI`): one command at a time, answered through the
 * MessagePort the editor hands over.
 */
import { hostedFragment } from '../hosted-ui-contract.mjs';

export interface PcbjamUI {
  ready: Promise<void>;
  call(command: string, params?: unknown): Promise<unknown>;
  /** Events the editor pushes (plugins 0025 §5.3): context.changed, selection.changed, document.changed. */
  on(name: string, listener: (data: unknown) => void): () => void;
  /** The editor that framed this page (one of `editors`): where links to PCBJam pages go. */
  editorOrigin: string;
}

export function connectPcbjamUI({ editors }: { editors: readonly string[] }): PcbjamUI {
  const opened = hostedFragment(location.hash, editors);
  if (!opened) throw new Error('This page runs inside the PCBJam editor');
  const { nonce, parent: parentOrigin } = opened;
  let port: MessagePort | undefined, id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  addEventListener('message', (event) => {
    if (port || event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'plugin-connect' || event.data?.nonce !== nonce || event.data?.version !== 1 || event.ports.length !== 1) return;
    port = event.ports[0]!;
    port.onmessage = (message) => {
      if (message.data?.type === 'event' && typeof message.data.name === 'string') {
        for (const listener of listeners.get(message.data.name) ?? []) {
          try {
            listener(message.data.data);
          } catch {
            // a listener's error stays its own
          }
        }
        return;
      }
      const entry = pending.get(message.data?.id);
      if (!entry) return;
      pending.delete(message.data.id);
      clearTimeout(entry.timer);
      if (message.data.ok) entry.resolve(message.data.result);
      else entry.reject(new Error(message.data.error ?? 'Plugin failed'));
    };
    port.postMessage({ type: 'connected', version: 1 });
    readyResolve();
  });
  parent.postMessage({ type: 'plugin-ui-ready', version: 1, nonce }, parentOrigin);
  return Object.freeze({
    ready,
    editorOrigin: parentOrigin,
    on(name: string, listener: (data: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => void listeners.get(name)?.delete(listener);
    },
    async call(command: string, params: unknown = {}) {
      await ready;
      if (pending.size) throw new Error('Wait for the current plugin action');
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Plugin action timed out. Restart the plugin.')); }, 120000);
        pending.set(requestId, { resolve, reject, timer });
        try { port!.postMessage({ id: requestId, command, params }); }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error as Error); }
      });
    },
  });
}
