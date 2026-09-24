import {backendPermissions, validateBackendRequest, validateUploadRequest, BACKEND_LIMITS, type BackendEndpoint} from '../backend-contract.mjs';
const runtimeAsset = (name: string) => new URL(name, import.meta.url).href;
import { METHODS, LIMITS, LEASED_READS, SAVED_HTML_PREFIX, EXPORT_KINDS, EXPORT_LIMITS, externalUrlAllowed, pngBytes, boundedJSON, type Method, type DocumentAdapter } from './package-api';
import { storageCall } from './package-storage';
import { platformConfiguration, platformRequest, platformBytes, verifyText, runtimeAssets } from './package-service';
export { configurePlatform } from './package-service';
export { cleanupPluginStorage } from './package-storage';
export interface PluginDescriptor {
    pluginId?: string;
    generation?: number;
    storageEpoch?: number;
    policyDigest?: string;
    grants?: string[];
    installed?: boolean;
    enabled?: boolean;
    fileMetadata?: Record<string, {sha256:string;bytes:number}>;
    backends?: Array<BackendEndpoint & {endpoint:string;registrationId?:string;policyDigest:string;status:string;ready:boolean;audience?:string;issuer?:string}>;
    digest: string;
    manifest: {
        id: string;
        name: string;
        version: string;
        description: string;
        surfaces: string[];
        permissions: string[];
        endpoints?: Record<string,BackendEndpoint>;
        uiSize?: {width: number; height: number};
    };
}
export interface EditorContext {
    tool: string;
    fileName: string;
    readOnly: boolean;
    canPlaceItems: boolean;
    /** Read on every call: the engine module can finish loading after the plugin mounts. */
    canSelectItems?: boolean;
    canReadGeometry?: boolean;
}
export interface PackageHostOptions {
    plugin: PluginDescriptor;
    signal: AbortSignal;
    context(): EditorContext;
    chooseFile(extensions: string[], signal: AbortSignal): Promise<File | null>;
    requestPlacement(proposal: {
        label: string;
        sexpr: string;
    }, signal: AbortSignal): Promise<{
        status: string;
    }>;
    onDisconnected(message: string): void;
    documents?: DocumentAdapter;
    /** Stable trusted account/project binding, never supplied by a plugin. */
    storageBinding?(): string | null;
    authorize?(signal: AbortSignal): Promise<void>;
    /** Replace the editor selection. Must never take an item another collaborator holds, and must
     *  return only ids it was given. Absent where the engine cannot do this. */
    selectItems?(ids: string[], signal: AbortSignal): Promise<{ selected: string[]; held: string[]; missing: string[] }>;
    /** Draw the confirmation, authorize `method`, then download `bytes` as a file; never open or render them. */
    saveFile?(proposal: {
        name: string;
        /** Present for kind 'text' only. */
        text?: string;
        kind: 'text' | 'html' | 'image' | 'archive';
        bytes: Uint8Array;
        method: string;
    }, signal: AbortSignal): Promise<{
        status: 'download-requested' | 'cancelled';
    }>;
    /** Draw the confirmation, then open `url` in a new tab (noopener). Never navigate the editor. */
    openExternal?(proposal: { url: string; site: string }, signal: AbortSignal): Promise<{ status: 'opened' | 'cancelled' }>;
    /** Test-only trusted configuration; publisher manifests cannot set origins. */
    uiOrigin?: string;
    /** Trusted confirmation UI must call this immediately before native effects. */
    onAuthorizationReady?(check:(method:string)=>Promise<void>):void;
}
async function api(path: string, method = 'GET', data?: unknown) {
    const response = await fetch('/plugin-dev/' + path, {
        method, credentials: 'omit', headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json', 'X-PCBJam-Plugin-Dev': '1' },
        body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok)
        throw new Error(result.error ?? 'Plugin operation failed');
    return result;
}
export const listPlugins = (): Promise<{
    plugins: PluginDescriptor[];
    permissions: Record<string, string>;
}> => platformConfiguration() ? platformRequest('installations') : api('plugins');
export const installPlugin = (plugin: PluginDescriptor | string): Promise<PluginDescriptor> => {
    if(!platformConfiguration())return api('install','POST',{digest:typeof plugin==='string'?plugin:plugin.digest});
    if(typeof plugin==='string'||!plugin.pluginId||!plugin.policyDigest)throw new Error('Review plugin permissions before installing');
    return platformRequest('installations/'+plugin.pluginId,'PUT',{digest:plugin.digest,policyDigest:plugin.policyDigest,
        grants:plugin.manifest.permissions,expectedGeneration:plugin.generation??0,enabled:true});
};
export const removePlugin = (id: string): Promise<void> => platformConfiguration() ? platformRequest('installations/'+id,'DELETE') : api('plugins', 'DELETE', { id });
export const setPluginEnabled = (plugin:PluginDescriptor,enabled:boolean) => platformRequest('installations/'+plugin.pluginId,'PUT',{
    digest:plugin.digest,policyDigest:plugin.policyDigest,grants:plugin.grants,expectedGeneration:plugin.generation,enabled,
});
export const resetPluginData = (id:string) => platformRequest('installations/'+id+'/reset-data','POST');
export async function preparePlugin(files: File[], zip: boolean): Promise<PluginDescriptor> {
    if (!files.length || files.length > 32 || files.reduce((n, f) => n + f.size, 0) > 12 * 1024 * 1024)
        throw new Error('Choose a plugin package with at most 32 files and 12 MiB');
    if (zip) {
        if (files.length !== 1 || files[0]!.size > 8 * 1024 * 1024)
            throw new Error('Choose one ZIP smaller than 8 MiB');
        const bytes = new Uint8Array(await files[0]!.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const input={ kind: 'zip', base64: btoa(binary) };
        return platformConfiguration()?platformRequest('releases/prepare','POST',input):api('prepare','POST',input);
    }
    const input={ kind: 'folder', files: await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath || file.name, text: await file.text() }))) };
    return platformConfiguration()?platformRequest('releases/prepare','POST',input):api('prepare','POST',input);
}
function exact(value: any, fields: string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
        throw new Error('Invalid API arguments');
}
export async function mountPackagePlugin(container: HTMLElement, options: PackageHostOptions) {
    const controller = new AbortController(), signal = controller.signal;
    const files = new Map<string, File>(), channel = new MessageChannel(), uiChannel = new MessageChannel();
    let worker: Worker | undefined, frame: HTMLIFrameElement | undefined, closed = false, connected = false;
    let offered = false, loads = 0, lastUi = 0, lastHost = 0, activeId = 0;
    let commandTimer: ReturnType<typeof setTimeout> | undefined;
    let uiReadyTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const nonce = crypto.randomUUID(), documentHandle = crypto.randomUUID();
    const binding = options.storageBinding?.() ?? null;
    let activation: {id:string;grants:string[];userId:string;pluginId:string;storageEpoch:number;uiOrigin:string;placementEnabled:boolean} | undefined;
    let grants=options.plugin.manifest.permissions;
    // Keyed by permission: a lease only ever vouches for the grant the server actually checked.
    const leases=new Map<string,number>();
    const authorize=async(method='context.get',fresh=false)=>{
        check();await options.authorize?.(signal);check();
        if(platformConfiguration()) {
            if(!activation)throw new Error('Plugin activation is missing');
            const permission=(Object.hasOwn(METHODS,method)?METHODS[method as Method].permission:null)??'';
            if(!fresh&&LEASED_READS.has(method)&&performance.now()-(leases.get(permission)??-Infinity)<LIMITS.readLeaseMs)return;
            // A throttled check is not a denial: wait out the server's one-minute window
            // instead of ending the plugin. Nothing is delivered while unauthorized.
            for(let attempt=0;;attempt++) {
                try {await platformRequest('activations/'+activation.id+'/check','POST',{method},signal);break;}
                catch(error){
                    // One wait fits inside the command timeout; after that the guest sees RATE_LIMITED.
                    if((error as {code?:string}).code==='RATE_LIMITED'&&!attempt){await sleep(60000-Date.now()%60000+500);check();continue;}
                    if((error as {code?:string}).code==='RATE_LIMITED')throw error;
                    fail('Plugin access ended. Reopen the plugin to continue.');throw error;
                }
            }
            leases.set(permission,performance.now());
            check();
        }
    };
    const check = () => {
        signal.throwIfAborted();
        if ((options.storageBinding?.() ?? null) !== binding)
            throw new Error('Plugin account or project changed');
        if (!options.plugin.manifest.surfaces.includes('editor:' + options.context().tool))
            throw new Error('Plugin is unavailable in this editor');
    };
    const SAVES = new Set(['files.save', 'files.saveHtml', 'files.saveImage']);
    const available = (method: string) => {
        if(method==='http.request')return !!activation && Object.entries(options.plugin.manifest.endpoints??{}).some(([name,p])=>Object.keys(backendPermissions({[name]:p})).every(grant=>grants.includes(grant)));
        if(method==='http.upload')return !!activation && Object.entries(options.plugin.manifest.endpoints??{}).some(([name,p])=>!!(p as BackendEndpoint).upload && Object.keys(backendPermissions({[name]:p})).every(grant=>grants.includes(grant)));
        if(method==='ui.openExternal')return !!activation && !!options.openExternal && Object.keys(options.plugin.manifest.endpoints??{}).length>0;
        if (SAVES.has(method))
            return !!options.saveFile;
        // Server-side exports exist only on the hosted platform, for the editors their kinds support.
        if (method.startsWith('exports.'))
            return !!activation && Object.values(EXPORT_KINDS).some(kind => kind.surface === 'editor:' + options.context().tool);
        if (method === 'files.saveBundle')
            return !!activation && !!options.saveFile;
        if (method === 'board.geometryStart')
            // The editor sets the flag for the PCB editor with a capable engine; the engine itself refuses anything else.
            return !!options.documents?.openGeometry && options.context().canReadGeometry === true;
        if (method === 'editor.select')
            return !!options.selectItems && !!options.documents && options.context().canSelectItems === true;
        if (method === 'context.get' || method.startsWith('files.'))
            return true;
        if (method === 'editor.requestPlacement')
            return !options.context().readOnly && options.context().canPlaceItems && (!platformConfiguration()||activation?.placementEnabled===true);
        if (method.startsWith('storage.'))
            return binding !== null;
        return !!options.documents;
    };
    const getDocument = (params: any, requireRevision = true) => {
        if (params.document !== documentHandle)
            throw new Error('Invalid or expired document handle');
        const revision = options.documents!.revision();
        if (requireRevision && params.revision !== revision)
            throw new Error('Document changed: get its current revision and retry');
        return revision;
    };
    let uiTimes: number[] = [], hostTimes: number[] = [], pendingHost = 0;
    let exportSession: { id: string; revision: number; cursor: { read(budgetMs: number, maxChars: number): { text: string; done: boolean } | Promise<{ text: string; done: boolean }> }; chars: number; lastEnd: number; lastCost: number } | undefined;
    const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); if (signal.aborted) reject(new Error('Plugin stopped')); else resolve(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
    // An error here would mostly be retried in a tight loop. Delay calls over the
    // window in arrival order instead, so a plain read loop needs no pacing of its own.
    let paceQueue: Promise<void> = Promise.resolve();
    const pace = () => paceQueue = paceQueue.then(async () => {
        for (;;) {
            const now = performance.now();
            hostTimes = hostTimes.filter(t => now - t < LIMITS.hostCallWindowMs);
            if (hostTimes.length < LIMITS.hostCallsPerWindow) { hostTimes.push(now); return; }
            await sleep(hostTimes[0]! + LIMITS.hostCallWindowMs - now);
        }
    });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => { });
    const dispose = () => {
        if (closed)
            return;
        closed = true;
        controller.abort();
        options.signal.removeEventListener('abort', dispose);
        clearTimeout(commandTimer);
        clearTimeout(uiReadyTimer);
        clearInterval(poll);
        if(activation)void platformRequest('activations/'+activation.id,'DELETE').catch(()=>{});
        window.removeEventListener('message', handshake);
        files.clear();
        exportSession = undefined;
        worker?.terminate();
        frame?.remove();
        channel.port1.close();
        channel.port2.close();
        uiChannel.port1.close();
        uiChannel.port2.close();
        readyReject(new Error('Plugin stopped'));
    };
    const fail = (message: string) => { dispose(); options.onDisconnected(message); };
    function handshake(event: MessageEvent) {
        if (closed || offered || event.source !== frame?.contentWindow || event.origin !== 'null' || event.data?.type !== 'plugin-ui-ready' || event.data?.nonce !== nonce || event.data?.version !== 1)
            return;
        offered = true;
        frame!.contentWindow!.postMessage({ type: 'plugin-connect', version: 1, nonce }, '*', [uiChannel.port2]);
        window.removeEventListener('message', handshake);
    }
    const requirePermission = (permission: string) => { if (!grants.includes(permission))
        throw new Error('Permission denied: ' + permission); };
    async function callHost(method: string, params: any) {
        check();
        const spec = Object.hasOwn(METHODS, method) ? METHODS[method as Method] : null;
        if (!spec)
            throw new Error('Unknown PCBJam API method');
        if (spec.permission)
            requirePermission(spec.permission);
        if (!available(method))
            throw new Error('API unavailable in this context');
        if (!spec.input.safeParse(params).success)
            throw new Error('Invalid API arguments');
        await authorize(method);
        check();
        const context = options.context();
        switch (method) {
            case 'http.request': {
                const endpoint=options.plugin.manifest.endpoints?.[params.endpointId];
                if(!endpoint)throw new Error('Undeclared backend');
                validateBackendRequest(params,endpoint);
                for(const permission of Object.keys(backendPermissions({[params.endpointId]:endpoint})))requirePermission(permission);
                return platformRequest('activations/'+activation!.id+'/http','POST',params,signal,BACKEND_LIMITS.hostDeadlineMs);
            }
            case 'http.upload': {
                const endpoint=options.plugin.manifest.endpoints?.[params.endpointId];
                if(!endpoint)throw new Error('Undeclared backend');
                validateUploadRequest(params,endpoint);
                for(const permission of Object.keys(backendPermissions({[params.endpointId]:endpoint})))requirePermission(permission);
                // The server sends the stored bundle; only its id crosses the sandbox.
                return platformRequest('activations/'+activation!.id+'/upload','POST',params,signal,60000);
            }
            case 'ui.openExternal': {
                const origins=Object.values(options.plugin.manifest.endpoints??{}).map(e=>(e as BackendEndpoint).origin);
                if(!externalUrlAllowed(params.url,origins))throw new Error('This link is not on one of the plugin\'s approved sites');
                const result=await options.openExternal!({url:params.url,site:new URL(params.url).hostname},signal);
                check();
                if(result.status!=='opened'&&result.status!=='cancelled')throw new Error('Invalid open result');
                return {status:result.status};
            }
            case 'context.get': return { tool: context.tool, fileName: context.fileName, readOnly: context.readOnly, canPlaceItems: available('editor.requestPlacement') && grants.includes('editor:place-items'),
                methods: Object.keys(METHODS).filter(name => available(name) && (!METHODS[name as Method].permission || grants.includes(METHODS[name as Method].permission!))), limits: LIMITS };
            case 'project.getInfo': {
                const info = options.documents!.projectInfo();
                return { id: info.id, scope: info.scope, name: info.name, readOnly: context.readOnly };
            }
            case 'documents.list': {
                const files = options.documents!.catalog();
                if (files.length > 5000)
                    throw new Error('Project catalog exceeds limits');
                if (params.cursor > files.length)
                    throw new Error('Invalid catalog cursor');
                return { files: files.slice(params.cursor, params.cursor + params.limit).map(file => ({ name: file.name, kind: file.kind, current: file.current })), nextCursor: params.cursor + params.limit < files.length ? params.cursor + params.limit : null };
            }
            case 'documents.getCurrent': return { document: documentHandle, name: context.fileName, revision: options.documents!.revision(), readOnly: context.readOnly };
            case 'documents.poll': {
                const revision = getDocument(params, false);
                if (params.since > revision)
                    throw new Error('Invalid document revision');
                return { revision, changed: revision !== params.since };
            }
            case 'documents.snapshot': {
                const revision = getDocument(params);
                const value = options.documents!.snapshot();
                return boundedJSON({ revision, root: value.root, items: value.items, layout: value.layout, libSymbols: value.libSymbols }, LIMITS.snapshotBytes);
            }
            case 'documents.exportStart': {
                const revision = getDocument(params);
                // One export per instance: starting another abandons the previous walk.
                exportSession = { id: crypto.randomUUID(), revision, cursor: options.documents!.openExport({ types: params.types, omit: params.omit, layout: params.layout, libSymbols: params.libSymbols }), chars: 0, lastEnd: 0, lastCost: 0 };
                return { export: exportSession.id, revision };
            }
            case 'board.geometryStart': {
                const revision = getDocument(params);
                // Shares the export session: one whole-document read per instance, same slicing, rest and size cap.
                exportSession = { id: crypto.randomUUID(), revision, cursor: options.documents!.openGeometry!({ tracks: params.include.includes('tracks'), zones: params.include.includes('zones') }), chars: 0, lastEnd: 0, lastCost: 0 };
                return { export: exportSession.id, revision };
            }
            case 'documents.exportRead': {
                const session = exportSession;
                if (!session || session.id !== params.export)
                    throw new Error('Invalid or finished export');
                // Rest at least as long as the last slice ran, so export never takes over half of the UI thread.
                const rest = session.lastCost - (performance.now() - session.lastEnd);
                if (rest > 0) { await sleep(rest); check(); }
                if (exportSession !== session)
                    throw new Error('Invalid or finished export');
                const started = performance.now();
                let part: { text: string; done: boolean };
                try { part = await session.cursor.read(LIMITS.exportSliceMs, LIMITS.exportSliceChars); }
                catch (error) { if (exportSession === session) exportSession = undefined; throw error; }
                check();
                if (exportSession !== session)
                    throw new Error('Invalid or finished export');
                session.lastEnd = performance.now(); session.lastCost = session.lastEnd - started;
                session.chars += part.text.length;
                if (session.chars > LIMITS.exportTotalChars) { exportSession = undefined; throw new Error('Export exceeds size limit'); }
                if (part.done) exportSession = undefined;
                return { revision: session.revision, text: part.text, done: part.done };
            }
            case 'items.list': {
                const revision = getDocument(params);
                const value = options.documents!.items(params.cursor, params.limit, params.types);
                return { revision, items: value.items.map(item => ({ id: item.id, type: item.type, parent: item.parent })), nextCursor: value.nextCursor };
            }
            case 'items.get': {
                const revision = getDocument(params);
                return { revision, items: options.documents!.getItems(params.ids, params.partial === true) };
            }
            case 'selection.get': {
                const selection = options.documents!.selection();
                if (selection.ids.length > 1000)
                    throw new Error('Selection exceeds limits');
                return { document: documentHandle, revision: options.documents!.revision(), selectionRevision: selection.revision, ids: selection.ids };
            }
            case 'editor.select': {
                getDocument(params, false);
                const result = await options.selectItems!(params.ids, signal);
                check();
                // The adapter is trusted code, but what a plugin receives is still limited to what it asked about.
                const asked = new Set<string>(params.ids);
                const only = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && asked.has(entry)) : [];
                return { selected: only(result?.selected), held: only(result?.held), missing: only(result?.missing) };
            }
            case 'storage.get':
            case 'storage.set':
            case 'storage.delete':
            case 'storage.list':
                return storageCall(activation ? JSON.stringify(['hosted',platformConfiguration()!.apiBase,activation.userId,activation.pluginId,activation.storageEpoch,options.documents!.projectInfo().id]) : JSON.stringify([options.plugin.manifest.id, binding]), method, params, signal, check);
            case 'files.save':
            case 'files.saveHtml':
            case 'files.saveImage': {
                const kind = method === 'files.save' ? 'text' as const : method === 'files.saveHtml' ? 'html' as const : 'image' as const;
                const bytes = kind === 'image' ? pngBytes(params.base64) : new TextEncoder().encode(kind === 'html' ? SAVED_HTML_PREFIX + params.html : params.text);
                if (bytes.length > (kind === 'text' ? LIMITS.exportBytes : kind === 'html' ? LIMITS.htmlBytes : LIMITS.imageBytes))
                    throw new Error('Export exceeds size limit');
                const result = await options.saveFile!({ name: params.name, kind, bytes, method, ...(kind === 'text' ? { text: params.text } : {}) }, signal);
                check();
                if (result.status !== 'download-requested' && result.status !== 'cancelled')
                    throw new Error('Invalid download result');
                return { status: result.status };
            }
            case 'exports.run':
                if (EXPORT_KINDS[params.kind as keyof typeof EXPORT_KINDS].surface !== 'editor:' + context.tool)
                    throw new Error('This export is unavailable in this editor');
                // Exports run KiCad on the server and may take a while.
                return platformRequest('activations/' + activation!.id + '/exports', 'POST', params, signal, 120000);
            case 'exports.readJson':
                return platformRequest('activations/' + activation!.id + '/exports/' + params.exportId + '/json?name=' + encodeURIComponent(params.name), 'GET', undefined, signal);
            case 'exports.bundle':
                return platformRequest('activations/' + activation!.id + '/bundles', 'POST', params, signal, 120000);
            case 'files.saveBundle': {
                const bytes = await platformBytes('activations/' + activation!.id + '/bundles/' + params.bundleId, EXPORT_LIMITS.bundleBytes, signal);
                check();
                // Only ever a ZIP: the server built it, the name says so, the bytes must agree.
                if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)
                    throw new Error('Bundle is not a ZIP archive');
                const meta = await platformRequest('activations/' + activation!.id + '/bundles/' + params.bundleId + '/info', 'GET', undefined, signal);
                const result = await options.saveFile!({ name: String(meta.name), kind: 'archive', bytes, method }, signal);
                check();
                if (result.status !== 'download-requested' && result.status !== 'cancelled')
                    throw new Error('Invalid download result');
                return { status: result.status };
            }
            case 'files.choose': {
                requirePermission('files:choose');
                exact(params, ['extensions']);
                if (!Array.isArray(params.extensions) || params.extensions.length < 1 || params.extensions.length > 4 || params.extensions.some((ext: unknown) => !['.kicad_sym', '.kicad_mod', '.txt', '.json'].includes(ext as string)))
                    throw new Error('Unsupported file extensions');
                if (files.size >= 4)
                    throw new Error('Close another file first');
                const file = await options.chooseFile(params.extensions, signal);
                check();
                await authorize(method);
                check();
                if (!file)
                    return null;
                if (files.size >= 4)
                    throw new Error('Close another file first');
                if (file.size > 4 * 1024 * 1024 || !params.extensions.some((ext: string) => file.name.toLowerCase().endsWith(ext)))
                    throw new Error('Choose a matching file smaller than 4 MiB');
                const handle = crypto.randomUUID();
                files.set(handle, file);
                return { handle, name: file.name, size: file.size };
            }
            case 'files.readText':
            case 'files.close': {
                requirePermission('files:choose');
                exact(params, ['handle']);
                const file = files.get(params.handle);
                if (!file)
                    throw new Error('File handle is invalid or closed');
                if (method === 'files.close') {
                    files.delete(params.handle);
                    return null;
                }
                const text = await file.text();
                await authorize(method);
                check();
                if (!files.has(params.handle))
                    throw new Error('File handle is invalid or closed');
                return text;
            }
            case 'editor.requestPlacement': {
                requirePermission('editor:place-items');
                exact(params, ['label', 'sexpr']);
                if (context.readOnly || !context.canPlaceItems)
                    throw new Error('Placement is unavailable in this editor');
                if (typeof params.label !== 'string' || !params.label.length || params.label.length > 100 || typeof params.sexpr !== 'string' || new TextEncoder().encode(params.sexpr).length > 512 * 1024)
                    throw new Error('Invalid placement proposal');
                // The editor adapter validates clipboard structure and owns confirmation.
                return options.requestPlacement(params, signal);
            }
            default: throw new Error('Unknown PCBJam API method');
        }
    }
    const methodLimit = (method: string) => method === 'http.request' || method === 'http.upload' ? BACKEND_LIMITS.resultBytes : method === 'files.readText' ? 5 * 1024 * 1024 : method === 'exports.readJson' ? EXPORT_LIMITS.jsonBytes + 1024 : LIMITS.snapshotBytes;
    options.signal.addEventListener('abort', dispose, { once: true });
    try {
        options.signal.throwIfAborted();
        if(platformConfiguration()) {
            if(!options.documents||!options.plugin.pluginId)throw new Error('Open a saved project to use this plugin');
            activation=await platformRequest('activations','POST',{
                pluginId:options.plugin.pluginId,digest:options.plugin.digest,generation:options.plugin.generation,
                projectId:options.documents.projectInfo().id,document:options.context().fileName,surface:'editor:'+options.context().tool,
                runtimeVersion:platformConfiguration()!.runtimeVersion,protocolVersion:1,
            },signal);
            grants=activation!.grants;
            options.onAuthorizationReady?.(authorize);
        }
        const pkg = activation ? await platformRequest('activations/'+activation.id+'/logic','GET',undefined,signal) : await api('releases/' + options.plugin.digest);
        signal.throwIfAborted();
        if (pkg.digest !== options.plugin.digest || JSON.stringify(pkg.manifest) !== JSON.stringify(options.plugin.manifest))
            throw new Error('Plugin release changed');
        if(activation)await verifyText(pkg.main,options.plugin.fileMetadata?.['main.js']);
        const verified=await runtimeAssets(new URL('.',import.meta.url).href,signal);
        const [wasm, prelude] = await Promise.all([
            verified ? verified.load('quickjs.wasm').then(b=>b.buffer) : fetch(runtimeAsset('quickjs.wasm'), { signal }).then(r => { if (!r.ok)
                throw new Error('Missing runtime'); return r.arrayBuffer(); }),
            verified ? verified.load('package-prelude.js').then(b=>new TextDecoder().decode(b)) : fetch(runtimeAsset('package-prelude.js'), { signal }).then(r => { if (!r.ok)
                throw new Error('Missing SDK'); return r.text(); }),
        ]);
        if(verified)await verified.load('package-worker.js');
        signal.throwIfAborted();
        worker = new Worker(runtimeAsset('package-worker.js'), { name: 'pcbjam-plugin-' + pkg.manifest.id });
        const bootTimer = setTimeout(() => readyReject(new Error('Plugin runtime timed out')), 10000);
        channel.port1.onmessage = event => {
            if (closed)
                return;
            const message = event.data;
            if (message?.type === 'ready') {
                readyResolve();
                return;
            }
            if (message?.type === 'fatal') {
                fail(String(message.error).slice(0, 400));
                return;
            }
            if (message?.type === 'result') {
                if (!activeId || message.id !== activeId) {
                    fail('Invalid plugin result');
                    return;
                }
                activeId = 0;
                clearTimeout(commandTimer);
                uiChannel.port1.postMessage(message);
                return;
            }
            if (message?.type !== 'host-call' || !activeId || !Number.isSafeInteger(message.id) || message.id <= lastHost) {
                fail('Invalid plugin API request');
                return;
            }
            lastHost = message.id;
            if (++pendingHost > LIMITS.pendingHostCalls) {
                fail('Plugin API rate limit exceeded');
                return;
            }
            // Export slices are bounded by their own time budget and rest period, not by the call window.
            void (message.method === 'documents.exportRead' ? Promise.resolve() : pace()).then(() => callHost(message.method, message.params)).then(async result => {
                if(activation)await authorize(message.method);
                if (!closed) {
                    check();
                    const safe = boundedJSON(result, methodLimit(message.method));
                    channel.port1.postMessage({ type: 'host-result', id: message.id, ok: true, result: safe });
                }
            }).catch(error => {
                if (!closed)
                    channel.port1.postMessage({ type: 'host-result', id: message.id, ok: false, error: String(error.message).slice(0, 400), ...(typeof error.code==='string'&&/^[A-Z_]{1,40}$/.test(error.code)?{code:error.code}:{}) });
            }).finally(() => { pendingHost--; });
        };
        worker.onerror = () => fail('Plugin Worker failed');
        worker.postMessage({ type: 'init', wasm, prelude, main: pkg.main }, [channel.port2, wasm]);
        try {
            await ready;
        }
        finally {
            clearTimeout(bootTimer);
        }
        signal.throwIfAborted();
        frame = document.createElement('iframe');
        frame.title = pkg.manifest.name + ' plugin';
        frame.sandbox.add('allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        frame.style.cssText = 'border:0;width:100%;height:100%;display:block;color-scheme:dark';
        frame.addEventListener('load', () => { if (++loads > 1)
            fail('Plugin navigation stopped this instance'); });
        window.addEventListener('message', handshake);
        uiReadyTimer = setTimeout(() => fail('Plugin UI did not connect'), 10000);
        uiChannel.port1.onmessage = event => {
            if (closed)
                return;
            const message = event.data;
            if (!connected && message?.type === 'connected' && message.version === 1) {
                connected = true;
                clearTimeout(uiReadyTimer);
                return;
            }
            try {
                exact(message, ['id', 'command', 'params']);
                if (!connected || activeId || !Number.isSafeInteger(message.id) || message.id <= lastUi || typeof message.command !== 'string' || !/^[a-z][a-zA-Z0-9.:-]{0,63}$/.test(message.command) || JSON.stringify(message).length > LIMITS.uiCommandBytes)
                    throw new Error('Invalid plugin UI request');
                const now = performance.now();
                uiTimes = uiTimes.filter(t => now - t < LIMITS.uiCommandWindowMs);
                uiTimes.push(now);
                if (uiTimes.length > LIMITS.uiCommandsPerWindow)
                    throw new Error('Plugin UI rate limit exceeded');
                lastUi = activeId = message.id;
                commandTimer = setTimeout(() => fail('Plugin action timed out'), LIMITS.commandTimeoutMs);
                channel.port1.postMessage({ type: 'command', ...message });
            }
            catch (error) {
                fail((error as Error).message);
            }
        };
        if(activation) {
            const ticket=await platformRequest('activations/'+activation.id+'/ui-ticket','POST',undefined,signal);
            const url=new URL(ticket.url);
            if(url.origin!==activation.uiOrigin||url.origin===location.origin||!/^\/render\/[A-Za-z0-9_-]{43}$/.test(url.pathname)||url.search||url.hash)throw new Error('Invalid plugin UI ticket');
            frame.src=url.href+'#'+nonce;
        } else frame.src = (options.uiOrigin ?? 'http://127.0.0.1:4318') + '/plugin/' + pkg.digest + '#' + nonce;
        signal.throwIfAborted();
        container.append(frame);
        // Revoke other tabs after uninstall/update; local registry failure fails closed.
        let checking = false;
        poll = setInterval(() => {
            if (checking || closed)
                return;
            checking = true;
            void (activation ? authorize('context.get',true).then(()=>({plugins:[pkg]})) : listPlugins()).then(({ plugins }) => {
                if (!closed && !plugins.some(p => p.digest === pkg.digest))
                    fail('Plugin was removed or updated');
            }).catch(error => { if (!closed && error?.code !== 'RATE_LIMITED') // throttled: host calls are blocked on the same check
                fail('Plugin registry unavailable'); }).finally(() => { checking = false; });
        }, 2000);
        return { dispose };
    }
    catch (error) {
        dispose();
        throw error;
    }
}
