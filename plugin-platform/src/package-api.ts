import {validateBackendRequest} from '../backend-contract.mjs';
import { z } from 'zod';
const empty = z.object({}).strict();
const id = z.string().min(1).max(128);
const revision = z.number().int().positive().safe();
const document = z.string().uuid();
const page = { cursor: z.number().int().min(0).max(50000), limit: z.number().int().min(1).max(100) };
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const request = (permission: string | null, input: z.ZodTypeAny) => ({ permission, input });
/** The complete host operation allowlist. Tests must cover every entry. */
export const METHODS = {
    // Dynamic endpoint grants are checked by both the host and server.
    'http.request': request(null, z.unknown().transform((value,ctx)=>{try{return validateBackendRequest(value);}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid backend request'});return z.NEVER;}})),
    'context.get': request(null, empty),
    'project.getInfo': request('project:read-info', empty),
    'documents.list': request('project:read-info', z.object(page).strict()),
    'documents.getCurrent': request('documents:read', empty),
    'documents.snapshot': request('documents:read', z.object({ document, revision }).strict()),
    'documents.poll': request('documents:read', z.object({ document, since: revision }).strict()),
    'documents.exportStart': request('documents:read', z.object({ document, revision, types: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(8), omit: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(8), layout: z.boolean(), libSymbols: z.boolean() }).strict()),
    'documents.exportRead': request('documents:read', z.object({ export: z.string().uuid() }).strict()),
    'items.list': request('documents:read', z.object({ document, revision, ...page, types: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(8) }).strict()),
    'items.get': request('documents:read', z.object({ document, revision, ids: z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length), partial: z.boolean().optional() }).strict()),
    'selection.get': request('editor:read-selection', empty),
    'storage.get': request('storage:local', z.object({ key }).strict()),
    'storage.set': request('storage:local', z.object({ key, value: z.unknown().refine(v => v !== undefined), expectedRevision: z.number().int().min(0).safe() }).strict()),
    'storage.delete': request('storage:local', z.object({ key, expectedRevision: z.number().int().min(0).safe() }).strict()),
    'storage.list': request('storage:local', empty),
    'files.choose': request('files:choose', z.object({ extensions: z.array(z.enum(['.kicad_sym', '.kicad_mod', '.txt', '.json'])).min(1).max(4) }).strict()),
    'files.readText': request('files:choose', z.object({ handle: id }).strict()),
    'files.close': request('files:choose', z.object({ handle: id }).strict()),
    'files.save': request('files:save', z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,90}\.(txt|json|csv|kicad_sym|kicad_mod|kicad_sch|kicad_pcb)$/), text: z.string().max(512 * 1024) }).strict()),
    // Active content gets its own grant. The host, not the plugin, writes the first bytes of the page.
    'files.saveHtml': request('files:save-html', z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,90}\.html$/), html: z.string().max(8 * 1024 * 1024) }).strict()),
    'files.saveImage': request('files:save', z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,90}\.png$/), base64: z.string().min(16).max(Math.ceil(4 * 1024 * 1024 / 3) * 4) }).strict()),
    'editor.requestPlacement': request('editor:place-items', z.object({ label: z.string().min(1).max(100), sexpr: z.string().max(512 * 1024) }).strict()),
} as const;
export type Method = keyof typeof METHODS;
export const LIMITS = Object.freeze({ snapshotBytes: 1024 * 1024, pageItems: 100, fileBytes: 4 * 1024 * 1024, exportBytes: 512 * 1024, storageBytes: 256 * 1024, storageValueBytes: 16 * 1024, storageKeys: 64, htmlBytes: 8 * 1024 * 1024, imageBytes: 4 * 1024 * 1024,
    // Enforcement values, published through context.get() so plugins can plan reads.
    // Host calls over the window are delayed, not rejected. The runtime Worker refuses a
    // fifth call in flight; the host repeats that bound in case the Worker is bypassed.
    // Two hosted authorization checks per call must stay under the server's per-user budget.
    responseBytes: 1024 * 1024, responseNodes: 100000, hostCallsPerWindow: 40, hostCallWindowMs: 10000, pendingHostCalls: 4,
    // Whole-document export: copy for at most exportSliceMs on the UI thread, then yield.
    exportSliceMs: 8, exportSliceChars: 256 * 1024, exportTotalChars: 32 * 1024 * 1024,
    // A hosted authorization this recent is reused for LEASED_READS; the revocation poll runs at the same interval.
    readLeaseMs: 2000,
    uiCommandsPerWindow: 20, uiCommandWindowMs: 10000, uiCommandBytes: 64000, commandTimeoutMs: 120000 });
/**
 * First bytes of every page saved through files.saveHtml. A saved page runs the plugin's code
 * outside PCBJam, with the user's design inside it; this keeps it from loading or sending anything.
 * A meta policy only governs what follows it, so it must come before any plugin byte. It cannot
 * stop the page navigating itself elsewhere: the consent text says the file contains code.
 */
export const SAVED_HTML_PREFIX = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri \'none\'; form-action \'none\'">\n';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Decode and prove it is a PNG: the name says image, so the bytes must not be a page or a program. */
export function pngBytes(base64: string): Uint8Array {
    let binary: string;
    try { binary = atob(base64); }
    catch { throw new Error('Image is not valid base64'); }
    if (binary.length > LIMITS.imageBytes)
        throw new Error('Export exceeds size limit');
    if (binary.length < 16 || PNG_MAGIC.some((byte, index) => binary.charCodeAt(index) !== byte))
        throw new Error('Image is not a PNG');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
/**
 * Reads of the already-open document whose effect ends inside this tab. They may reuse a
 * hosted authorization up to LIMITS.readLeaseMs old. Everything with an effect outside the
 * plugin (files, placement, backends, storage writes) is authorized per call.
 */
export const LEASED_READS: ReadonlySet<string> = new Set(['context.get', 'project.getInfo', 'documents.list', 'documents.getCurrent', 'documents.snapshot', 'documents.poll',
    'documents.exportStart', 'documents.exportRead', 'items.list', 'items.get', 'selection.get']);
/** Bound before stringify/recursive schema work. Return a detached JSON value. */
export function boundedJSON(value: unknown, maxBytes: number): any {
    let nodes = 0, units = 0;
    const seen = new Set<object>();
    function visit(v: any, depth: number): any {
        if (++nodes > 100000 || depth > 48)
            throw new Error('Data exceeds structure limits');
        if (typeof v === 'string') {
            units += v.length;
            if (units > maxBytes)
                throw new Error('Data exceeds size limit');
            return v;
        }
        if (v === null || typeof v === 'boolean')
            return v;
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (!v || typeof v !== 'object' || seen.has(v))
            throw new Error('Expected JSON data');
        seen.add(v);
        let result: any;
        if (Array.isArray(v))
            result = v.map(x => visit(x, depth + 1));
        else {
            if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
                throw new Error('Expected plain JSON object');
            result = Object.create(null);
            for (const [k, item] of Object.entries(v)) {
                units += k.length;
                if (units > maxBytes)
                    throw new Error('Data exceeds size limit');
                result[k] = visit(item, depth + 1);
            }
        }
        seen.delete(v);
        return result;
    }
    const copy = visit(value, 0), serialized = JSON.stringify(copy);
    if (new TextEncoder().encode(serialized).length > maxBytes)
        throw new Error('Data exceeds size limit');
    return copy;
}
export interface DocumentAdapter {
    projectInfo(): {
        id: string;
        scope: string;
        name: string;
    };
    catalog(): Array<{
        name: string;
        kind: string;
        current: boolean;
    }>;
    revision(): number;
    items(cursor: number, limit: number, types: string[]): {
        items: Array<{
            id: string;
            type: string;
            parent: string | null;
        }>;
        nextCursor: number | null;
    };
    /** partial: items over the limits come back as {id, error} instead of failing the call. */
    getItems(ids: string[], partial?: boolean): unknown[];
    openExport(request: { types: string[]; omit: string[]; layout: boolean; libSymbols: boolean }): {
        /** Newline-delimited JSON text; throws once the document has changed. */
        read(budgetMs: number, maxChars: number): { text: string; done: boolean };
    };
    snapshot(): {
        root: string;
        items: unknown[];
        layout: unknown[];
        libSymbols: string[];
    };
    selection(): {
        revision: number;
        ids: string[];
    };
}
