# PCBJam plugin starter: TypeScript + React

A complete External Symbol Import plugin. Edit ordinary `.ts`, `.tsx` and `.css`
files in your own repository. PCBJam's source code is not needed.

## Build and install

Use Node.js 22 or newer. From this extracted source folder:

```sh
npm ci
npm run build
```

The build checks TypeScript and creates:

- `dist/external-symbol-import.zip` — upload this with **Plugins → Install ZIP**.
- `dist/plugin/` — choose this directory with **Plugins → Install folder**.

Review the requested permissions, install, choose a `.kicad_sym` file using the
PCBJam control, select a symbol and approve **Place on canvas**. Click the canvas
to place; Esc cancels and Undo removes it. A test library is available alongside
this starter on the developer guide page.

**The source ZIP itself is not installable.** It includes build tools and source
files. PCBJam accepts the generated ZIP/folder and never runs uploaded npm scripts.

## Files you edit

```text
manifest.json          Plugin ID, version, supported editors and permissions
src/main.ts            Plugin commands; starts here inside QuickJS
src/contracts.ts       Typed request/results shared with the UI
src/logic/library.ts   Read and resolve symbols, including inheritance
src/logic/placement.ts Build the native clipboard proposal
src/logic/sexpr.ts     Bounded library parser and small text helpers
src/ui/App.tsx         React component with buttons, state and rendering
src/ui/styles.css     UI styles
src/ui/main.tsx        Mount React inside the plugin iframe
src/ui/pcbjam.ts       Typed wrapper for calls to plugin commands
```

Change the plugin ID/name in `manifest.json` when starting your own plugin. The
same ID/version cannot be installed with different bytes: increase `version`
each time you build a changed release, then install it again. Restarting a plugin
runs the installed release; it does not watch your source folder.

Run `npm run dev` while editing for automatic type checks and rebuilds after a
save. Increase `manifest.version` before uploading each changed build, then use
**Plugins → Add plugin…** to upload and approve it. Accepting an update stops the
old instance and starts a fresh sandbox. This flow works with local and deployed
PCBJam; no PCBJam repository or author API key is needed. The watcher never
uploads code or expands permissions automatically. Restart the watcher after
changing build scripts or dependencies.

Run `npm run typecheck` for a one-off check. Your editor also uses the included
TypeScript configs and `types/` declarations for autocomplete. Logic is checked
without browser or Node globals. UI is checked with DOM/React types. Contracts
connect both sides; keep runtime validation for inputs that arrive from the UI.

## Execution model

The builder compiles TypeScript to JavaScript for QuickJS and bundles React,
its dependencies and CSS into one self-contained `ui.html`. React renders inside
the isolated iframe. Call `pcbjam` in logic and `pcbjamUI` in the UI; the host
supplies both. Neither React nor TypeScript adds permissions.

Bundle dependencies locally; CDN imports, remote assets, external stylesheets,
Node APIs in plugin logic and server rendering are not supported. Prefer CSS
files to libraries that inject runtime style tags: the sandbox only permits
approved scripts/styles bundled into the UI. Build output is not the source to
edit. React's bundle is minified to fit the 512 KiB UI limit; your source stays
readable. TypeScript performs compile-time checks, while PCBJam validates API
requests and permissions at runtime.

The importer supports modern `.kicad_sym` libraries, inheritance in the selected
file and unit 1. It places a symbol instance with its embedded definition, not a
permanent library. The hosted API resolves after placement or cancellation. A legacy lab queued response acknowledges the native tool handoff, not a
completed placement/save. This remains a preview plugin.

Third-party React/scheduler licenses are included in the generated plugin.
