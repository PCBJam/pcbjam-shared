import { parse as parseSexpr, print, diff, serializeSnapshot } from './package-compute';
export {};
declare const __sendHost: (message: string) => void;
declare const __sendResult: (message: string) => void;
declare const __uuid: () => string;
declare const __setTimer: (message: string) => void;
declare const __clearTimer: (message: string) => void;
// All these objects/functions live INSIDE QuickJS. Only strings cross native callbacks.
(() => {
    const send = __sendHost, result = __sendResult, uuid = __uuid, setTimer = __setTimer, clearTimer = __clearTimer;
    const parse = JSON.parse.bind(JSON), stringify = JSON.stringify.bind(JSON);
    const pending = new Map<number, {
        resolve(value: unknown): void;
        reject(error: Error): void;
    }>();
    const handlers = new Map<string, (params: any) => unknown>();
    let nextId = 0;
    const call = (method: string, params: unknown = {}) => new Promise((resolve, reject) => {
        if (pending.size >= 4) {
            reject(new Error('Too many pending API calls'));
            return;
        }
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try {
            send(stringify({ id, method, params }));
        }
        catch (error) {
            pending.delete(id);
            reject(error);
        }
    });
    /** Drain one whole-document session: newline-delimited JSON records, a batch per slice. */
    const readRecords = async (session: string, onBatch: (records: any[]) => unknown) => {
        let rest = '';
        for (;;) {
            const part: any = await call('documents.exportRead', { export: session });
            const lines = (rest + part.text).split('\n');
            rest = lines.pop()!;
            const batch: any[] = [];
            for (const line of lines) if (line) batch.push(parse(line));
            if (batch.length) await onBatch(batch);
            if (part.done) break;
        }
        if (rest) throw new Error('Export ended inside a record');
    };
    const api = Object.freeze({
        handle(command: string, handler: (params: any) => unknown) {
            if (!/^[a-z][a-zA-Z0-9.:-]{0,63}$/.test(command) || handlers.size >= 32 || handlers.has(command) || typeof handler !== 'function')
                throw new Error('Invalid or duplicate plugin command');
            handlers.set(command, handler);
        },
        http: Object.freeze({request:(endpointId:string,options:object)=>call('http.request',{...options,endpointId})}),
        exports: Object.freeze({
            run: (kind: unknown) => call('exports.run', { kind }),
            readJson: (exportId: unknown, name: unknown) => call('exports.readJson', { exportId, name }),
            bundle: (proposal: unknown) => call('exports.bundle', proposal),
        }),
        context: Object.freeze({ get: () => call('context.get') }),
        project: Object.freeze({ getInfo: () => call('project.getInfo') }),
        documents: Object.freeze({
            list: (options: any = {}) => call('documents.list', { cursor: 0, limit: 50, ...options }),
            getCurrent: () => call('documents.getCurrent'),
            snapshot: (options: unknown) => call('documents.snapshot', options),
            // Whole document, fetched in UI-thread-friendly slices. With onItems the caller sees each
            // batch once and nothing is retained, which is what keeps large boards inside the heap.
            export: async (options: any = {}, onItems?: (items: unknown[]) => unknown) => {
                if (onItems !== undefined && typeof onItems !== 'function')
                    throw new Error('onItems must be a function');
                const { document, revision, types = [], omit = [], layout = false, libSymbols = false, ...extra } = options ?? {};
                const started: any = await call('documents.exportStart', { document, revision, types, omit, layout, libSymbols, ...extra });
                const result: any = { revision: started.revision, root: '', items: [], count: 0, layout: null, libSymbols: [] };
                await readRecords(started.export, async batch => {
                    const items: unknown[] = [];
                    for (const record of batch) {
                        if (record.$ === 'root') result.root = record.value;
                        else if (record.$ === 'layout') result.layout = record.value;
                        else if (record.$ === 'libSymbol') result.libSymbols.push(record.text);
                        else items.push(record);
                    }
                    result.count += items.length;
                    if (onItems) { if (items.length) await onItems(items); }
                    else for (const item of items) result.items.push(item);
                });
                return result;
            },
            poll: (options: unknown) => call('documents.poll', options),
            getSexpr: async (options: unknown) => { const snapshot: any = await call('documents.snapshot', options); return { revision: snapshot.revision, text: serializeSnapshot(snapshot) }; },
        }),
        items: Object.freeze({
            list: (options: any) => call('items.list', { cursor: 0, limit: 50, types: [], ...options }),
            get: (options: unknown) => call('items.get', options),
        }),
        selection: Object.freeze({ get: () => call('selection.get') }),
        storage: Object.freeze({
            get: (key: string) => call('storage.get', { key }),
            set: (options: unknown) => call('storage.set', options),
            delete: (options: unknown) => call('storage.delete', options),
            list: () => call('storage.list'),
        }),
        sexpr: Object.freeze({ parse: parseSexpr, print, diff }),
        files: Object.freeze({
            save: (proposal: unknown) => call('files.save', proposal),
            saveHtml: (proposal: unknown) => call('files.saveHtml', proposal),
            saveImage: (proposal: unknown) => call('files.saveImage', proposal),
            saveBundle: (proposal: unknown) => call('files.saveBundle', proposal),
            choose: (options: unknown) => call('files.choose', options),
            readText: (handle: string) => call('files.readText', { handle }),
            close: (handle: string) => call('files.close', { handle }),
        }),
        board: Object.freeze({
            // The open PCB as shapes the engine computed. Records arrive as they are produced; with
            // onRecords nothing is retained.
            geometry: async (options: any = {}, onRecords?: (records: unknown[]) => unknown) => {
                if (onRecords !== undefined && typeof onRecords !== 'function')
                    throw new Error('onRecords must be a function');
                const { document, revision, include = [], ...extra } = options ?? {};
                const started: any = await call('board.geometryStart', { document, revision, include, ...extra });
                const result: any = { revision: started.revision, board: null, footprints: [], drawings: [], tracks: [], zones: [], count: 0 };
                await readRecords(started.export, async batch => {
                    result.count += batch.length;
                    if (onRecords) { await onRecords(batch); return; }
                    for (const record of batch) {
                        if (record.$ === 'board') result.board = record;
                        else if (record.$ === 'footprint') result.footprints.push(record);
                        else if (record.$ === 'drawing') result.drawings.push(record.item);
                        else if (record.$ === 'tracks') for (const item of record.items) result.tracks.push(item);
                        else if (record.$ === 'zone') result.zones.push(record);
                    }
                });
                return result;
            },
        }),
        editor: Object.freeze({ requestPlacement: (proposal: unknown) => call('editor.requestPlacement', proposal), select: (options: unknown) => call('editor.select', options) }),
        randomUUID: () => uuid(),
    });
    // setTimeout/clearTimeout exist so logic can pause between steps. They work only while a
    // command is being handled and are cancelled when it settles: nothing runs in the background.
    const timeouts = new Map<number, { callback: (...args: unknown[]) => unknown; args: unknown[] }>();
    let nextTimer = 0, handling = false;
    Object.defineProperty(globalThis, 'setTimeout', { value: (callback: unknown, ms?: unknown, ...args: unknown[]) => {
            if (typeof callback !== 'function')
                throw new TypeError('setTimeout needs a function');
            if (!handling)
                throw new Error('Timers are only available while handling a command');
            if (timeouts.size >= 32)
                throw new Error('Too many timers');
            const id = ++nextTimer, delay = Number(ms);
            timeouts.set(id, { callback: callback as (...args: unknown[]) => unknown, args });
            setTimer(stringify({ id, ms: delay >= 0 ? Math.min(delay, 60000) : 0 }));
            return id;
        } });
    Object.defineProperty(globalThis, 'clearTimeout', { value: (id: unknown) => {
            if (typeof id === 'number' && timeouts.delete(id))
                clearTimer(stringify({ id }));
        } });
    Object.defineProperty(globalThis, '__timer', { value: (text: string) => {
            const id = parse(text).id, entry = timeouts.get(id);
            if (!entry)
                return;
            timeouts.delete(id);
            entry.callback(...entry.args);
        } });
    Object.defineProperty(globalThis, 'pcbjam', { value: api });
    Object.defineProperty(globalThis, '__dispatch', { value: (text: string) => {
            const message = parse(text);
            handling = true;
            const settle = (reply: string) => { handling = false; timeouts.clear(); result(reply); };
            Promise.resolve().then(() => {
                const handler = handlers.get(message.command);
                if (!handler)
                    throw new Error('Unknown plugin command');
                return handler(message.params);
            }).then(value => settle(stringify({ id: message.id, ok: true, result: value ?? null }))).catch(error => settle(stringify({ id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 400) })));
        } });
    Object.defineProperty(globalThis, '__hostResult', { value: (text: string) => {
            const message = parse(text), entry = pending.get(message.id);
            if (!entry)
                return;
            pending.delete(message.id);
            if (message.ok)
                entry.resolve(message.result);
            else
                entry.reject(Object.assign(new Error(message.error),typeof message.code==='string'&&/^[A-Z_]{1,40}$/.test(message.code)?{code:message.code}:{}));
        } });
    delete (globalThis as any).__sendHost;
    delete (globalThis as any).__sendResult;
    delete (globalThis as any).__uuid;
    delete (globalThis as any).__setTimer;
    delete (globalThis as any).__clearTimer;
})();
