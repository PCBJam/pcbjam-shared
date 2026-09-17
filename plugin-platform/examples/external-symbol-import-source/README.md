# PCBJam plugin starter

A standalone TypeScript + React example that places a symbol from a local
`.kicad_sym` file. You do not need the PCBJam repository.

## Build

Use Node.js 22+ in this extracted folder:

```sh
npm ci
npm run build
```

Install `dist/external-symbol-import.zip` or `dist/plugin/` through the editor's
**Plugins → Add plugin… → Install ZIP / Install folder**, then approve permissions.
The source ZIP is for editing; it cannot be installed directly.

## Edit

| File | Purpose |
|---|---|
| `manifest.json` | Plugin identity, version, supported editors and permissions. |
| `src/main.ts` | Register commands and call the `pcbjam` API. |
| `src/ui/App.tsx`, `src/ui/styles.css` | React UI and styles; use `pcbjamUI.call()` to invoke commands. |
| `src/contracts.ts` | Shared command argument/result types. |
| `src/logic/` | This example's symbol parsing and placement logic. |
| `types/` | SDK autocomplete declarations. |

Change the manifest ID/name for a new plugin. Run `npm run dev` for automatic
local type checks and rebuilds, or `npm run typecheck` for a one-off check.
Increase `manifest.version` before each changed upload, then rebuild and install.
The ZIP filename follows the manifest ID. There is no automatic upload or reload.

The build bundles logic into `main.js` and React/CSS into `ui.html`.
Keep React in UI code and bundle dependencies locally; no CDN or Node APIs.
Both `pcbjam` and `pcbjamUI` are supplied by PCBJam. No API key is needed.

## Try the example

1. Open a writable schematic and the installed plugin.
2. Choose a `.kicad_sym` library through the PCBJam file control. A test library
   is available beside the starter download in the developer guide.
3. Select a symbol, choose **Add symbol**, and approve **Place on canvas**.
4. Click the canvas to place it; **Esc** cancels and **Undo** removes it.

The importer supports modern libraries, inheritance within the selected file,
and unit 1. It embeds the symbol in the current sheet; it does not install a
permanent library or import footprints. Unsupported symbol forms show an error.

Open **Plugins → Add plugin… → Developer guide** for the required package files,
manifest, current APIs and architecture. Third-party React/scheduler licenses
are included in the built plugin.
