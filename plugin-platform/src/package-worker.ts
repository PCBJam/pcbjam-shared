import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten';
import { sitesFromSegment, NET_LIMITS, NET_METHODS, NET_HEADERS } from '../network-contract.mjs';

// Direct sites (plugins 0022 M3): this Worker's own URL names them and its CSP allows exactly
// those, so the check in __netFetch and the browser's always agree. Any other URL: none.
const sites = sitesFromSegment(/\/net\/([^/]+)\/package-worker\.js$/.exec(self.location.pathname)?.[1]) ?? [];
const TOO_LARGE = new Error('RESPONSE_TOO_LARGE');
async function readBounded(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = reader ? await reader.read() : { done: true as const, value: undefined };
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader!.cancel(); throw TOO_LARGE; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

let booted = false;
addEventListener('message', async (event: MessageEvent) => {
  if (booted || event.data?.type !== 'init' || event.ports.length !== 1) return;
  booted = true;
  const port = event.ports[0]!;
  let vm: QuickJSContext | undefined, runtime: QuickJSRuntime | undefined, closed = false;
  let deadline = Infinity, activeId = 0, lastCommand = 0, lastHost = 0;
  const pendingHost = new Set<number>();
  // Direct requests in flight, and when the last minute's ones started (plugins 0022 M3).
  const pendingNet = new Map<number, AbortController>(); let lastNet = 0; const netTimes: number[] = [];
  // Timers live only inside the command that set them, so logic can wait but never runs in the background.
  const timers = new Map<number, ReturnType<typeof setTimeout>>(); let lastTimer = 0;
  const clearTimers = () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  const fatal = (error: unknown) => {
    if (closed) return; closed = true; clearTimers();
    for (const request of pendingNet.values()) request.abort();
    port.postMessage({ type: 'fatal', error: String(error instanceof Error ? error.message : error).slice(0, 400) });
    // Host always terminates the worker; never dispose a VM inside its callback.
  };
  function checked(result: ReturnType<QuickJSContext['evalCode']>) {
    if (result.error) { const message = vm!.dump(result.error); result.error.dispose(); throw new Error(message?.message ?? 'Plugin execution failed'); }
    result.value.dispose();
  }
  function turn(action: () => void) {
    deadline = performance.now() + 1000;
    try {
      action();
      while (runtime!.hasPendingJob()) {
        const jobs = runtime!.executePendingJobs(50);
        if (jobs.error) { const error = vm!.dump(jobs.error); jobs.error.dispose(); throw new Error(error?.message ?? 'Plugin job failed'); }
        if (performance.now() >= deadline) throw new Error('Plugin CPU budget exceeded');
      }
    } finally { deadline = Infinity; }
  }
  function invoke(name: string, text: string) {
    const fn = vm!.getProp(vm!.global, name), arg = vm!.newString(text);
    try { checked(vm!.callFunction(fn, vm!.undefined, arg)); } finally { fn.dispose(); arg.dispose(); }
  }
  function exact(value: any, keys: string[]) {
    // Guest JSON.stringify can still invoke publisher-controlled toJSON hooks.
    // Validate native JSON, then construct the envelope without guest spreads.
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid guest bridge message');
  }
  try {
    const data = event.data;
    if (!(data.wasm instanceof ArrayBuffer) || data.wasm.byteLength > 4 * 1024 * 1024 || typeof data.main !== 'string' || data.main.length > 1024 * 1024 || typeof data.prelude !== 'string' || data.prelude.length > 2 * 1024 * 1024) throw new Error('Invalid runtime inputs');
    const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmBinary: data.wasm, wasmLocation: 'quickjs.wasm' }));
    runtime = module.newRuntime(); runtime.setMemoryLimit(64 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => closed || performance.now() >= deadline);
    vm = runtime.newContext();
    // Hands a direct request's outcome to the guest, unless the plugin stopped meanwhile.
    const netSettle = (id: number, outcome: { ok: true; result: unknown } | { ok: false; code: string; error: string }) => {
      if (closed || !pendingNet.delete(id)) return;
      try { turn(() => invoke('__netResult', JSON.stringify({ id, ...outcome }))); } catch (error) { fatal(error); }
    };
    const netCall = (text: string) => {
      const message = JSON.parse(text);
      exact(message, ['id', 'url', 'method', 'headers', 'body']);
      if (!activeId || !Number.isSafeInteger(message.id) || message.id <= lastNet) throw new Error('Invalid network call');
      const id = lastNet = message.id, controller = new AbortController();
      pendingNet.set(id, controller);
      // Refusals reach the guest after this call returns, like any result.
      const refuse = (code: string, error: string) => { queueMicrotask(() => netSettle(id, { ok: false, code, error })); };
      let url: URL;
      try { url = new URL(message.url); } catch { return refuse('INVALID_REQUEST', 'Invalid URL'); }
      if (typeof message.url !== 'string' || message.url.length > 2048 || url.username || url.password) return refuse('INVALID_REQUEST', 'Invalid URL');
      if (!sites.includes(url.origin)) return refuse('ORIGIN_NOT_DECLARED', 'The plugin did not declare ' + url.origin);
      if (!NET_METHODS.includes(message.method)) return refuse('INVALID_REQUEST', 'Only GET and POST are supported');
      const headers: Record<string, string> = {};
      if (!message.headers || typeof message.headers !== 'object' || Array.isArray(message.headers)) return refuse('INVALID_REQUEST', 'Headers must be an object');
      for (const [key, value] of Object.entries(message.headers)) {
        const name = key.toLowerCase();
        if (!NET_HEADERS.includes(name as typeof NET_HEADERS[number]) || Object.hasOwn(headers, name) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value))
          return refuse('INVALID_REQUEST', 'Only accept, content-type and authorization headers are allowed');
        headers[name] = value;
      }
      if (message.body !== null && (typeof message.body !== 'string' || message.method === 'GET' || new TextEncoder().encode(message.body).byteLength > NET_LIMITS.requestBytes))
        return refuse('INVALID_REQUEST', 'A body is a string of at most 128 KiB, and only for POST');
      const now = performance.now();
      while (netTimes.length && now - netTimes[0]! > 60000) netTimes.shift();
      if (pendingNet.size > NET_LIMITS.inFlight || netTimes.length >= NET_LIMITS.perMinute) return refuse('RATE_LIMITED', 'Too many network requests');
      netTimes.push(now);
      const timeout = AbortSignal.timeout(NET_LIMITS.timeoutMs);
      void (async () => {
        try {
          // Fixed, whatever the plugin asks: no cookies, no referrer, no cache, no redirects.
          const response = await fetch(url.href, { method: message.method, headers, body: message.body ?? undefined,
            credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', mode: 'cors',
            signal: AbortSignal.any([controller.signal, timeout]) });
          const bytes = await readBounded(response, NET_LIMITS.responseBytes);
          netSettle(id, { ok: true, result: { status: response.status, ok: response.ok, contentType: response.headers.get('content-type'), text: new TextDecoder().decode(bytes) } });
        } catch (error) {
          netSettle(id, timeout.aborted ? { ok: false, code: 'TIMEOUT', error: 'The site did not answer within 30 s' }
            : error === TOO_LARGE ? { ok: false, code: 'RESPONSE_TOO_LARGE', error: 'The response exceeds 1 MiB' }
            : { ok: false, code: 'NETWORK_ERROR', error: 'The request failed (network, CORS or a redirect)' });
        }
      })();
    };
    for (const [name, callback] of Object.entries({
      ...(sites.length ? { __netFetch: netCall } : {}),
      __sendHost(text: string) {
        const message = JSON.parse(text);
        exact(message, ['id', 'method', 'params']);
        if (!activeId || !Number.isSafeInteger(message.id) || message.id <= lastHost || pendingHost.size >= 4 || typeof message.method !== 'string' || !/^[a-z][a-zA-Z0-9.]{0,63}$/.test(message.method)) throw new Error('Invalid host call');
        lastHost = message.id; pendingHost.add(message.id);
        port.postMessage({ type: 'host-call', id: message.id, method: message.method, params: message.params });
      },
      __sendResult(text: string) {
        const message = JSON.parse(text);
        exact(message, message?.ok === true ? ['id', 'ok', 'result'] : ['id', 'ok', 'error']);
        if (!activeId || message.id !== activeId || pendingHost.size || pendingNet.size || typeof message.ok !== 'boolean' || (!message.ok && (typeof message.error !== 'string' || message.error.length > 400))) throw new Error('Invalid plugin result');
        activeId = 0; clearTimers();
        port.postMessage(message.ok ? { type: 'result', id: message.id, ok: true, result: message.result } : { type: 'result', id: message.id, ok: false, error: message.error });
      },
      __setTimer(text: string) {
        const message = JSON.parse(text);
        exact(message, ['id', 'ms']);
        if (!activeId || !Number.isSafeInteger(message.id) || message.id <= lastTimer || timers.size >= 32 || typeof message.ms !== 'number' || !(message.ms >= 0 && message.ms <= 60000)) throw new Error('Invalid timer');
        const id = lastTimer = message.id;
        timers.set(id, setTimeout(() => {
          if (closed || !timers.delete(id)) return;
          try { turn(() => invoke('__timer', JSON.stringify({ id }))); } catch (error) { fatal(error); }
        }, message.ms));
      },
      __clearTimer(text: string) {
        const message = JSON.parse(text);
        exact(message, ['id']);
        const timer = timers.get(message.id);
        if (timer !== undefined) { clearTimeout(timer); timers.delete(message.id); }
      },
    })) {
      const fn = vm.newFunction(name, handle => {
        try {
          if (vm!.typeof(handle) !== 'string') throw new Error('API expects serialized JSON');
          const text = vm!.getString(handle); if (text.length > 12 * 1024 * 1024) throw new Error('Plugin message is too large'); // an 8 MiB page plus JSON escaping; the host bounds each method
          callback(text);
        } catch (error) { fatal(error); }
        return vm!.undefined;
      });
      vm.setProp(vm.global, name, fn); fn.dispose();
    }
    const uuid = vm.newFunction('__uuid', () => vm!.newString(crypto.randomUUID()));
    vm.setProp(vm.global, '__uuid', uuid); uuid.dispose();
    turn(() => { checked(vm!.evalCode(data.prelude, 'pcbjam-sdk.js')); checked(vm!.evalCode(data.main, 'main.js')); });
    if (closed) return;
    port.onmessage = event => {
      if (closed) return;
      try {
        const message = event.data;
        const text = JSON.stringify(message); if (text.length > 5 * 1024 * 1024) throw new Error('Host message too large');
        if (message.type === 'command') {
          if (activeId || !Number.isSafeInteger(message.id) || message.id <= lastCommand) throw new Error('Invalid command sequence');
          lastCommand = activeId = message.id; turn(() => invoke('__dispatch', text));
        } else if (message.type === 'host-result') {
          if (!pendingHost.delete(message.id)) throw new Error('Unknown host response');
          turn(() => invoke('__hostResult', text));
        } else throw new Error('Unknown runtime message');
      } catch (error) { fatal(error); }
    };
    port.start(); port.postMessage({ type: 'ready' });
  } catch (error) { fatal(error); }
});
