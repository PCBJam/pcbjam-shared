# Build a plugin

**Plugin SDK v1.** Create your plugin in a folder on your computer; using Git is
optional. Sign into PCBJam to install it. Ask PCBJam to enable plugin access for your
account before installing your first plugin. You do not need PCBJam's source code.

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
separate asset files or uploaded `node_modules`. Logic is limited to 1 MiB;
UI to 512 KiB. PCBJam never runs uploaded build scripts.

## Manifest

All fields below are required. This plugin only reads basic editor context:

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

`ui:custom` allows your iframe UI; `ui:project-data` allows passing logic results
into it. Neither grants document reads. Unknown fields, surfaces and permissions
are rejected.

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
in UI code; logic has no DOM, Node.js, `fetch` or native timers. Bundle CSS into
`ui.html`; runtime-injected styles are restricted.

Register commands at startup, call host APIs inside handlers, and pass only JSON
arguments/results. Validate incoming arguments. Allow one UI command at a time
and handle errors. The [SDK declarations](download/sdk.d.ts) provide autocomplete.

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

Upload first, send PCBJam the plugin UUID shown in the review, and publish the
DNS TXT challenge PCBJam provides. After verification and approval, re-upload
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

Installations are private to your account and follow it across browsers.
`storage:local` settings stay in that browser and project. Disable preserves
settings; reset or uninstall revokes them. Test read-only documents, cancelled
prompts and errors before sharing a package.

Next: [Available APIs](0009-plugin-api-and-permissions.md) ·
[Architecture](0010-plugin-security-and-testing.md).
