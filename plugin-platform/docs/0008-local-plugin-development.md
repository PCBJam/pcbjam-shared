# Build a plugin

**Plugin SDK v1.** Create your plugin in a folder on your computer; using Git is
optional. Sign into PCBJam to install it. You do not need PCBJam's source code.

## Get access

Plugins are enabled per PCBJam account. Before your first upload:

1. Sign up at PCBJam with the account you will develop with.
2. Ask for plugin access on the [PCBJam Discord](https://discord.gg/ybhqJxjR3E):
   post the email address of that account and one line about what you are
   building. PCBJam enables access on that account; until then **Plugins → Add
   plugin…** refuses uploads.
3. Every teammate who installs your plugin needs access on their own account
   too (see [Share a plugin](#share-a-plugin)).

A [backend](#authentication-and-permissions) or a
[Remote Symbols provider](remote-symbols.md) also needs a one-time review by
PCBJam; ask for it in the same place. The Discord is also where to ask
questions and report problems with the SDK.

## What a plugin can do

| You want to… | Use | Permission |
|---|---|---|
| Read the open schematic or board, including very large ones | `documents.export()`, or `items.list()` / `items.get()` for a few items | `documents:read` |
| Draw the board without doing geometry yourself (pads, arcs and text arrive as polygons) | `board.geometry()`, PCB editor only | `documents:read` |
| Know what the user selected, or select parts for them | `selection.get()`, `editor.select()` | `editor:read-selection`, `editor:select` |
| Give the user a file: CSV, JSON, a KiCad file, a PNG | `files.save()`, `files.saveImage()` | `files:save` |
| Give the user a standalone web page that works offline | `files.saveHtml()` | `files:save-html` |
| Read a file the user picks | `files.choose()`, `files.readText()` | `files:choose` |
| Remember settings per project | `storage.*` | `storage:local` |
| Place a symbol in a schematic | `editor.requestPlacement()` | `editor:place-items` |
| Call your own server | `http.request()` | `network:<name>`, after PCBJam approves the routes |
| Offer your parts catalog in the schematic editor, KiCad 10 Remote Symbols style | a `remote-provider` package, no code: [Remote Symbols](remote-symbols.md) | `provider:embed`, `provider:download`, `editor:place-items` |

Every call, its arguments and its limits are in [Available APIs](0009-plugin-api-and-permissions.md).
What is deliberately not possible: network access from logic or UI other than
your approved backend, reading projects that are not open, editing the design
other than by confirmed symbol placement, and anything running while no command
is being handled.

## Download and build

Download the [TypeScript + React starter](download/external-symbol-import-source.zip)
to edit, or the [installable example ZIP](download/external-symbol-import.zip)
to try immediately. The example adds a symbol from a local file; its README
contains usage instructions.

With Node.js 22+, run inside the extracted source folder:

```sh
npm ci
npm run build
```

Edit `src/main.ts` for logic and `src/ui/App.tsx` for UI. Change the manifest
ID and name for your own plugin. The build produces `dist/plugin/` and
`dist/<manifest-id>.zip`. Upload either build output, **not the source ZIP**.

## Required files

Every installable package has these three files at its root:

| File | Purpose |
|---|---|
| `manifest.json` | Identity, version, supported editors and requested permissions. |
| `main.js` | Bundled plugin logic. PCBJam supplies the global `pcbjam` API. |
| `ui.html` | UI with inline JavaScript and CSS. PCBJam supplies `pcbjamUI`. |

Optional files: `README.md`, `LICENSE.txt` and `sdk.d.ts`. Other filenames are
rejected. A ZIP may wrap the files in one folder.

TypeScript and React are supported through your local build. Plain JavaScript
and HTML also work. Bundle dependencies into these files: no CDN imports,
separate asset files or uploaded `node_modules`. PCBJam never runs uploaded
build scripts.

| Package limit | Value |
|---|---|
| ZIP size | 8 MiB |
| All files, uncompressed | 12 MiB, at most 32 entries, 4 MiB per file |
| `manifest.json` | 16 KiB |
| `main.js` / `ui.html` | 1 MiB / 512 KiB |
| Paths | letters, digits, `_`, `.`, `-` and `/`; no `..`, no absolute paths |

`ui.html` may not load scripts or stylesheets by URL (`<script src>`,
`<link href>`): the upload is refused.

## Manifest

This minimal manifest contains every required field. It only reads basic editor context:

```json
{
  "apiVersion": 1,
  "id": "my-editor-helper",
  "name": "My Editor Helper",
  "version": "0.1.0",
  "description": "Show the current editor file.",
  "main": "main.js",
  "ui": "ui.html",
  "surfaces": ["editor:eeschema", "editor:pcbnew"],
  "permissions": ["ui:custom", "ui:project-data"]
}
```

| Field | Rules |
|---|---|
| `apiVersion` | `1`. |
| `id` | 3–64 lowercase letters, digits or hyphens; starts with a letter. Keep stable across updates. |
| `name`, `description` | Name: 1–80 characters. Description: up to 300. |
| `version` | `major.minor.patch`, e.g. `0.1.0`. Increase whenever package contents change. |
| `main`, `ui` | Exactly `main.js` and `ui.html`. |
| `surfaces` | Schematic: `editor:eeschema`. Board: `editor:pcbnew`. Choose one or both. |
| `permissions` | Both UI permissions are required. Add only the [API permissions](0009-plugin-api-and-permissions.md) your feature uses. |
| `uiSize` (optional) | Preferred floating window size: `{ "width": 640, "height": 480 }`. Integer CSS pixels; width 280–4096, height 240–4096. |

`ui:custom` allows your iframe UI; `ui:project-data` allows passing logic results
into it. Neither grants document reads. Unknown fields, surfaces and permissions
are rejected.

Without `uiSize`, the window starts at 360 × 560. Dimensions include PCBJam's
header, status bar and confirmation area; the iframe fills the remaining space.
PCBJam fits the window inside the viewport. Users can resize from either bottom
corner (or focus a resize handle and use arrow keys; Shift makes larger steps).
Their chosen size takes precedence over `uiSize` and is remembered per account
and plugin in that browser. Make your UI responsive: resizing preserves its state.

## Write logic and UI

Register commands in `main.js` (or `src/main.ts` when using TypeScript):

```js
pcbjam.handle('describeEditor', async () => {
  const context = await pcbjam.context.get();
  return { fileName: context.fileName };
});
```

Call the command from your UI. This complete `ui.html` works without a build:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My Editor Helper</title></head>
<body>
  <button id="inspect">Which file is open?</button>
  <p id="result" role="status"></p>
  <script>
    const button = document.getElementById('inspect');
    const result = document.getElementById('result');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const data = await pcbjamUI.call('describeEditor');
        result.textContent = data.fileName;
      } catch (error) {
        result.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>
```

React components use the same `pcbjamUI.call()` from event handlers. Keep React
in UI code; logic has no DOM, Node.js or `fetch`. Logic does have `setTimeout`
and `clearTimeout`, but only while it is handling a command: pending timers are
cancelled when the command settles, so nothing runs in the background. Bundle CSS
into `ui.html`; runtime-injected styles are restricted. Embedded `data:` and
`blob:` images work in the UI; images, fonts or scripts from a server do not,
and inline `style="…"` attributes are blocked (set styles from script instead).

A message from the UI to logic is limited to 64,000 characters. Build anything
large, such as a page for `files.saveHtml()`, in logic, from data logic read
itself, and send the UI only what it displays.

Register commands at startup, call host APIs inside handlers, and pass only JSON
arguments/results. Validate incoming arguments. Allow one UI command at a time
and handle errors. The [SDK declarations](download/sdk.d.ts) provide autocomplete.

Inline `style="…"` attributes pass the upload check but are silently ignored
when the UI runs, because the page's security policy only allows the styles and
scripts that were in `ui.html` when it was uploaded. Use classes, or set
`element.style` from script. See [Debugging and errors](0009-plugin-api-and-permissions.md#debugging-and-errors)
for what logic can and cannot do (there is no `console`).

## Example: a parts list that highlights and exports

A board plugin in the style of an interactive BOM: group the parts, draw their
pads, select a group on the board when its row is clicked, and export a
standalone page. It shows the three habits that matter on real boards.

`manifest.json` asks for exactly what it uses:

<!-- example:parts-list manifest.json -->
```json
{
  "apiVersion": 1,
  "id": "parts-list-example",
  "name": "Parts list",
  "description": "Groups parts, highlights them on the board and exports a page.",
  "version": "0.1.0",
  "main": "main.js",
  "ui": "ui.html",
  "surfaces": ["editor:pcbnew"],
  "permissions": ["ui:custom", "ui:project-data", "documents:read", "editor:select", "files:save-html"]
}
```

`main.js`:

<!-- example:parts-list main.js -->
```js
let loaded = null;

// 1. Read in slices and keep only what you need. The callback sees each batch once;
//    nothing is retained for you, which is what lets a large board fit in 64 MiB.
async function load() {
  const ref = await pcbjam.documents.getCurrent();
  const groups = new Map(), parts = [];
  let bbox = null;
  await pcbjam.board.geometry({ document: ref.document, revision: ref.revision }, records => {
    for (const record of records) {
      if (record.$ === 'board') bbox = record.bbox;
      if (record.$ !== 'footprint' || record.attrs.excludeFromBom) continue;
      const key = record.value + '\u0000' + record.footprint;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { value: record.value, footprint: record.footprint, refs: [], ids: [] });
      group.refs.push(record.ref);
      group.ids.push(record.id);
      // Pads are already polygons on the board, in millimetres: no rotation or rounding maths here.
      parts.push({ id: record.id, side: record.side, pads: record.pads.flatMap(pad => (pad.polygons[record.side] ?? []).map(polygon => polygon.outline)) });
    }
  });
  loaded = { document: ref.document, bbox, groups: [...groups.values()], parts };
  return loaded;
}

// 2. The design can change while you read. That is normal: read its new revision and start again.
pcbjam.handle('load', async () => {
  for (let attempt = 0; ; attempt++) {
    try { return await load(); }
    catch (error) { if (attempt >= 3 || !/Document changed/.test(error.message)) throw error; }
  }
});

// `held` parts are selected by a collaborator right now and were left alone: tell the user, it is not an error.
pcbjam.handle('select', ({ ids }) => pcbjam.editor.select({ document: loaded.document, ids }));

// 3. Design text is user data. Escape it before it becomes HTML, in your UI and in anything you export.
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

// Build the page here, in logic: a message from ui.html to logic is limited to 64,000 characters.
// The saved page cannot use the network, so inline everything it needs.
pcbjam.handle('export', async () => {
  const data = loaded ?? await load();
  const rows = data.groups.map(group => `<tr><td>${group.refs.length}</td><td>${escapeHtml(group.value)}</td><td>${escapeHtml(group.footprint)}</td><td>${escapeHtml(group.refs.join(', '))}</td></tr>`);
  const html = `<title>Parts list</title><style>td{padding:2px 8px}</style><table><tr><th>Qty</th><th>Value</th><th>Footprint</th><th>References</th></tr>${rows.join('')}</table>`;
  return pcbjam.files.saveHtml({ name: 'parts-list.html', html });
});
```

In `ui.html`, call `pcbjamUI.call('load')`, draw `parts[].pads` on a canvas
(they are closed outlines in millimetres; `bbox` gives you the scale), call
`pcbjamUI.call('select', { ids })` when a row is clicked, and
`pcbjamUI.call('export')` from a button. `export` resolves to
`{status: 'download-requested'}` or `{status: 'cancelled'}`: the user confirms
every download, so treat a cancel as a normal outcome. Check
`(await pcbjam.context.get()).methods` before offering a feature:
`board.geometryStart` exists only in the PCB editor; both it and
`editor.select` are absent on editor builds that predate them.
`editor.select` works in the schematic editor as well.

## Authentication and permissions

**You do not create or embed an API key.** Sign into PCBJam to upload and install.
The user reviews the manifest permissions; PCBJam binds calls to that installation
and checks the user's current project access. Your code receives no login cookie
or access token. Use `pcbjam.context.get()` to discover available methods.

For your own backend, download the [backend starter](download/backend-preferences-source.zip).
Declare one HTTPS origin, exact paths and `GET`/`POST` methods in optional
`endpoints`; request `network:<name>` and, for signed identity,
`backend:identity:<name>`. PCBJam must approve those routes in addition to the
user's installation consent. See [the HTTP API](0009-plugin-api-and-permissions.md#backend-requests).

Upload first, post the plugin UUID shown in the review on the
[PCBJam Discord](https://discord.gg/ybhqJxjR3E), and publish the DNS TXT
challenge PCBJam gives you there. After verification and approval, re-upload
the same ZIP to refresh its status and install it. Configure your backend with
the issuer, audience and plugin UUID PCBJam gives you. The starter includes a
verifier and Postgres replay protection. Your backend verifies the signature and
uses the verified subject as the user ID; it must never trust a user ID in request
JSON. No PCBJam API key is involved. Keep secrets on your backend.

For local backend development use an HTTPS tunnel on a hostname you control;
private IPs, localhost and PCBJam infrastructure destinations are blocked.
Domain verification lasts 30 days. There is no OAuth delegation or public
publisher/marketplace registration yet.

## Install and update

1. Open a supported editor. Choose **Plugins → Add plugin…** in the floating session menu.
2. Choose **Install ZIP** or **Install folder**, then select the compiled package.
3. Review permissions and install. Open the plugin by name from **Plugins**.

Use `npm run dev` for automatic local rebuilds. To test changes, increase
`manifest.version`, build, then upload and approve the new version.
Restart runs the installed version; it does not reload local source.

> **Uploads are limited.** Each account keeps at most **32 releases and 64 MiB**
> of uploads, across all its plugins, and releases cannot be deleted yet. Every
> new version you upload uses one. Re-uploading the same version with the same
> files reuses the existing release; the same version with different files is
> refused. Check your change locally (type check, a small mock of `pcbjam` for
> logic), then upload the versions you actually want to try in PCBJam. Deleting
> old releases and a developer mode that reloads local builds are planned.

Installations are private to your account and follow it across browsers.
`storage:local` settings stay in that browser and project. Disable preserves
settings; reset or uninstall revokes them. Test read-only documents, cancelled
prompts and errors before sharing a package.

## Share a plugin

There is no plugin catalog yet. To let a teammate use your plugin, send them
the compiled ZIP. They need plugin access on their own account
([Get access](#get-access)), upload the ZIP themselves with **Plugins → Add
plugin…**, and approve its permissions; that upload counts against their own
release limit. When you publish a new version, each of them uploads it again.
Backend routes are approved per upload today, so a teammate's copy of a plugin
with a backend needs its own approval: ask on Discord with their plugin UUID.

Next: [Available APIs](0009-plugin-api-and-permissions.md) ·
[Architecture](0010-plugin-security-and-testing.md) ·
[Remote Symbols](remote-symbols.md).
