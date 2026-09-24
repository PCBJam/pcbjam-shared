# Available APIs

**Plugin SDK v1.** Call `pcbjam` from plugin logic. All host methods return
promises; failures reject them. Use `(await pcbjam.context.get()).methods` to
check which operations the current editor, account and permissions allow.

Download [sdk.d.ts](download/sdk.d.ts) for full argument and response types.
Below, `ref` means `{document, revision}` from `documents.getCurrent()`;
`page` means optional `{cursor, limit}` (defaults: 0 and 50).
The `types` filter in `items.list()` is also optional.

## Host methods

Add the listed permission to your manifest, alongside the two required UI
permissions. `context.get()` needs no additional permission.

<!-- BEGIN GENERATED HOST API -->
| Call (`await pcbjam.…`) | Permission | Result |
|---|---|---|
| `http.request(endpointId, {method, path, json?})` | `network:<id>`; plus `backend:identity:<id>` for identity | Send bounded JSON to an operator-approved endpoint; optionally carries a signed user identity. |
| `context.get()` | None extra | Editor name, read-only state, supported host methods and limits. |
| `project.getInfo()` | `project:read-info` | Current project ID, scope, name and editor read-only state. |
| `documents.list(page)` | `project:read-info` | Paged project design-file names; defaults cursor 0, limit 50. |
| `documents.getCurrent()` | `documents:read` | Current document handle, name, revision and read-only state. |
| `documents.snapshot(ref)` | `documents:read` | Bounded canonical content at an exact document revision. |
| `documents.poll({document, since})` | `documents:read` | Whether content changed since a revision; no event subscription. |
| `documents.exportStart({...ref, types, omit, layout, libSymbols})` | `documents:read` | Used by `documents.export()`: begins a whole-document read pinned to this revision. One per running plugin. |
| `documents.exportRead({export})` | `documents:read` | Used by `documents.export()` and `board.geometry()`: the next slice of newline-delimited JSON records and whether it was the last. |
| `board.geometryStart({...ref, include})` | `documents:read` | Used by `board.geometry()` (PCB editor): begins a read of the board as engine-computed shapes, pinned to this revision. |
| `items.list({...ref, ...page, types})` | `documents:read` | Paged item IDs, types and parents at an exact revision; optional type filter. |
| `items.get({...ref, ids, partial?})` | `documents:read` | Canonical bodies for up to 100 unique item IDs in the current document. With `partial: true`, oversized items return `{id, error}` instead of failing the call. |
| `selection.get()` | `editor:read-selection` | Current item IDs, document revision and separate selection revision. |
| `editor.select({document, ids})` | `editor:select` | Replace the editor selection; items a collaborator holds are reported as `held` and left alone. |
| `storage.get(key)` | `storage:local` | Value, found flag and namespace revision for a key. |
| `storage.set({key, value, expectedRevision})` | `storage:local` | Write JSON with expectedRevision; return the new namespace revision. |
| `storage.delete({key, expectedRevision})` | `storage:local` | Delete a key with expectedRevision; return the new namespace revision. |
| `storage.list()` | `storage:local` | Sorted keys and namespace revision; never another plugin’s namespace. |
| `files.choose({extensions})` | `files:choose` | Trusted file picker; returns a temporary handle or null on cancellation. |
| `files.readText(handle)` | `files:choose` | Read a chosen file through its instance-bound handle. |
| `files.close(handle)` | `files:choose` | Release a file handle; resolves to null. |
| `files.save({name, text})` | `files:save` | Trusted text download confirmation; download-requested or cancelled. |
| `files.saveHtml({name, html})` | `files:save-html` | Trusted download confirmation for a standalone web page; PCBJam prepends a policy that blocks all network access from the saved file. |
| `files.saveImage({name, base64})` | `files:save` | Trusted download confirmation for a PNG; bytes that are not a PNG are refused. |
| `exports.run({kind})` | `project:export` | Run a KiCad export (`gerbers`, `drill`, `ipc356`, `fab-components`) of the open document on PCBJam’s servers; returns an export id and its file names and sizes. The bytes stay on the server. |
| `exports.readJson({exportId, name})` | `project:export` | Read a JSON output of an export (at most 1 MiB), e.g. the `fab-components` component list. |
| `exports.bundle({parts, extraFiles?, zipName})` | `project:export` | Zip exports (optionally renaming files) with text files the plugin made; returns a bundle id, name, size and file list. |
| `files.saveBundle({bundleId})` | `files:save` | Trusted download confirmation for a bundle ZIP; download-requested or cancelled. |
| `editor.requestPlacement({label, sexpr})` | `editor:place-items` | Confirmed symbol placement: placed or cancelled. |
<!-- END GENERATED HOST API -->

## Permissions

What the user is shown, and approves, when installing. Request only what your
feature uses: every extra line is a reason to decline.

<!-- BEGIN GENERATED PERMISSIONS -->
| Permission | Shown to the user as | Calls it unlocks |
|---|---|---|
| `ui:custom` | Run a custom interface in a sandboxed iframe | — |
| `ui:project-data` | Disclose plugin results to its custom interface | — |
| `files:choose` | Read local files you explicitly choose for this plugin | `files.choose`, `files.readText`, `files.close` |
| `files:save` | Request a text, image or ZIP file download, confirmed by you | `files.save`, `files.saveImage`, `files.saveBundle` |
| `files:save-html` | Request a web page download, confirmed by you; the page contains this plugin's code, which runs when you open the file | `files.saveHtml` |
| `editor:place-items` | Request item placement, confirmed by you in the editor | `editor.requestPlacement` |
| `project:read-info` | Read metadata and file names in the current project | `project.getInfo`, `documents.list` |
| `documents:read` | Read the current editor document, including all its items and embedded symbols | `documents.getCurrent`, `documents.snapshot`, `documents.poll`, `documents.exportStart`, `documents.exportRead`, `board.geometryStart`, `items.list`, `items.get` |
| `editor:read-selection` | Read selected item IDs in the current editor | `selection.get` |
| `editor:select` | Change which items are selected in the current editor | `editor.select` |
| `storage:local` | Store local data for this plugin, account and project | `storage.get`, `storage.set`, `storage.delete`, `storage.list` |
| `project:export` | Generate export files such as Gerbers, drill files and netlists from the current document on PCBJam's servers | `exports.run`, `exports.readJson`, `exports.bundle` |
<!-- END GENERATED PERMISSIONS -->

`network:<name>` and `backend:identity:<name>` are declared per backend; see
[Backend requests](#backend-requests).

## SDK helpers

These execute inside QuickJS; they do not grant additional access.

| Helper | Purpose |
|---|---|
| `pcbjam.handle(name, handler)` | Register a UI-callable command; up to 32. |
| `pcbjam.randomUUID()` | Generate a UUID for proposed items. |
| `pcbjam.sexpr.parse(text)` | Parse s-expressions into nested arrays; atoms retain their spelling and quotes. |
| `pcbjam.sexpr.print(forms)` | Serialize those arrays; original whitespace is not preserved. |
| `pcbjam.sexpr.diff(before, after)` | Return added/updated/removed UUIDs and `layoutChanged`; compares structure, not electrical correctness. |
| `await pcbjam.documents.getSexpr(ref)` | Read a snapshot, serialize it in QuickJS, return `{revision, text}`. Requires `documents:read`. |

In the UI, `await pcbjamUI.call(command, params)` invokes a registered handler
and returns its JSON result. It waits for connection automatically;
`pcbjamUI.ready` is also available. One UI command may be outstanding at a time.

## Read the current document

Requires `documents:read`:

```js
pcbjam.handle('inspect', async () => {
  const { document, revision } = await pcbjam.documents.getCurrent();
  return pcbjam.items.list({ document, revision, limit: 50 });
});
```

The result contains `{revision, items, nextCursor}`. Each item summary has
`{id, type, parent}`. Pass `nextCursor` as `cursor` with the **same revision**
to continue; `null` means finished. If the document changes, reread its revision
and restart paging.

### Item bodies

`items.get()` and `documents.export()` return items as
`{id, type, parent, body}`. They are the KiCad file, split at every form that
has its own `uuid`:

- `type` is the form's keyword: `symbol`, `wire`, `label`, `footprint`, `pad`,
  `property`, … `parent` is the enclosing item's id, or `null` at the top level.
- `body` is the form's content in file order, as slots:
  - `{atom}`: a bare value, **verbatim**: strings keep their quotes (`"\"R1\""`),
    numbers stay text (`"1.27"`).
  - `{k, v}`: a child form `(k …)` without its own uuid, with `v` as slots again.
  - `{item}`: a child form that has its own uuid, returned as a separate item
    with this id.

A placed schematic symbol keeps its properties inline:

```json
{"id": "a111…", "type": "symbol", "parent": null, "body": [
  {"k": "lib_id", "v": [{"atom": "\"Device:R\""}]},
  {"k": "at", "v": [{"atom": "100"}, {"atom": "50"}, {"atom": "0"}]},
  {"k": "uuid", "v": [{"atom": "\"a111…\""}]},
  {"k": "property", "v": [{"atom": "\"Reference\""}, {"atom": "\"R1\""}, {"k": "at", "v": […]}]},
  {"k": "property", "v": [{"atom": "\"Value\""}, {"atom": "\"10k\""}, {"k": "at", "v": […]}]},
  {"item": "b222…"}
]}
```

`{"item": "b222…"}` is the symbol's `pin`, a separate item with
`parent: "a111…"`. In a board saved by KiCad 8 or later, a footprint's
properties have their own uuid, so they are separate items of type `property`
whose `parent` is the footprint:

```json
{"id": "c333…", "type": "footprint", "parent": null, "body": [
  {"atom": "\"Resistor_SMD:R_0603_1608Metric\""},
  {"k": "layer", "v": [{"atom": "\"F.Cu\""}]},
  {"k": "uuid", "v": [{"atom": "\"c333…\""}]},
  {"item": "e444…"}, {"item": "f555…"}
]}
{"id": "e444…", "type": "property", "parent": "c333…", "body": [
  {"atom": "\"Reference\""}, {"atom": "\"R1\""}, {"k": "layer", "v": [{"atom": "\"F.SilkS\""}]}, …
]}
```

Reading Reference, Value and Footprint of every schematic symbol, handling both
shapes:

```js
const unquote = atom => atom.startsWith('"') ? JSON.parse(atom) : atom;
const ref = await pcbjam.documents.getCurrent();
const { items } = await pcbjam.documents.export(
  { document: ref.document, revision: ref.revision, types: ['symbol', 'property'] });
const fields = new Map(); // item id → {Reference, Value, Footprint, …}
const take = (owner, slots) => {
  const [name, value] = slots.filter(slot => 'atom' in slot).map(slot => unquote(slot.atom));
  if (!fields.has(owner)) fields.set(owner, {});
  fields.get(owner)[name] = value;
};
for (const item of items) {
  if (item.type === 'property' && item.parent) take(item.parent, item.body);        // child item (board)
  for (const slot of item.body) if (slot.k === 'property') take(item.id, slot.v);   // inline (schematic)
}
const parts = items.filter(item => item.type === 'symbol').map(item => ({ id: item.id, ...fields.get(item.id) }));
```

Power symbols have references starting with `#` (`#PWR01`); skip them for a
parts list. A multi-unit part appears once per placed unit with the same
Reference. On a board, `board.geometry()` already gives you `ref`, `value` and
`footprint` per footprint.

A large filled zone can exceed the response limit by itself. By default that
fails the whole `items.get()` call. Pass `partial: true` and such an entry comes
back as `{id, error}` while the other items are returned normally:
`TOO_LARGE` means the item cannot be read through this call at all;
`DEFERRED` means it did not fit in what was left of this response, so request
it again, alone or in a smaller batch. An unknown ID still fails the call.

### Read a whole board

`documents.snapshot()` is limited to 1 MiB, which a real PCB rarely fits. Use
`documents.export()` for the whole document:

```js
const ref = await pcbjam.documents.getCurrent();
const byType = {};
const result = await pcbjam.documents.export(
  { document: ref.document, revision: ref.revision, types: ['footprint', 'pad'], omit: ['filled_polygon'] },
  items => { for (const item of items) byType[item.type] = (byType[item.type] ?? 0) + 1; },
);
```

The editor copies the document a few milliseconds at a time and rests in
between, so the user's editor stays responsive however large the board is; one
huge zone is spread over several slices. Consequences for your code:

- Pass `onItems` for big boards. Each batch is delivered once and not kept, so
  convert it to your own compact form and let it go. Without `onItems`, all
  items are collected into `result.items`, which must fit the 64 MiB heap.
- `types` keeps only those item types. `omit` drops child forms by name at any
  depth. Zone fills (`filled_polygon`) are most of a large board's bytes: omit
  them unless you draw them.
- The export is pinned to `revision`. If the document changes, it rejects with
  `Document changed…`; read the new revision and start again.
- One export runs at a time per plugin; starting another abandons the first.
  The total is capped at 32 MiB of JSON text.
- `layout: true` and `libSymbols: true` add the top-level order and embedded
  library symbols, as in a snapshot.

### Draw the board

In the PCB editor, `board.geometry()` gives you the board as shapes the editor
already computed. You fill polygons; you do not reconstruct rounded or rotated
pads, arcs, or text (text in an outline font cannot be reconstructed from file
data at all).

```js
const ref = await pcbjam.documents.getCurrent();
const { board, footprints, drawings } = await pcbjam.board.geometry(
  { document: ref.document, revision: ref.revision },  // include: ['tracks', 'zones'] to add copper
);
for (const fp of footprints)
  for (const pad of fp.pads)
    for (const polygon of pad.polygons[fp.side] ?? []) fill(polygon.outline, polygon.holes);
```

| Record | Contents |
|---|---|
| `board` | `bbox` `[x1,y1,x2,y2]`, `outline` polygons (empty if the edge cuts do not close), `footprints` count, `nets` `{code: name}` when tracks or zones are included. |
| footprint | `id`, `ref`, `value`, `footprint` (library id), `side` `'F'`/`'B'`, `pos`, `angle`, `bbox`, `attrs` `{smd, tht, dnp, excludeFromBom, excludeFromPos, boardOnly}`, `fields` (all, including hidden ones), `pads`, `drawings`. |
| pad | `id`, `number`, `net` (name), optional `pinFunction`, `type` `'smd'`/`'tht'`/`'npth'`/`'connector'`, `pos`, `polygons` `{F: [...], B: [...]}` for the copper sides it is on, optional `hole` polygons. |
| drawing | `layer` (`F.SilkS`, `B.SilkS`, `F.Fab`, `B.Fab`, `F.CrtYd`, `B.CrtYd`, `Edge.Cuts`), `polygons`, and for text `text`: `'reference'`, `'value'`, `'field'` or `'text'`. Line width is already part of the polygon. Hidden text is left out. |
| track item | `{layer, width, start, end, net}`; an arc has `polygons` instead of `start`/`end`; a via is `{via, diameter, drill, net}`. `net` is a code into `board.nets`. |
| zone | `id`, `layer`, `net`, `polygon`: one record per filled outline. |

A polygon is `{outline: [[x, y], …], holes?: [[[x, y], …], …]}`. Lengths are
millimetres, axes are KiCad's (Y grows downwards), angles are degrees. A ring
such as an unfilled circle may arrive as one outline with a slit instead of an
outline plus a hole; fill it the same way.

It is delivered in short slices like `documents.export()`, with the same rules:
pinned to `revision` (a changed board rejects with `Document changed…`, start
again), one whole-document read at a time per plugin, 32 MiB in total, and an
`onRecords` callback if you would rather not keep everything.

`onRecords(records)` receives the records as they arrive, each tagged with `$`:
`{$: 'board', …}`, `{$: 'footprint', …}` and `{$: 'zone', …}` carry the fields
above directly, but drawings and tracks come wrapped: `{$: 'drawing', item}`
holds one drawing in `item`, and `{$: 'tracks', items}` holds a batch of track
items. Without `onRecords` these are unwrapped for you into `result.drawings`
and `result.tracks`.

```js
await pcbjam.board.geometry({ ...ref, include: ['tracks'] }, records => {
  for (const record of records) {
    if (record.$ === 'drawing') draw(record.item.layer, record.item.polygons);
    else if (record.$ === 'tracks') for (const track of record.items) drawTrack(track);
  }
});
``` It needs only
`documents:read`: it is the same board, in a different form. It is absent from
`context.get().methods` in the schematic editor and on editor builds that
predate it.

Handles and revisions belong to this running instance. Only the active document
is readable; `documents.list()` lists project file names without opening them.
Responses are copies of design content, excluding comments, presence and
credentials. Editing a returned object does not edit the project.

## Store a setting

Requires `storage:local`:

```js
pcbjam.handle('saveSettings', async () => {
  const previous = await pcbjam.storage.get('settings');
  return pcbjam.storage.set({
    key: 'settings',
    value: { unit: 'mm' },
    expectedRevision: previous.revision
  });
});
```

The host selects the account/project/plugin namespace. A missing key returns
`{found: false, value: null, revision}`. Revisions cover the whole namespace:
on a competing write, read again before retrying. Keys use 1–64 letters, digits,
dots, underscores or hyphens and start with a letter/digit. Values must be JSON.
Storage is browser-local, can be evicted, and is not a secret store.

## Files and placement

File selection, downloads and placement approval use **PCBJam-owned controls**.

- `files.choose()` accepts `.kicad_sym`, `.kicad_mod`, `.txt` and `.json`.
  Cancellation returns `null`. Read the returned handle with `readText()`;
  release it with `close()`. Handles expire when the instance stops.
- `files.save()` accepts a basename ending in `.txt`, `.json`, `.csv`,
  `.kicad_sym`, `.kicad_mod`, `.kicad_sch` or `.kicad_pcb`.
  It returns `{status: 'download-requested'}` or `{status: 'cancelled'}`;
  download handoff is not proof of a saved file.
- `files.saveHtml({name, html})` saves a standalone `.html` page, up to 8 MiB,
  and needs the separate `files:save-html` permission because the page contains
  your code. PCBJam writes a policy line before your first byte that blocks all
  network access from the saved file: inline scripts, inline styles and `data:`
  or `blob:` images, fonts and media work; CDN scripts, web fonts, remote
  images, `fetch` and form posts do not. Inline everything. Build the page in
  logic (`main.js`): a message from `ui.html` to logic is limited to 64,000
  characters of JSON, including the command name.
- `files.saveImage({name, base64})` saves a `.png` of up to 4 MiB under
  `files:save`. Pass plain base64 without a `data:` prefix; bytes that are not
  a PNG are refused.
- A plugin UI cannot start a download by itself; every file goes through the
  user's confirmation above.
- `editor.select({document, ids})` replaces the user's selection with up to 500
  items of the current document; an empty list clears it. It returns
  `{selected, held, missing}`. In a shared session a selection also claims the
  item, so anything a collaborator has selected right now is left alone and
  listed in `held` — show that to the user rather than treating it as an
  error. `missing` ids are not in the document. The call rejects while the
  user has an editor tool running (a move, a route), and the selection changes
  just after the call returns: read it back with `selection.get()` if you need
  to confirm. Selecting is available in read-only sessions too.
- `editor.requestPlacement()` accepts a bounded, self-contained schematic symbol
  with an embedded definition. It requires a writable schematic and enabled
  placement capability. It resolves to `{status: 'placed'}` after the user's
  canvas click and native commit, or `{status: 'cancelled'}`; errors reject.
  Local development editors that run plugins without the PCBJam server resolve
  `{status: 'queued'}` as soon as the symbol is handed to the placement tool,
  before the click: treat it like `placed` and do not wait for a second result.
  Show instructions while waiting: approve, then click the canvas or press Esc.
  Normal Undo and collaboration apply. Use the downloadable starter for the
  clipboard format. Footprint placement, external resources, simulation fields
  and unresolved inheritance are rejected.

## Limits

| Resource | Current limit |
|---|---|
| Snapshot or item response | 1 MiB serialized JSON; use small item batches for large designs. |
| Item page / explicit item batch | 100 items; documents over 50,000 items are refused. |
| File catalog / selection | 5,000 catalog entries; 1,000 selected IDs. |
| Plugin-made selection | 500 items per call. |
| Chosen file / text download | 4 MiB / 512 KiB. |
| Web page / image download | 8 MiB of HTML including PCBJam's policy line / 4 MiB PNG. |
| Storage | 64 keys, 16 KiB per value, 256 KiB per namespace. |
| Parse, print and diff | 524,288 input/output characters as applicable, 48 nesting levels, 12,000 forms. |
| Document serialization | 1,048,576 output characters; CPU budget still applies. |
| Private uploads | 32 retained releases, 64 MiB per account. |
| Response structure | 100,000 JSON nodes, 48 nesting levels. |
| Host calls | 40 per 10 seconds per running plugin. Calls over that are **delayed, not rejected**, so a sequential read loop simply slows down. At most 4 calls may be in flight: `await` each one. A fifth is rejected with `Too many pending API calls`. |
| UI commands | 20 per 10 seconds, 64,000 characters of JSON each (the whole message, command name included), one at a time; exceeding this stops the plugin. Pace them with timers in `ui.html`. |
| Whole-document export | 32 MiB of JSON text; slices of at most 256 KiB after at most 8 ms of copying, each followed by an equal rest. Not counted in the host-call window. |
| Command duration | 120 seconds from UI command to result, including delayed host calls. |
| Account request budget | Shared by all your running plugins and tabs. When exhausted, host calls wait for the next minute once, then fail with `error.code === 'RATE_LIMITED'`; the plugin keeps running. |

The same numbers are in `(await pcbjam.context.get()).limits`:

| Field | Meaning |
|---|---|
| `snapshotBytes`, `responseBytes`, `responseNodes` | One response: 1 MiB of JSON, 100,000 nodes. |
| `pageItems` | Items per `items.list()` page or `items.get()` batch (100). |
| `fileBytes` | A file read with `files.readText()` (4 MiB). |
| `exportBytes` | A **text download** through `files.save()` (512 KiB). Not the document export. |
| `exportSliceMs`, `exportSliceChars`, `exportTotalChars` | Whole-document reads (`documents.export()`, `board.geometry()`): 8 ms and 256 KiB per slice, 32 MiB in total. |
| `htmlBytes`, `imageBytes` | `files.saveHtml()` page (8 MiB) and `files.saveImage()` PNG (4 MiB). |
| `storageBytes`, `storageValueBytes`, `storageKeys` | Storage namespace (256 KiB), one value (16 KiB), keys (64). |
| `selectItems` | Items per `editor.select()` call (500). |
| `hostCallsPerWindow`, `hostCallWindowMs`, `pendingHostCalls` | 40 host calls per 10 s (then delayed), at most 4 in flight. |
| `readLeaseMs` | How long an access check is reused for plain reads (2 s). |
| `uiCommandsPerWindow`, `uiCommandWindowMs`, `uiCommandBytes` | 20 UI commands per 10 s, 64,000 characters each. |
| `commandTimeoutMs` | 120 s from UI command to result. |

Plugin logic has `setTimeout` and `clearTimeout` (no `setInterval`), for pausing
between steps: `await new Promise(done => setTimeout(done, 200))`. They work only
while a command is being handled; up to 32 may be pending, each at most 60
seconds, and all are cancelled when the command settles, so logic never runs in
the background. An exception thrown from a timer callback stops the plugin.
You do not need timers to stay under the host-call rate: the host delays for you.

### Argument rules

Arguments are checked before a call reaches the editor; a call that breaks one
rejects with `Invalid API arguments` and does nothing.

| Where | Rule |
|---|---|
| `pcbjam.handle(name, …)` | `name` matches `^[a-z][a-zA-Z0-9.:-]{0,63}$`; at most 32 commands; each name once. |
| `files.save`, `files.saveHtml`, `files.saveImage` `name` | `^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,90}\.<ext>$`: starts with a letter or digit, no slashes, the method's own extensions only. |
| `files.save` `text` | 512 KiB. |
| `files.choose` `extensions` | 1–4 of `.kicad_sym`, `.kicad_mod`, `.txt`, `.json`. |
| `editor.select` `ids` | Up to 500 distinct ids, each at most 64 characters. |
| `items.get` `ids` | 1–100 distinct ids, each at most 128 characters. |
| `items.list` / `documents.export` `types`, `omit` | At most 8 each, each `^[a-zA-Z0-9_-]{1,64}$`. |
| `storage` keys | `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`. |
| `editor.requestPlacement` | `label` 1–100 characters, `sexpr` up to 512 KiB. |
| Any call | Only the listed keys: an unknown key is refused. |

## Debugging and errors

- **No `console` in logic.** Plugin logic runs in QuickJS with only the
  `pcbjam` API, JSON, `setTimeout`/`clearTimeout` and the standard JavaScript
  built-ins (ES2023); there is no `console`, `Intl`, DOM, `fetch` or Node.js
  API, and calling `console.log` throws. `localeCompare` ignores locale
  options, so sort natural numbers (`R2` before `R10`) yourself. Return diagnostic data from a command and show it in
  your UI, where the browser's developer tools work as usual.
- **Errors reach the UI as text.** A handler that throws rejects the UI's
  `pcbjamUI.call()` with the message, cut to 400 characters. Host call failures
  carry `error.message` and, for policy failures, `error.code`.
- **Argument errors are short on purpose.** A malformed call rejects with
  `Invalid API arguments` without naming the field; compare it with the table
  above and `sdk.d.ts`.
- **What stops the plugin** (the panel shows "Plugin stopped" and you restart
  it from **Plugins**):
  - a command handler returns while one of its host calls is still in flight
    (always `await` host calls);
  - a fifth host call in flight;
  - more than 20 UI commands in 10 s, or a UI message over 64,000 characters;
  - the UI iframe navigating or reloading itself;
  - the UI not connecting within 10 seconds of opening;
  - a turn of logic running longer than 1 second of CPU, or logic using more
    than 64 MiB of memory;
  - an exception thrown from a timer callback;
  - the user's access to the plugin, project or document ending.

| Message or `code` | Meaning | What to do |
|---|---|---|
| `Permission denied: <permission>` | The manifest does not request it. | Add the permission and publish a new version. |
| `API unavailable in this context` | Not in `context.get().methods` here (editor, build, read-only). | Feature-detect before offering it. |
| `Invalid API arguments` | An argument breaks a rule above. | Fix the call. |
| `Document changed: …` | The document moved on during a pinned read. | Read `documents.getCurrent()` again and restart. |
| `Too many pending API calls` | More than 4 host calls in flight. | `await` each call. |
| `RATE_LIMITED` | Account request budget exhausted after one wait. | Back off; the plugin keeps running. |
| `Export exceeds size limit` | A read or download is over its limit. | Narrow with `types`/`omit`, or save less. |
| `Plugin CPU budget exceeded` | One turn of logic ran over 1 s. | Split work across `await`s or timers. |
| Backend codes (`BACKEND_NOT_APPROVED`, …) | See [Backend requests](#backend-requests). | |

## Exports (Gerbers, drill files, netlists)

With `project:export`, a plugin in the PCB editor can have PCBJam run KiCad's
own exporters on the saved project (including unsaved collaborative edits) on
PCBJam's servers. The files stay on the server: you get ids, names and sizes,
and the user downloads a ZIP after confirming.

```ts
const gerbers = await pcbjam.exports.run('gerbers');        // {exportId, kind, files: [{name, size}]}
const drill = await pcbjam.exports.run('drill');
const fab = await pcbjam.exports.run('fab-components');
const parts = await pcbjam.exports.readJson(fab.exportId, 'fab-components.json');
const bundle = await pcbjam.exports.bundle({
  parts: [{ exportId: gerbers.exportId }, { exportId: drill.exportId }],
  extraFiles: [{ name: 'bom.csv', text: makeBom(parts) }],
  zipName: 'board.zip',
});                                                           // {bundleId, name, size, files}
await pcbjam.files.saveBundle({ bundleId: bundle.bundleId }); // needs files:save
```

- Kinds: `gerbers` (one file per enabled layer plus a `.gbrjob`, KiCad's
  defaults), `drill` (Excellon, metric), `ipc356` (`netlist.ipc`) and
  `fab-components` (board size, origins, copper layers and every footprint with
  position, rotation, side, attributes and fields, as `fab-components.json`).
- `readJson` reads JSON outputs up to 1 MiB. `bundle` takes up to 8 exports,
  can rename their files (`rename: {'netlist.ipc': 'my.ipc'}`), and adds up to
  16 text files of up to 2 MiB in total; the ZIP is at most 32 MiB. File names
  in one ZIP must be unique.
- Exports and bundles belong to the running plugin instance and expire after an
  hour. Each export runs KiCad on the server: at most 12 per minute per plugin
  and 24 per account. Errors: `EXPORT_FAILED` (KiCad could not export the
  board, with its reason) and `EXPORT_UNAVAILABLE` (the export service is busy;
  retry shortly).
- Available only on hosted PCBJam with a saved project, in the PCB editor.
  `context.get().methods` lists `exports.run` when it is available.

## Not available

There is no raw WASM/pointer access, direct Yjs mutation, sibling-document loading,
change subscription, schematic geometry, user-profile API, OAuth delegation
signing. The only current document write is confirmed symbol placement;
`editor.select()` changes the selection, not the design.
The only UI surface is a floating panel in the schematic or PCB editor.

[Build a plugin](0008-local-plugin-development.md) ·
[Architecture](0010-plugin-security-and-testing.md).

## Backend requests

Declare the exact destination in `manifest.json` and include both grants in
`permissions` for identity-bearing requests:

```json
{
  "endpoints": {
    "backend": {
      "origin": "https://api.your-domain.example",
      "paths": ["/v1/preferences"],
      "methods": ["GET", "POST"],
      "auth": "pcbjam-user"
    }
  },
  "permissions": ["ui:custom", "ui:project-data", "network:backend", "backend:identity:backend"]
}
```

```ts
const response = await pcbjam.http.request('backend', {
  method: 'POST', path: '/v1/preferences', json: { library: 'My library' }
});
// { status, headers: { 'content-type': 'application/json' }, body }
```

One endpoint, up to 16 exact paths; HTTPS port 443 only. No query strings,
redirects, percent-encoded paths, custom headers or arbitrary URLs. `GET` has no
`json`; `POST` requires it. `auth: "none"` only needs the network grant and sends
no identity. Network permission allows sending data the plugin can read.

The full request is limited to 128 KiB and the uncompressed JSON response to
256 KiB; deadline 30 seconds. Limits: two concurrent calls per activation, four
per account, 20/minute per account/plugin and 60/minute per account. A returned
HTTP error status is still a response; transport/policy failures reject with an
`Error`, optionally carrying `code` (for example `BACKEND_NOT_APPROVED`,
`DOMAIN_NOT_VERIFIED`, `RATE_LIMITED`, `DESTINATION_DENIED`, `UPSTREAM_TIMEOUT`,
`REDIRECT_DENIED`, `RESPONSE_TOO_LARGE`, `INVALID_RESPONSE`). Do not blindly retry
writes: a timeout can follow a successful backend write.

With `pcbjam-user`, PCBJam attaches a 60-second ES256 assertion on the server.
Your backend uses the starter verifier with fixed issuer, audience and plugin UUID.
It checks the exact method, URL and raw body, then atomically rejects reused
request IDs in shared durable storage. Key data by verified `(issuer, subject)`;
the subject is stable for this user/plugin, without exposing their email or
PCBJam account ID. Keep the raw request bytes until verification. JWT decoding
alone is not verification. Never accept a fallback user ID from plugin input.

[Download backend source and verifier](download/backend-preferences-source.zip).
