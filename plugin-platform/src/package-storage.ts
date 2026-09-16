import { boundedJSON, LIMITS } from './package-api';
const DB = 'pcbjam-plugin-data-v1', STORE = 'namespaces';
type RecordData = {
    revision: number;
    values: Record<string, unknown>;
};
/** Only PCBJam invokes cleanup, using its authenticated installation catalog. */
export async function cleanupPluginStorage(apiBase:string,userId:string,plugins:readonly {pluginId?:string;storageEpoch?:number;installed?:boolean}[]) {
    const epochs=new Map(plugins.filter(p=>p.pluginId).map(p=>[p.pluginId!,p]));
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
        let settled=false;
        const fail=(error:Error)=>{if(!settled){settled=true;reject(error);}};
        const request=indexedDB.open(DB,1);
        request.onupgradeneeded=()=>{if(settled)request.transaction?.abort();else request.result.createObjectStore(STORE);};
        request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;resolve(request.result);};
        request.onerror=()=>fail(new Error('Plugin storage cleanup failed'));
        request.onblocked=()=>fail(new Error('Plugin storage is blocked'));
    });
    try {await new Promise<void>((resolve,reject)=>{
        const tx=db.transaction(STORE,'readwrite');
        const cursor=tx.objectStore(STORE).openCursor();
        cursor.onsuccess=()=>{
            const row=cursor.result;if(!row)return;
            if(typeof row.key==='string') {
                try {
                    const key=JSON.parse(row.key);
                    if(Array.isArray(key)&&key.length===6&&key[0]==='hosted'&&key[1]===apiBase&&key[2]===userId) {
                        const installation=epochs.get(key[3]);
                        if(installation && (installation.installed===false || installation.storageEpoch!==key[4]))row.delete();
                    }
                }catch{/* Legacy or another application record: leave it alone. */}
            }
            row.continue();
        };
        tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error('Plugin storage cleanup failed'));
    });}finally{db.close();}
}
/** One namespace record makes the quota and CAS check atomic across tabs. */
export async function storageCall(namespace: string, method: string, params: any, signal: AbortSignal, check: () => void) {
    check();
    signal.throwIfAborted();
    const value = method === 'storage.set' ? boundedJSON(params.value, LIMITS.storageValueBytes) : null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => { if (!settled) {
            settled = true;
            signal.removeEventListener('abort', abort);
            reject(error);
        } };
        const abort = () => fail(new Error('Plugin storage operation cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
            return;
        }
        let r: IDBOpenDBRequest;
        try {
            r = indexedDB.open(DB, 1);
        }
        catch {
            fail(new Error('Plugin storage unavailable'));
            return;
        }
        r.onupgradeneeded = () => { if (settled)
            r.transaction?.abort();
        else
            r.result.createObjectStore(STORE); };
        r.onsuccess = () => { if (settled) {
            r.result.close();
            return;
        } settled = true; signal.removeEventListener('abort', abort); resolve(r.result); };
        r.onerror = () => fail(new Error('Plugin storage unavailable'));
        r.onblocked = () => fail(new Error('Plugin storage is blocked'));
    });
    try {
        check();
        signal.throwIfAborted();
        return await new Promise<unknown>((resolve, reject) => {
            const write = method === 'storage.set' || method === 'storage.delete';
            const tx = db.transaction(STORE, write ? 'readwrite' : 'readonly'), store = tx.objectStore(STORE);
            let output: unknown, failure: unknown;
            const abort = () => { try {
                tx.abort();
            }
            catch { } };
            signal.addEventListener('abort', abort, { once: true });
            tx.oncomplete = () => { signal.removeEventListener('abort', abort); try {
                check();
                signal.throwIfAborted();
                resolve(output);
            }
            catch (e) {
                reject(e);
            } };
            tx.onabort = () => { signal.removeEventListener('abort', abort); reject(failure ?? new Error('Plugin storage operation cancelled')); };
            tx.onerror = () => { failure = new Error('Plugin storage operation failed'); };
            const read = store.get(namespace);
            read.onsuccess = () => {
                try {
                    check();
                    signal.throwIfAborted();
                    const row: RecordData = read.result ?? { revision: 0, values: Object.create(null) };
                    if (!Number.isSafeInteger(row.revision) || row.revision < 0 || !row.values || typeof row.values !== 'object' || Array.isArray(row.values))
                        throw new Error('Invalid plugin storage record');
                    boundedJSON(row, LIMITS.storageBytes + 1024);
                    if (write) {
                        if (params.expectedRevision !== row.revision)
                            throw new Error('Storage conflict: read again before writing');
                        if (row.revision === Number.MAX_SAFE_INTEGER)
                            throw new Error('Storage revision exhausted');
                        const values = Object.assign(Object.create(null), row.values);
                        if (method === 'storage.set')
                            values[params.key] = value;
                        else
                            delete values[params.key];
                        if (Object.keys(values).length > LIMITS.storageKeys)
                            throw new Error('Plugin storage key quota exceeded');
                        boundedJSON(values, LIMITS.storageBytes);
                        check();
                        signal.throwIfAborted();
                        const updated = { revision: row.revision + 1, values };
                        store.put(updated, namespace);
                        output = { revision: updated.revision };
                    }
                    else if (method === 'storage.get')
                        output = { revision: row.revision, found: Object.hasOwn(row.values, params.key), value: Object.hasOwn(row.values, params.key) ? row.values[params.key] : null };
                    else
                        output = { revision: row.revision, keys: Object.keys(row.values).sort() };
                }
                catch (e) {
                    failure = e;
                    abort();
                }
            };
        });
    }
    finally {
        db.close();
    }
}
