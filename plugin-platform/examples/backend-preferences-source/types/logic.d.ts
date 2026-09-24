/** PCBJam preview SDK v1. Browser/native objects are never passed to plugins. */
type PCBJamJSON = null | boolean | number | string | PCBJamJSON[] | {[key:string]:PCBJamJSON};
type PCBJamSNode = string | PCBJamSNode[];
type PCBJamSlot = {atom:string} | {k:string;v:PCBJamSlot[]} | {item:string};
type PCBJamDocumentRef = {document:string;revision:number};
type PCBJamItemSummary = {id:string;type:string;parent:string|null};
type PCBJamItem = PCBJamItemSummary & {body:PCBJamSlot[]};
/** TOO_LARGE: over the response limits on its own. DEFERRED: did not fit in this response; request it again. */
type PCBJamPolygon = {outline:[number,number][];holes?:[number,number][][]};
type PCBJamGeometryDrawing = {layer:string;text?:'reference'|'value'|'field'|'text';polygons:PCBJamPolygon[]};
/** `$` names the record: 'board' | 'footprint' | 'drawing' | 'tracks' | 'zone'. See the API guide for each shape. */
type PCBJamGeometryRecord = {$:string;[key:string]:any};
type PCBJamItemError = {id:string;error:'TOO_LARGE'|'DEFERRED'};
// BEGIN GENERATED HOST METHODS
type PCBJamHostMethod = "http.request" | "context.get" | "project.getInfo" | "documents.list" | "documents.getCurrent" | "documents.snapshot" | "documents.poll" | "documents.exportStart" | "documents.exportRead" | "board.geometryStart" | "items.list" | "items.get" | "selection.get" | "editor.select" | "storage.get" | "storage.set" | "storage.delete" | "storage.list" | "files.choose" | "files.readText" | "files.close" | "files.save" | "files.saveHtml" | "files.saveImage" | "exports.run" | "exports.readJson" | "exports.bundle" | "files.saveBundle" | "editor.requestPlacement";
// END GENERATED HOST METHODS
/** Plugin logic only, and only while a command is being handled: at most 32 pending, 60 s each,
 *  all cancelled when the command settles. An exception thrown from a callback stops the plugin. */
declare function setTimeout(callback:(...args:any[])=>unknown,ms?:number,...args:any[]):number;
declare function clearTimeout(id:number):void;
declare const pcbjam: {
  /** Approved HTTPS backend; no arbitrary URLs, headers or API keys. */
  http:{request(endpointId:string,request:{method:'GET';path:string}|{method:'POST';path:string;json:PCBJamJSON}):Promise<{status:number;headers:Record<string,string>;body:PCBJamJSON}>};
  handle(command:string,handler:(params:any)=>unknown|Promise<unknown>):void;
  context:{get():Promise<{
    tool:string;fileName:string;readOnly:boolean;canPlaceItems:boolean;
    methods:PCBJamHostMethod[];
    /** Host calls over hostCallsPerWindow are delayed, never rejected. Keep at most pendingHostCalls
     *  in flight: await each call. UI commands over their window stop the plugin. */
    limits:{snapshotBytes:number;pageItems:number;fileBytes:number;exportBytes:number;storageBytes:number;storageValueBytes:number;storageKeys:number;htmlBytes:number;imageBytes:number;selectItems:number;
      responseBytes:number;responseNodes:number;hostCallsPerWindow:number;hostCallWindowMs:number;pendingHostCalls:number;
      exportSliceMs:number;exportSliceChars:number;exportTotalChars:number;readLeaseMs:number;
      uiCommandsPerWindow:number;uiCommandWindowMs:number;uiCommandBytes:number;commandTimeoutMs:number};
  }>};
  project:{getInfo():Promise<{id:string;scope:string;name:string;readOnly:boolean}>};
  documents:{
    /** File names from the editor's project catalog; no handles for closed docs. */
    list(options?:{cursor?:number;limit?:number}):Promise<{files:{name:string;kind:string;current:boolean}[];nextCursor:number|null}>;
    getCurrent():Promise<PCBJamDocumentRef & {name:string;readOnly:boolean}>;
    snapshot(ref:PCBJamDocumentRef):Promise<{revision:number;root:string;items:PCBJamItem[];layout:PCBJamSlot[];libSymbols:string[]}>;
    /** The whole document without the snapshot size limit. The editor copies it a few milliseconds at a
     *  time, so large boards do not stall the UI; a changed document rejects and you start again.
     *  `types` keeps only those item types; `omit` drops child forms by name at any depth, e.g.
     *  ['filled_polygon'] for zone fills. With `onItems`, batches are delivered as they arrive and not
     *  retained (`items` stays empty), which keeps memory low on big boards. */
    export(options:PCBJamDocumentRef & {types?:string[];omit?:string[];layout?:boolean;libSymbols?:boolean},onItems?:(items:PCBJamItem[])=>unknown|Promise<unknown>):Promise<{revision:number;root:string;items:PCBJamItem[];count:number;layout:PCBJamSlot[]|null;libSymbols:string[]}>;
    /** Pure serialization occurs in QuickJS after the bounded snapshot read. */
    getSexpr(ref:PCBJamDocumentRef):Promise<{revision:number;text:string}>;
    poll(options:{document:string;since:number}):Promise<{revision:number;changed:boolean}>;
  };
  items:{
    list(options:PCBJamDocumentRef & {cursor?:number;limit?:number;types?:string[]}):Promise<{revision:number;items:PCBJamItemSummary[];nextCursor:number|null}>;
    get(options:PCBJamDocumentRef & {ids:string[];partial?:false}):Promise<{revision:number;items:PCBJamItem[]}>;
    /** partial: one oversized item no longer fails the page; it comes back as {id, error}. */
    get(options:PCBJamDocumentRef & {ids:string[];partial:true}):Promise<{revision:number;items:(PCBJamItem|PCBJamItemError)[]}>;
  };
  selection:{get():Promise<PCBJamDocumentRef & {selectionRevision:number;ids:string[]}>};
  storage:{
    /** Revision belongs to the whole plugin/account/project namespace. */
    get(key:string):Promise<{revision:number;found:boolean;value:PCBJamJSON}>;
    set(options:{key:string;value:PCBJamJSON;expectedRevision:number}):Promise<{revision:number}>;
    delete(options:{key:string;expectedRevision:number}):Promise<{revision:number}>;
    list():Promise<{revision:number;keys:string[]}>;
  };
  sexpr:{
    parse(text:string):PCBJamSNode[];
    print(forms:PCBJamSNode[]):string;
    /** Structural item changes, not electrical/semantic validation. */
    diff(before:string,after:string):{added:string[];updated:string[];removed:string[];layoutChanged:boolean};
  };
  files:{
    choose(options:{extensions:('.kicad_sym'|'.kicad_mod'|'.txt'|'.json')[]}):Promise<{handle:string;name:string;size:number}|null>;
    readText(handle:string):Promise<string>;
    close(handle:string):Promise<null>;
    /** Confirms browser download handoff, not successful saving to disk. */
    save(proposal:{name:string;text:string}):Promise<{status:'download-requested'|'cancelled'}>;
    /** A standalone .html page (needs `files:save-html`), at most 8 MiB. PCBJam writes a network-blocking
     *  policy before your first byte: inline scripts, inline styles and data:/blob: images, fonts and media
     *  work; anything loaded from or sent to a server does not. Build the page in logic, not in ui.html. */
    saveHtml(proposal:{name:string;html:string}):Promise<{status:'download-requested'|'cancelled'}>;
    /** A .png from base64 (no data: prefix), at most 4 MiB decoded; anything that is not a PNG is refused. */
    saveImage(proposal:{name:string;base64:string}):Promise<{status:'download-requested'|'cancelled'}>;
    /** Download a ZIP made with `pcbjam.exports.bundle` (needs `files:save`), at most 32 MiB, after the user confirms. */
    saveBundle(proposal:{bundleId:string}):Promise<{status:'download-requested'|'cancelled'}>;
  };
  /** Server-side KiCad exports of the open document (needs `project:export`; hosted PCBJam, saved projects).
   *  `gerbers`, `drill`, `ipc356` and `fab-components` run in the PCB editor. Output bytes stay on the server:
   *  you get ids, file names and sizes, can read small JSON outputs, and can zip exports for download. */
  exports:{
    run(kind:'gerbers'|'drill'|'ipc356'|'fab-components'):Promise<{exportId:string;kind:string;files:{name:string;size:number}[]}>;
    /** A JSON output of an export, at most 1 MiB (e.g. `fab-components.json`). */
    readJson(exportId:string,name:string):Promise<PCBJamJSON>;
    /** Zip exports with text files you made (≤ 16 files, ≤ 2 MiB); `rename` maps an export's file names. */
    bundle(proposal:{parts:{exportId:string;rename?:Record<string,string>}[];extraFiles?:{name:string;text:string}[];zipName:string}):Promise<{bundleId:string;name:string;size:number;files:{name:string;size:number}[]}>;
  };
  board:{
    /** PCB editor only. The open board as shapes the editor computed, so you draw polygons instead of re-deriving
     *  pads, arcs and text: `board` (bbox, outline polygons, net names when tracks/zones are included), one record per
     *  footprint (ref, value, side, pos, angle, bbox, attrs, fields, pads with per-side polygons and hole polygons,
     *  drawings on silkscreen/fab/courtyard tagged reference|value|field|text), board drawings, and with `include`
     *  tracks/vias and zone fills. Millimetres, KiCad axes (Y down), degrees. Fetched in slices like
     *  documents.export(): rejects if the document changes; pass `onRecords` to process batches without keeping them. */
    geometry(options:PCBJamDocumentRef & {include?:('tracks'|'zones')[]},onRecords?:(records:PCBJamGeometryRecord[])=>unknown|Promise<unknown>):Promise<{revision:number;board:PCBJamGeometryRecord|null;footprints:PCBJamGeometryRecord[];drawings:PCBJamGeometryDrawing[];tracks:PCBJamJSON[];zones:PCBJamGeometryRecord[];count:number}>;
  };
  editor:{
    /** Confirms native tool handoff, not successful parsing/placement/saving. */
    requestPlacement(proposal:{label:string;sexpr:string}):Promise<{status:'placed'|'queued'|'cancelled'}>;
    /** Replace the editor selection with up to 500 items of the current document (`[]` clears it). Needs
     *  `editor:select`. `held` items are selected by a collaborator right now and were left alone; `missing`
     *  ids are not in the document. Rejects while the user has a tool running. */
    select(options:{document:string;ids:string[]}):Promise<{selected:string[];held:string[];missing:string[]}>;
  };
  randomUUID():string;
};
