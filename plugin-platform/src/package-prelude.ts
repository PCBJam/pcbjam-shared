import { parse as parseSexpr, print, diff, serializeSnapshot } from './package-compute';
export {};
declare const __sendHost: (message: string) => void;
declare const __sendResult: (message: string) => void;
declare const __uuid: () => string;
// All these objects/functions live INSIDE QuickJS. Only strings cross native callbacks.
(() => {
    const send = __sendHost, result = __sendResult, uuid = __uuid;
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
    const api = Object.freeze({
        handle(command: string, handler: (params: any) => unknown) {
            if (!/^[a-z][a-zA-Z0-9.:-]{0,63}$/.test(command) || handlers.size >= 32 || handlers.has(command) || typeof handler !== 'function')
                throw new Error('Invalid or duplicate plugin command');
            handlers.set(command, handler);
        },
        context: Object.freeze({ get: () => call('context.get') }),
        project: Object.freeze({ getInfo: () => call('project.getInfo') }),
        documents: Object.freeze({
            list: (options: any = {}) => call('documents.list', { cursor: 0, limit: 50, ...options }),
            getCurrent: () => call('documents.getCurrent'),
            snapshot: (options: unknown) => call('documents.snapshot', options),
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
            choose: (options: unknown) => call('files.choose', options),
            readText: (handle: string) => call('files.readText', { handle }),
            close: (handle: string) => call('files.close', { handle }),
        }),
        editor: Object.freeze({ requestPlacement: (proposal: unknown) => call('editor.requestPlacement', proposal) }),
        randomUUID: () => uuid(),
    });
    Object.defineProperty(globalThis, 'pcbjam', { value: api });
    Object.defineProperty(globalThis, '__dispatch', { value: (text: string) => {
            const message = parse(text);
            Promise.resolve().then(() => {
                const handler = handlers.get(message.command);
                if (!handler)
                    throw new Error('Unknown plugin command');
                return handler(message.params);
            }).then(value => result(stringify({ id: message.id, ok: true, result: value ?? null }))).catch(error => result(stringify({ id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 400) })));
        } });
    Object.defineProperty(globalThis, '__hostResult', { value: (text: string) => {
            const message = parse(text), entry = pending.get(message.id);
            if (!entry)
                return;
            pending.delete(message.id);
            if (message.ok)
                entry.resolve(message.result);
            else
                entry.reject(new Error(message.error));
        } });
    delete (globalThis as any).__sendHost;
    delete (globalThis as any).__sendResult;
    delete (globalThis as any).__uuid;
})();
