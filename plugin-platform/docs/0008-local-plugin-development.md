# Build a plugin for PCBJam

**Preview SDK · API version 1.** This guide is for third-party developers writing
their own plugins. Develop in your own folder or repository; you do not need
PCBJam's source code. You need a PCBJam test environment with the preview
installer enabled for your account. Uploads and installs are private to your account;
public publishing and the plugin marketplace are not available yet.

A plugin contains JavaScript logic, an HTML interface and a manifest describing
its permissions. PCBJam runs the logic in QuickJS inside a Worker and displays
the interface in an isolated iframe inside a draggable floating panel. PCBJam
supplies the connection between them.

Open this guide through the session menu's **Plugins → Add plugin… → Developer guide**. It opens in a separate
tab with a TypeScript + React source ZIP, a ready-to-install ZIP, a sample
symbol library and SDK declarations.

## Start with a working plugin

1. Choose **Download installable plugin ZIP** to try External Symbol Import
   immediately. Choose **Download TypeScript + React source** when you want to
   edit it; the source ZIP needs the build step below.
2. Open a writable schematic in your PCBJam test environment. Open the floating
   session-menu button, then **Plugins → Add plugin…**. In the management sidebar,
   choose **Install ZIP** and select the ZIP. Alternatively, choose **Install
   folder** and select the folder containing `manifest.json`.
3. Review the permissions and click **Install plugin**. The plugin opens in its
   floating panel. Uploading alone does not activate a package. Later, open it
   by name from the session menu's **Plugins** list.
4. Click **Choose symbol library**, then use the PCBJam file control above the
   plugin to select the downloaded `sample-symbols.kicad_sym`.
5. Select **PluginResistor_10k**, click **Add symbol**, approve **Place on canvas**
   in PCBJam's confirmation, and click the schematic to place it.
   **Esc** cancels placement; **Undo** removes a placed symbol.

The example imports a symbol instance with its embedded definition into the
current sheet. It supports modern `.kicad_sym` files, inheritance within that
file, and unit 1. It does not install permanent libraries, import legacy `.lib`
files or import footprints. The sample library is input data: keep it outside
the plugin folder.

## Develop with TypeScript and React

Download **TypeScript + React source**, unzip it, and open the
`external-symbol-import-source` folder in your editor. Use Node.js 22 or newer.
Run these commands from that folder:

```sh
npm ci
npm run build
```

The build type-checks both parts, compiles TypeScript and bundles React/CSS. It
produces **`dist/external-symbol-import.zip`**, ready for **Install ZIP**, and
**`dist/plugin/`**, ready for **Install folder**. The source ZIP is for editing;
install the build output. PCBJam never runs uploaded package-manager/build scripts.

```text
external-symbol-import-source/
  manifest.json             ID, version, permissions and editor surfaces
  src/main.ts               Plugin commands running in QuickJS
  src/contracts.ts          Shared types for command arguments and results
  src/logic/library.ts      Symbol parsing and inheritance
  src/logic/placement.ts    Native clipboard proposal
  src/ui/App.tsx            React components, hooks and event handlers
  src/ui/styles.css         UI styling
  types/                    PCBJam API autocomplete declarations
  scripts/build.mjs         Local build and ZIP packaging
  package.json
  package-lock.json
```

Start by changing `src/ui/App.tsx` or `src/ui/styles.css`; the symbol importer
logic is split into small modules so it does not dominate the component. For a
new plugin, change the manifest ID/name and implement your commands in
`src/main.ts`. The source archive includes the complete parser, build script,
SDK declarations and lockfile; it has no dependency on the PCBJam repository.

Use `npm run typecheck` while editing. Logic is checked without DOM/Node globals;
UI has React/DOM types. `src/contracts.ts` connects command arguments/results to
the UI's typed `callPlugin` wrapper. TypeScript does not replace runtime input
validation or PCBJam's permission checks.

After editing, increase `manifest.json`'s version, run `npm run build`, then
install the new ZIP/folder. For continuous builds, run `npm run dev`: it watches source, types and the
manifest, checks TypeScript and rebuilds the ZIP/folder after each save. Upload
and approve each new version explicitly; this replaces the old sandbox. `dist/` is generated output; edit `src/`.
React dependencies are minified in the built UI to meet its size limit, while
the TypeScript/React source remains readable. The pinned versions and lockfile
make dependency installation reproducible.

React runs entirely in the UI iframe. Bundle dependencies locally; remote
scripts, Node APIs, server rendering and remote assets are unavailable. Prefer
CSS files or build-time CSS over libraries that inject style tags at runtime:
the current CSP permits approved bundled styles. React and TypeScript require
no extra permissions and do not change the sandbox. See
[React's TypeScript guide](https://react.dev/learn/typescript) for component types
and [esbuild's API](https://esbuild.github.io/api/) for the starter's build options.

## Installable package structure

```text
my-plugin/
  manifest.json
  main.js
  ui.html
  sdk.d.ts        optional autocomplete/type declarations
  README.md      optional usage instructions
  LICENSE.txt    optional license
```

These are the supported **build output** filenames. The TypeScript/React
starter creates them for you. Plain JavaScript plugins can also supply them
directly without a build. Logic is bundled into `main.js`; UI scripts and
styles are bundled inline into `ui.html`. CDN scripts, remote imports, separate
assets, source maps and `node_modules` are not supported in uploaded packages.
ZIP the files directly, or inside one enclosing folder.

## Describe your plugin

Create `manifest.json`. This minimal plugin only reads basic editor context:

```json
{
  "apiVersion": 1,
  "id": "my-editor-helper",
  "name": "My Editor Helper",
  "version": "0.1.0",
  "description": "Show the name of the current editor file.",
  "main": "main.js",
  "ui": "ui.html",
  "surfaces": ["editor:eeschema", "editor:pcbnew"],
  "permissions": ["ui:custom", "ui:project-data"]
}
```

IDs contain 3–64 lowercase letters, digits or hyphens and start with a letter.
Versions use `major.minor.patch`. Supported surfaces are the schematic editor
(`editor:eeschema`) and PCB editor (`editor:pcbnew`). A plugin is unavailable
in editors it does not declare. Unknown fields, permissions and API versions
are rejected.

| Permission | What the user allows |
|---|---|
| `ui:custom` | Run custom UI in a sandboxed iframe. Required in the preview. |
| `ui:project-data` | Disclose logic results to that UI. Required in the preview; does not grant access to every project document. |
| `project:read-info` | Read current project metadata and design-file names. |
| `documents:read` | Read bounded content from the current editor document. |
| `editor:read-selection` | Read selected item IDs in the current editor. |
| `storage:local` | Keep browser-local settings for this account/project/plugin. |
| `files:save` | Request a text download with PCBJam confirmation. |
| `files:choose` | Read files explicitly selected for this running plugin. |
| `editor:place-items` | Request item placement in a writable editor, with PCBJam confirmation. |

Request only permissions you use. A file importer needs `files:choose` and `editor:place-items`.
A permission does not bypass document access, editor compatibility, file
selection or placement confirmation.

## Implement your first command

In `src/main.ts`, register a handler with the supplied `pcbjam` object:

```ts
pcbjam.handle('describeEditor', async () => {
  const context = await pcbjam.context.get();
  return { fileName: context.fileName, readOnly: context.readOnly };
});
```

A minimal React component in `src/ui/App.tsx` can call it:

```tsx
import { useState } from 'react';

export function App() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function inspect() {
    setBusy(true);
    try {
      const result = await pcbjamUI.call('describeEditor');
      setMessage(result.fileName);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Inspection failed.');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button disabled={busy} onClick={inspect}>Which file is open?</button>
    <p role="status">{message}</p>
  </>;
}
```

The starter's `src/ui/main.tsx` already mounts `<App />`. For typed command
names/arguments/results, add `describeEditor` to `src/contracts.ts` and call it
through `callPlugin`, as the complete example does for `chooseLibrary` and
`placeSymbol`. Plain HTML/JavaScript UIs can use the same `pcbjamUI.call` API.

Register handlers at startup; make host API calls inside handlers. Arguments
and results must be JSON data: no functions, cyclic objects, BigInt or host
objects. `pcbjamUI.call()` waits for connection; `pcbjamUI.ready` is also
available. Allow one UI command at a time and handle rejected promises. Render
values as React text children (or `textContent` in plain JavaScript), not injected
HTML; treat file contents as untrusted input.

You do not implement Worker creation, iframe messaging, authentication or
QuickJS setup. Your logic cannot use DOM, Node.js, browser storage, `fetch`,
native timers or remote module imports. UI JavaScript can use its own DOM,
but cannot access PCBJam's DOM or directly call the editor API.

## API available today

The SDK now includes current-project metadata, a design-file catalog, current
document snapshots, item pages, selection IDs, local parsing/printing/diffs,
plugin storage and confirmed downloads, alongside file picking and placement.
See the [API and permission reference](0009-plugin-api-and-permissions.md) for
the complete generated method list, response types and limits. Download the
updated `sdk.d.ts` for autocomplete. Check `context.get().methods` before using
an optional host capability.

Only request permissions your plugin uses. In addition to the two custom UI
grants, add `project:read-info` for metadata/catalog, `documents:read` for content,
`editor:read-selection` for selected IDs, `storage:local` for plugin data,
`files:choose` for local files, `files:save` for downloads and
`editor:place-items` for confirmed native placement.

## Read the current design

Add `documents:read` to your manifest, then register a command:

```js
pcbjam.handle('inspectDesign', async () => {
  const context = await pcbjam.context.get();
  if (!context.methods.includes('documents.getCurrent')) {
    throw new Error('Document reading is unavailable in this editor.');
  }
  const current = await pcbjam.documents.getCurrent();
  const ref = { document: current.document, revision: current.revision };
  const page = await pcbjam.items.list({ ...ref, limit: 50 });
  return { fileName: current.name, items: page.items, nextCursor: page.nextCursor };
});
```

Call `pcbjamUI.call('inspectDesign')` from your UI. Item summaries contain
`{id, type, parent}`. To read bodies, call
`pcbjam.items.get({...ref, ids: ['an-id-from-the-page']})`; each body is an ordered
array of slots: `{atom}`, `{k, v}` or `{item}`. Atoms preserve their textual
spelling, including quotes. `{item}` refers to another item ID. You receive
copies, so changing these objects does not change the design.

For another page, pass its `nextCursor` and the **same** document/revision. Stop
when it is `null`. If the design changes, the read rejects; restart from a new
`documents.getCurrent()` result. Handles expire when the plugin stops or the
current editor document changes. Do not save them in storage.

`selection.get()` needs `editor:read-selection` and returns selected IDs,
`document`, content `revision` and a separate `selectionRevision`. Read those
IDs with `items.get()` only if you also requested `documents:read`.
`project.getInfo()` and `documents.list({cursor: 0, limit: 50})` need
`project:read-info`; the catalog contains file names, not permission to open
closed documents. This preview reads only the document active in this editor.

## Parse, compare and export

```js
pcbjam.handle('exportDesign', async () => {
  const current = await pcbjam.documents.getCurrent();
  const { text } = await pcbjam.documents.getSexpr({
    document: current.document, revision: current.revision
  });
  return pcbjam.files.save({ name: 'design.kicad_sch', text });
});
```

This schematic example requires `documents:read` and `files:save`. For a PCB,
use a `.kicad_pcb` filename. PCBJam asks the user to confirm the download outside
your iframe. It returns `{status: 'download-requested'}` or
`{status: 'cancelled'}`. The former means the browser received a download request,
not that it saved the file. Exports are limited to 512 KiB of UTF-8 text; a larger
snapshot can still be read, but cannot be exported through this API yet.

For your own text, `pcbjam.sexpr.parse(text)` and `.print(forms)` are synchronous
local helpers. `pcbjam.sexpr.diff(before, after)` returns added, updated and
removed UUID arrays plus `layoutChanged`. They run in QuickJS and do not access
or edit the project. They compare structure, not electrical correctness.
Limits apply even to local computations; see the reference.

To check for edits, call `documents.poll({document, since: revision})` from a
registered command. It returns `{revision, changed}`. There is no subscription
API yet. Your UI can use a timer to call that command periodically, but keep one
command outstanding, back off on errors and respect the request limits.

## Remember plugin settings

Add `storage:local` and use your own keys:

```js
pcbjam.handle('setUnits', async ({ unit }) => {
  if (!['mm', 'in'].includes(unit)) throw new Error('Invalid unit');
  const context = await pcbjam.context.get();
  if (!context.methods.includes('storage.get')) {
    throw new Error('Plugin storage requires a signed-in account.');
  }
  const previous = await pcbjam.storage.get('settings');
  return pcbjam.storage.set({
    key: 'settings', value: { unit }, expectedRevision: previous.revision
  });
});
```

The namespace belongs to this plugin, account and project. You cannot choose a
different namespace. Its revision changes whenever any key changes. A competing
write causes a conflict: read again and decide whether to retry. `storage.list()`
returns `{revision, keys}`; `storage.delete({key, expectedRevision})` removes one
key. A missing value returns `{found: false, value: null, revision}`.

Storage survives plugin restarts and version updates on the same browser/origin.
It is project-specific and unavailable to anonymous sessions. It is not a cloud
backup or a secret store. Disable retains data. **Reset data** and **Uninstall**
revoke the storage namespace; old browser records are removed when that account
next refreshes its plugin list. Reinstall starts with an empty namespace. Browser
site-data clearing/eviction also removes it. Per
namespace limits are 64 keys, 16 KiB per JSON value and 256 KiB total.

## Choose files and place items

`files.choose({extensions: ['.kicad_sym']})` opens a PCBJam-owned file control and
returns `{handle, name, size}`, or `null` on cancellation. Use
`files.readText(handle)` and `files.close(handle)`; close resolves to `null`.
Only `.kicad_sym`, `.kicad_mod`, `.txt` and `.json` are supported. A handle cannot
read another disk file and expires when the instance stops.

`editor.requestPlacement({label, sexpr})` requires `editor:place-items` and a
writable compatible editor. The trusted confirmation is outside plugin UI.
On the hosted platform it resolves to `{status: 'placed'}` only after the user
clicks the canvas and the native editor commits the symbol. Esc or a declined
confirmation returns `{status: 'cancelled'}`; parser errors reject the promise.
Undo removes the item through the normal editor flow. Show instructions while
awaiting this promise: approve, move onto the canvas, then click or press Esc.

Hosted placement currently accepts a bounded, self-contained schematic symbol
with one embedded definition. Unsupported resources, simulation fields, nested
sheets, images, unresolved inheritance and footprint placement are rejected.
The starter resolves in-file inheritance before submitting a symbol. Check
`context.get().canPlaceItems` before offering placement. An operator may disable
placement independently of the rest of the SDK. The local architecture lab
retains a legacy `{status: 'queued'}` result; it is not proof of a native commit.
Use the downloadable importer for the complete symbol clipboard example.

`pcbjam.handle` registers at most 32 commands; `pcbjam.randomUUID()` generates
UUIDs for proposed items. In `ui.html`, use `pcbjamUI.ready` and `pcbjamUI.call`.
Other planned capabilities are clearly marked unavailable in the reference.

## Do I need an API key?

**No API key is needed to run an installed plugin.** Your manifest requests
permissions, the user approves installation, and PCBJam checks each request.
A plugin cannot grant itself more access by supplying a user ID or a key.

Publishing credentials and backend integrations are future features. A publishing
key will authorize publishing your plugins, not reading users' projects.
A backend will need a separate, scoped integration to access PCBJam data.
Never put secrets in `main.js`, `ui.html`, the manifest or any downloadable
package. See the [credential design](0009-plugin-api-and-permissions.md#credentials-and-user-identity).

## Edit, update and remove

1. Edit your `.ts`, `.tsx` or `.css` source files.
2. Increase the manifest version, including for changes to optional output files.
3. Run `npm run build`; install its ZIP or `dist/plugin/` folder, review permissions
   and click **Install plugin**.
4. Test each declared editor, read-only documents, cancellation and errors.

Installed releases are immutable. Reusing an ID/version with different bytes
is rejected. **Restart plugin** runs the installed release again; it does not
read your edited source folder. `npm run dev` watches your source and rebuilds locally; uploading and accepting
a new version is still explicit, on both local and deployed PCBJam.

Use **Plugins → Add plugin…** to manage installed packages; each row has an Open
button and a trash button to uninstall it. Drag a plugin by its title bar;
collapsing it preserves its UI/runtime state. Closing its floating panel, opening
the manager or switching to another plugin stops its instance and cancels pending
host prompts. Changing editor documents tears down the old document instance.
Other open instances detect uninstall or update
through a poll, normally within two seconds plus request time.

Installs and approved permissions belong to your PCBJam account in that deployment.
They survive browser restarts and are available when you sign into another browser.
Plugin-local settings remain on each browser. UI state and selected file handles
are temporary. Uploading a ZIP stores a private immutable release; installing it
requires explicit permission review. Updates never silently add permissions.

The manager provides **Open**, **Disable / Enable**, **Reset data** and **Uninstall**.
Disable stops new calls and preserves settings. Uninstall stops instances and
resets local data access. Uploads are limited to 32 private releases and 64 MiB
per account; failed uploads expire after a day. For an exhausted quota, contact
the preview operator. Marketplace discovery, public publishing, verified
publishers, backend request signing and outbound network APIs are future work.

A platform runtime upgrade can invalidate an older preview release. If told to
reload, reload PCBJam first. If the installed release still targets an old runtime,
raise your manifest version, build again and review/install the new ZIP. Automatic
release migration is not part of this preview.

## Limits and troubleshooting

| Resource | Preview limit |
|---|---|
| Package ZIP | 8 MiB compressed; 12 MiB expanded; 32 entries; 4 MiB per file |
| Manifest / logic / UI | 16 KiB / 1 MiB / 512 KiB |
| Selected local file | 4 MiB; four open handles per instance |
| Document snapshot / item response | 1 MiB serialized UTF-8; at most 100 items per page/batch |
| Text download | 512 KiB UTF-8; user confirmation required |
| Plugin storage | 64 keys; 16 KiB per value; 256 KiB per account/project/plugin |
| Placement proposal | 512 KiB; bounded nesting and form count |
| QuickJS | 64 MiB heap; 512 KiB stack; one-second CPU turns |
| UI command | One outstanding; 120 seconds including user confirmation |
| Host calls | Four outstanding; 60 per ten seconds |
| UI requests | 20 per ten seconds; 64,000 serialized characters |
| Logic messages | Up to 4 Mi serialized characters, also bounded by the operation |

If an API is denied, check the installed permissions and current editor.
If a version conflicts, increment it and upload again. If the plugin service
is unavailable, contact the environment's operator. If an action times out,
restart the plugin and try a smaller input. For empty library lists, check
the file format and in-file inheritance. If placement does not start after
approval, read the reported validation/native error. Unsupported symbol forms
are rejected before they reach the editor. Do not retry rejected resources by
renaming fields or bypassing the trusted confirmation.

Use this preview with plugins you trust. Hosted symbol imports pass a bounded
format allowlist in a separate validation Worker; this is not a proof that the
native editor parser is free of defects. Custom iframe code does not have QuickJS's
CPU/memory limits. CSP blocks tested network requests, but data sent to arbitrary
UI must be treated as disclosed; strict zero-egress is not guaranteed.
The [security and test matrix](0010-plugin-security-and-testing.md) explains
the current checks and remaining production requirements.
