---
title: Build a plugin
description: "Build, install and share a plugin for PCBJam's schematic and PCB editors, starting from a working example."
created: 2026-09-16
updated: 2026-10-06
slug: plugins
---

This page is for developers who want to add their own tool to PCBJam's
schematic or PCB editor: a parts list, a checker, an exporter, an importer.
At the end you have a plugin you built from the starter, installed on your
account, and you know how to update and share it.

A plugin is a small package you build on your own computer (Plugin SDK v1).
You don't need PCBJam's source code, and Git is optional.

## Before you start

- **A PCBJam account with developer access.** Anyone signed in can install
  published plugins, but uploading your own needs developer access:
  1. Sign up at PCBJam with the account you will develop with.
  2. Post that account's email address and one line about what you are
     building on the [PCBJam Discord](https://discord.gg/ybhqJxjR3E).
     PCBJam turns on developer access for it. Until then the editor has no
     **Plugins → Add plugin…** and uploads are refused.
- **Node.js 22 or newer**, if you use the TypeScript + React starter. Plain
  JavaScript and HTML need no build at all.
- **A schematic or board open in PCBJam** to try the plugin on.

The Discord is also where you ask questions and report SDK problems. A plugin
that calls [your own backend](#call-your-own-backend) or a
[Remote Symbols provider](remote-symbols.md) also needs a one-time review by
PCBJam; ask for it there.

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

Every call, its arguments and its limits are in
[API and permissions](api-and-permissions.md).

A plugin can't reach the network except through your approved backend, can't
read projects that aren't open, can't change the design except by a symbol
placement the user confirms, and doesn't run while it isn't handling a command.

## Build and install your first plugin

1. Download the [TypeScript + React starter](download/external-symbol-import-source.zip)
   and extract it. (To try a finished plugin first, take the
   [installable example ZIP](download/external-symbol-import.zip) and go to
   step 5. It adds a symbol from a local file; its README explains how.)
2. In the extracted folder, install and build:

   ```sh
   npm ci
   npm run build
   ```

3. Open `manifest.json` and change `id` and `name` to your own.
4. Edit `src/main.ts` (logic) and `src/ui/App.tsx` (UI), then run
   `npm run build` again. The build writes `dist/plugin/` and
   `dist/<manifest-id>.zip`.
5. In PCBJam, open a schematic or board and choose **Plugins → Add plugin…**
   in the floating session menu.
6. Choose **Install ZIP** or **Install folder** and pick the build output
   (`dist/<manifest-id>.zip` or `dist/plugin/`), **not the source ZIP**.
7. Review the permissions it asks for and install.
8. Open the plugin by name from **Plugins**.

## Required files

Every installable package has these three files at its root:

| File | Purpose |
|---|---|
| `manifest.json` | Identity, version, supported editors and requested permissions. |
| `main.js` | Bundled plugin logic. PCBJam supplies the global `pcbjam` API. |
| `ui.html` | UI with inline JavaScript and CSS. PCBJam supplies `pcbjamUI`. |

You may add `README.md`, `LICENSE.txt` and `sdk.d.ts`. A tutorial may also
bring its starting project under `template/` (KiCad text files only:
`.kicad_pro`, `.kicad_sch`, `.kicad_pcb`, `.kicad_sym`, `.kicad_mod`,
`.kicad_dru`, `.kicad_wks`, `sym-lib-table`, `fp-lib-table`; at most 24 files
and 4 MiB, with a schematic or board at the top). PCBJam copies it into a new
project when someone starts the tutorial; the plugin itself never reads it.
Any other file name is refused. A ZIP may wrap the files in one folder.

Use TypeScript and React through your own build, or plain JavaScript and HTML.
Bundle your dependencies into these files: no CDN imports, no separate asset
files, no uploaded `node_modules`. PCBJam never runs your build scripts.

| Package limit | Value |
|---|---|
| ZIP size | 8 MiB |
| All files, uncompressed | 12 MiB, at most 32 entries, 4 MiB per file |
| `manifest.json` | 16 KiB |
| `main.js` / `ui.html` | 1 MiB / 512 KiB |
| Paths | letters, digits, `_`, `.`, `-` and `/`; no `..`, no absolute paths |

An upload whose `ui.html` loads scripts or stylesheets by URL
(`<script src>`, `<link href>`) is refused.

## Manifest

This minimal manifest has every required field. It only reads basic editor
context:

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
| `id` | 3–64 lowercase letters, digits or hyphens; starts with a letter. Keep it stable across updates. |
| `name`, `description` | Name: 1–80 characters. Description: up to 300. |
| `version` | `major.minor.patch`, e.g. `0.1.0`. Increase it whenever the package contents change. |
| `main`, `ui` | Exactly `main.js` and `ui.html`. |
| `surfaces` | Schematic: `editor:eeschema`. Board: `editor:pcbnew`. Choose one or both. |
| `permissions` | Both UI permissions are required. Add only the [API permissions](api-and-permissions.md) your feature uses. |
| `uiSize` (optional) | Preferred floating window size: `{ "width": 640, "height": 480 }`. Integer CSS pixels; width 280–4096, height 240–4096. |

`ui:custom` allows your iframe UI and `ui:project-data` allows passing logic
results into it. Neither lets you read the document. Unknown fields, surfaces
and permissions are refused.

**Window size.** Without `uiSize` the window opens at 360 × 560. The size
includes PCBJam's header, status bar and confirmation area; your iframe fills
the rest. PCBJam keeps the window inside the viewport. Users resize it from
either bottom corner (or focus a resize handle and use the arrow keys; Shift
takes larger steps), and their size wins over `uiSize`. PCBJam remembers it
per account and plugin in that browser. Resizing keeps your UI's state, so
make the UI responsive.

## Write logic and UI

Register commands in `main.js` (or `src/main.ts` with TypeScript):

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

React components call the same `pcbjamUI.call()` from event handlers.

Rules for **logic** (`main.js`):
- Register commands at startup and call host APIs inside handlers.
- Pass only JSON arguments and results, and validate what comes in.
- There is no DOM, Node.js, `fetch` or `console`. `setTimeout` and
  `clearTimeout` work only while a command is being handled: pending timers
  are cancelled when the command settles, so nothing runs in the background.
  [Debugging and errors](api-and-permissions.md#debugging-and-errors) shows
  how to see what your logic does.

Rules for **UI** (`ui.html`):
- Keep React and all DOM code here.
- Bundle your CSS into `ui.html`. Inline `style="…"` attributes pass the
  upload check but are ignored at run time: the page's security policy only
  allows the styles and scripts that were in `ui.html` when you uploaded it.
  Use classes, or set `element.style` from script.
- `data:` and `blob:` images work. Images, fonts and scripts from a server
  don't.
- A message from the UI to logic is limited to 64,000 characters. Build
  anything large, such as a page for `files.saveHtml()`, in logic from data
  logic read itself, and send the UI only what it displays.
- Allow one command at a time and show errors to the user.

The [SDK declarations](download/sdk.d.ts) give your editor autocomplete.

## Example: a parts list that highlights and exports

A board plugin in the style of an interactive BOM: group the parts, draw their
pads, select a group on the board when its row is clicked, and export a
standalone page. It shows three habits that matter on real boards, numbered
in the code: read in slices, retry when the design changes, and escape design
text.

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

## Update a plugin

1. Increase `version` in `manifest.json`.
2. Build. (`npm run dev` rebuilds on every save while you work.)
3. Upload the new build with **Plugins → Add plugin…** and approve it.

Restarting a plugin runs the installed version; it doesn't reload your local
source.

> **Uploads are limited.** Each account keeps at most **32 releases and
> 64 MiB** of uploads across all its plugins, and you can't delete releases
> yet. Every new version you upload uses one. Uploading the same version with
> the same files again reuses the existing release; the same version with
> different files is refused. Check your change locally first (type check, a
> small mock of `pcbjam` for logic) and upload the versions you want to try in
> PCBJam. Deleting old releases and a developer mode that reloads local builds
> are planned.

Installations are private to your account and follow you across browsers.
`storage:local` settings stay in that browser and project. Disabling a plugin
keeps its settings; resetting or uninstalling it removes them. Before you share
a package, try it on a read-only document, cancel its prompts and make it fail.

## Call your own backend

You never create or embed an API key. You sign into PCBJam to upload and
install, the user reviews the permissions, and PCBJam ties every call to that
installation and checks the user's access to the project. Your code never sees
a login cookie or access token. Use `pcbjam.context.get()` to find out which
methods are available.

To call your own server:

1. Download the [backend starter](download/backend-preferences-source.zip).
   It includes a verifier and Postgres replay protection.
2. Declare one HTTPS origin, exact paths and `GET`/`POST` methods in the
   optional `endpoints` field. Request `network:<name>`, and for signed
   identity also `backend:identity:<name>`. Details:
   [Backend requests](api-and-permissions.md#backend-requests).
3. Upload the plugin, then post the plugin UUID shown in the review on the
   [PCBJam Discord](https://discord.gg/ybhqJxjR3E).
4. Publish the DNS TXT challenge PCBJam gives you there. Domain verification
   lasts 30 days.
5. After verification and approval, upload the same ZIP again to refresh its
   status, and install it.
6. Configure your backend with the issuer, audience and plugin UUID PCBJam
   gives you.

PCBJam has to approve the routes, in addition to each user agreeing at
install. Your backend verifies the signature and uses the verified subject as
the user ID; never trust a user ID sent in the request JSON. Keep your secrets
on your backend.

For local development, use an HTTPS tunnel on a hostname you control: private
IPs, localhost and PCBJam's own infrastructure are blocked. There is no OAuth
delegation or public publisher registration yet.

## Share a plugin

PCBJam publishes plugins in the **marketplace** at `app.pcbjam.com/plugins`
(also **Plugins → Browse plugins…** in the editor). Any signed-in account can
install from there without developer access, and the plugin then appears in
the editor's **Plugins** menu. When PCBJam publishes a new version, users get
an **Update** button: one click if the permissions are unchanged, a new review
if the plugin asks for more.

To get your plugin listed, send it to PCBJam on the
[Discord](https://discord.gg/ybhqJxjR3E). PCBJam reviews it, and any backend,
before publishing.

Until then, a teammate with developer access can upload your ZIP privately
with **Plugins → Add plugin…**. The upload counts against their own release
limit, and a backend on their copy needs its own approval (they ask on Discord
with their plugin UUID).

## Next

- [API and permissions](api-and-permissions.md): every call, permission and
  limit.
- [Plugin architecture](architecture.md): how logic, UI and PCBJam fit
  together.
- [Remote Symbols](remote-symbols.md): your parts catalog in the schematic
  editor, without writing a plugin.
