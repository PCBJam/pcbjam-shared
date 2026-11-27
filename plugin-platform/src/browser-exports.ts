/**
 * Plugin exports in the browser (plugins 0029).
 *
 * The editor runs KiCad's exporters on the board it already has open and hands
 * the files over (BrowserExporter). This store keeps them for the running
 * plugin the way the server keeps export rows: ids, names and sizes cross the
 * sandbox, the bytes never do. It keeps the server's rules too: the same
 * limits, an hour of life, a number of exports a minute. Bundles are zipped
 * here exactly as the server zips them (fflate, fixed time, level 6), so the
 * same files give the same ZIP.
 *
 * A store belongs to one document: the host clears it when its panel moves to
 * another file, so nothing made from one board can be sent as another's.
 *
 * What the server still does: `http.upload` sends a stored bundle, so the host
 * stores a browser bundle on the server first (POST bundles/browser) and hands
 * the upload that id.
 */
import { zipSync } from 'fflate';
import { EXPORT_LIMITS, type ExportOptions } from './package-api';

export interface BrowserExportFile { name: string; bytes: Uint8Array }
export interface BrowserExportRun { kind: string; files: BrowserExportFile[] }
/**
 * The editor's side: run `kinds` on the open board in one KiCad call, in the order asked, with the
 * options the plugin gave (plugins 0027; keyed by kind, checked against EXPORT_OPTIONS by the host).
 */
export type BrowserExporter = (kinds: string[], signal: AbortSignal, options?: ExportOptions) => Promise<BrowserExportRun[]>;

export const BROWSER_EXPORT_LIMITS = Object.freeze({
    /** One run's files, all kinds together: what a bundle may hold. */
    runBytes: EXPORT_LIMITS.bundleBytes,
    /** Everything a plugin's store keeps; the oldest exports and bundles go first. */
    retainedBytes: 4 * EXPORT_LIMITS.bundleBytes,
    /** Exports a minute for one plugin, a batch counting one per kind (the server's `export:<plugin>` budget). */
    perMinute: 12,
    /** A bundle stored on the server is stored again this long before its row there expires. */
    stagingMarginMs: 5 * 60 * 1000,
});

interface Staged { activationId: string; at: number; id: Promise<string> }
interface Bundle { name: string; bytes: Uint8Array; files: { name: string; size: number }[]; staged?: Staged }
interface Kept<T> { value: T; bytes: number; at: number }

/**
 * fflate writes a ZIP entry's time from the local calendar fields. A date built from local
 * fields gives the same entry in every timezone: 2020-01-01 00:00:00, what the server (UTC) writes.
 */
const FIXED_MTIME = new Date(2020, 0, 1, 0, 0, 0);

export function browserExportStore(now: () => number = Date.now) {
    const exports = new Map<string, Kept<BrowserExportRun>>();
    const bundles = new Map<string, Kept<Bundle>>();
    let spent: number[] = [];
    const summary = (run: BrowserExportRun) => run.files.map(file => ({ name: file.name, size: file.bytes.length }));
    const runBytes = (run: BrowserExportRun) => run.files.reduce((sum, file) => sum + file.bytes.length, 0);
    const live = <T>(map: Map<string, Kept<T>>, id: string) => {
        const kept = map.get(id);
        if (kept && now() - kept.at >= EXPORT_LIMITS.ttlMs) { map.delete(id); return undefined; }
        return kept?.value;
    };
    /** Drops what expired, then the oldest entries until `incoming` more bytes fit. */
    const makeRoom = (incoming: number) => {
        const maps: Map<string, Kept<unknown>>[] = [exports, bundles];
        const entries: { id: string; kept: Kept<unknown>; map: Map<string, Kept<unknown>> }[] = [];
        for (const map of maps)
            for (const [id, kept] of map) {
                if (now() - kept.at >= EXPORT_LIMITS.ttlMs) map.delete(id);
                else entries.push({ id, kept, map });
            }
        let total = entries.reduce((sum, entry) => sum + entry.kept.bytes, 0);
        for (const entry of entries.sort((a, b) => a.kept.at - b.kept.at)) {
            if (total + incoming <= BROWSER_EXPORT_LIMITS.retainedBytes) break;
            entry.map.delete(entry.id);
            total -= entry.kept.bytes;
        }
    };
    return {
        isExport: (id: string) => !!live(exports, id),
        isBundle: (id: string) => !!live(bundles, id),
        /** Counts `count` exports against this minute's allowance, before they run. */
        spend(count: number) {
            const at = now();
            spent = spent.filter(time => at - time < 60000);
            if (spent.length + count > BROWSER_EXPORT_LIMITS.perMinute)
                throw Object.assign(new Error('Too many plugin requests. Try again shortly.'), { code: 'RATE_LIMITED' });
            for (let i = 0; i < count; i++) spent.push(at);
        },
        add(runs: BrowserExportRun[]) {
            const total = runs.reduce((sum, run) => sum + runBytes(run), 0);
            if (total > BROWSER_EXPORT_LIMITS.runBytes) throw new Error('Export exceeds 32 MiB');
            makeRoom(total);
            return runs.map(run => {
                const exportId = crypto.randomUUID();
                exports.set(exportId, { value: run, bytes: runBytes(run), at: now() });
                return { exportId, kind: run.kind, files: summary(run) };
            });
        },
        readJson(exportId: string, name: string) {
            const file = live(exports, exportId)?.files.find(f => f.name === name);
            if (!file || !name.endsWith('.json')) throw new Error('No such JSON file in this export');
            if (file.bytes.length > EXPORT_LIMITS.jsonBytes) throw new Error('JSON output exceeds 1 MiB');
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
        },
        /** The server's bundle rules (plugin-exports.ts): unique names, renames of files that exist, size caps. */
        bundle(input: { parts: { exportId: string; rename?: Record<string, string> }[]; extraFiles?: { name: string; text: string }[]; zipName: string }) {
            const files: Record<string, Uint8Array> = {};
            let total = 0;
            const reserve = (name: string, bytes: Uint8Array) => {
                if (Object.prototype.hasOwnProperty.call(files, name)) throw new Error('Two files in the bundle are named ' + name);
                total += bytes.length;
                if (total > EXPORT_LIMITS.bundleBytes) throw new Error('Bundle exceeds 32 MiB');
                files[name] = bytes;
            };
            for (const part of input.parts) {
                const run = live(exports, part.exportId);
                if (!run) throw new Error('Export not found or expired');
                for (const from of Object.keys(part.rename ?? {}))
                    if (!run.files.some(f => f.name === from)) throw new Error('Cannot rename missing file ' + from);
                for (const file of run.files) reserve(part.rename?.[file.name] ?? file.name, file.bytes);
            }
            let extra = 0;
            for (const file of input.extraFiles ?? []) {
                const bytes = new TextEncoder().encode(file.text);
                extra += bytes.length;
                if (extra > EXPORT_LIMITS.extraBytes) throw new Error('Plugin files exceed 2 MiB');
                reserve(file.name, bytes);
            }
            const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { mtime: FIXED_MTIME }]])), { level: 6 });
            const bundleId = crypto.randomUUID();
            const listed = Object.entries(files).map(([name, data]) => ({ name, size: data.length }));
            makeRoom(bytes.length);
            bundles.set(bundleId, { value: { name: input.zipName, bytes, files: listed }, bytes: bytes.length, at: now() });
            return { bundleId, name: input.zipName, size: bytes.length, files: listed };
        },
        bundleBytes(bundleId: string) {
            const bundle = live(bundles, bundleId);
            if (!bundle) throw new Error('Bundle not found or expired');
            return bundle;
        },
        /**
         * The server's id for this bundle under `activationId`. `store` posts the bytes: once
         * for calls that overlap, again when the activation changed or the server's copy is
         * about to expire, and again after a failed post.
         */
        serverBundle(bundleId: string, activationId: string, store: (bundle: { name: string; bytes: Uint8Array }) => Promise<string>): Promise<string> {
            const bundle = live(bundles, bundleId);
            if (!bundle) return Promise.reject(new Error('Bundle not found or expired'));
            const staged = bundle.staged;
            if (staged && staged.activationId === activationId && now() - staged.at < EXPORT_LIMITS.ttlMs - BROWSER_EXPORT_LIMITS.stagingMarginMs)
                return staged.id;
            const next: Staged = { activationId, at: now(), id: store(bundle) };
            bundle.staged = next;
            next.id.catch(() => { if (bundle.staged === next) bundle.staged = undefined; });
            return next.id;
        },
        /** Forgets everything: the panel moved to another document, or stopped. */
        clear() {
            exports.clear();
            bundles.clear();
        },
    };
}
