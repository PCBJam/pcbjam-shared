# Remote Symbols

**For parts providers.** If you already serve a **KiCad 10 remote-symbol
provider** (the panel behind KiCad's *View → Panels → Remote Symbols*), PCBJam
shows the same panel in its schematic editor, under the same name. Users search your catalog,
click Place, and the part lands in their team library and on their schematic.

The protocol is KiCad's, unchanged: the same `/.well-known/kicad-remote-provider`
document, the same JSON-RPC messages, the same `PLACE_COMPONENT` manifests. You
write no PCBJam plugin code. Two things differ, because your page runs in a
cross-origin `<iframe>` in a browser instead of KiCad's native web view:

1. **A bridge shim** of about 20 lines: KiCad injects `window.kicad` into your
   page; a browser cannot, so your page provides it on top of `postMessage`.
2. **Two response headers** on the panel page: PCBJam's editor is cross-origin
   isolated, and a browser only embeds pages that opt in.

Then you publish a one-file package that names your origin, and PCBJam approves
it once.

## How it works

1. A user installs your provider package and opens it from **Plugins** in a
   schematic.
2. PCBJam reads your `/.well-known/kicad-remote-provider` document from its
   server, checks the two headers on your panel page, and loads `panel_url` in
   a sandboxed iframe.
3. PCBJam sends `NEW_SESSION`. From then on your page and PCBJam exchange the
   usual KiCad JSON-RPC envelopes through the shim.
4. Your page sends `PLACE_COMPONENT` (or an inline `DL_COMPONENT`). PCBJam shows
   the user its own confirmation with the part name and your origin.
5. PCBJam's server downloads each asset from your origin and checks content
   type, size and sha256; the browser checks size and sha256 again. The symbol
   and footprint are validated and saved to the team library named after your
   domain, and the user clicks the canvas to place the symbol.

Your page never receives PCBJam cookies, tokens or project data; `postMessage`
is its only channel.

## The shim

Include this before your panel script. Put every PCBJam origin that may embed
you in `EMBEDDERS`.

```js
(function () {
  var EMBEDDERS = window.PCBJAM_EMBEDDERS || [
    "https://editor.pcbjam.com",
  ];
  if (window.kicad || window.parent === window) return;
  var embedder = null;
  window.kicadMessages = window.kicadMessages || [];
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    if (EMBEDDERS.length && EMBEDDERS.indexOf(event.origin) < 0) return;
    embedder = event.origin;
    var data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    if (window.kiclient && typeof window.kiclient.postMessage === "function") window.kiclient.postMessage(data);
    else window.kicadMessages.push(data); // drain this queue once your kiclient is ready
  });
  window.kicad = {
    postMessage: function (message) {
      if (!embedder) throw new Error("PCBJam has not opened a session yet");
      window.parent.postMessage(typeof message === "string" ? message : JSON.stringify(message), embedder);
    },
  };
})();
```

- PCBJam always speaks first (`NEW_SESSION`), so the shim learns the embedder's
  origin from that message and only ever replies to it.
- Messages that arrive before your `window.kiclient` exists wait in
  `window.kicadMessages`; handle them once your client is ready.
- Inside desktop KiCad `window.kicad` already exists and the shim does nothing,
  so one page serves both.
- An empty `EMBEDDERS` list accepts any embedder. Use it only for local testing.

## The headers

On the panel page (`panel_url`) and everything it loads:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

With these your page is cross-origin isolated too, so every script, style, font,
image or `fetch` it loads from **another** origin must allow CORS or send
`Cross-Origin-Resource-Policy: cross-origin`. Third-party analytics or captcha
scripts that do neither will not load inside PCBJam.

**Recommended layout:** serve the panel from its own origin, for example
`https://kicad.example.com/panel`, with only your own assets, and call your API
with `fetch` and CORS. Your main site stays untouched.

PCBJam checks both headers when a package is uploaded and names the missing one,
so a wrong setup never shows up as a blank frame.

## What PCBJam supports

| | Desktop KiCad 10 | PCBJam |
|---|---|---|
| `auth.type` | `none`, `oauth2` | `none` only, for now |
| `CAPABILITIES.compression` | `NONE`, `ZSTD` | `NONE`; a `ZSTD` payload is refused with `INVALID_PAYLOAD` |
| `PLACE_COMPONENT` / `DL_COMPONENT` manifests | download URLs on the panel or API origin, with sha256 and size | the same; downloads go through PCBJam's server, 4 MiB per asset |
| Inline `DL_SYMBOL`, `DL_FOOTPRINT`, `DL_COMPONENT` | yes | yes |
| Assets kept | symbol, footprint, 3D, SPICE | symbol and the first footprint; 3D and SPICE are accepted but not stored yet |
| Where parts go | a project library | the user's team library, named after your domain |
| `REMOTE_LOGIN` | opens the system browser | answered with `LOGIN_FAILED` |
| Placement | immediately | after the user confirms in PCBJam's prompt and clicks the canvas; `PLACE_COMPONENT` is answered `OK` once the part is saved |

PCBJam answers `CAPABILITIES`, `GET_KICAD_VERSION`, `LIST_SUPPORTED_VERSIONS`
and `GET_SOURCE_INFO` like desktop KiCad does. Unknown commands get
`UNKNOWN_COMMAND`, a stale session id `SESSION_MISMATCH`.

## Metadata

`https://<your origin>/.well-known/kicad-remote-provider` is KiCad's document,
validated against KiCad's schema. For example:

```json
{
  "provider_name": "Example Parts",
  "provider_version": "1.0.0",
  "api_base_url": "https://kicad.example.com/v1",
  "panel_url": "https://kicad.example.com/panel",
  "auth": { "type": "none" },
  "capabilities": { "web_ui_v1": true, "parts_v1": true, "direct_downloads_v1": true, "inline_payloads_v1": true },
  "max_download_bytes": 8388608,
  "supported_asset_types": ["symbol", "footprint", "3dmodel", "spice"],
  "parts": { "endpoint_template": "/v1/parts/{part_id}" }
}
```

- `api_base_url`, `panel_url` and every `download_url` must be `https` on a
  public host name: no ports, no `localhost`, no IP addresses, no
  `xn--` (internationalised) labels.
- Assets may only come from the origin of `panel_url` or of `api_base_url`.
- PCBJam re-reads this document every time the panel opens. You can change
  `panel_url` or limits freely; changing either **origin** stops the panel until
  users reinstall, because the origins are what they approved.

## A PLACE_COMPONENT manifest

```json
{
  "part_id": "r-10k-0603",
  "display_name": "R 10k 0603",
  "symbol_name": "R",
  "library_name": "Passives",
  "mode": "PLACE",
  "assets": [
    {
      "asset_type": "symbol",
      "name": "r.kicad_sym",
      "target_library": "Passives",
      "target_name": "R",
      "content_type": "application/x-kicad-symbol",
      "size_bytes": 3481,
      "sha256": "<hex sha256 of the served bytes>",
      "download_url": "https://kicad.example.com/downloads/r.kicad_sym",
      "required": true
    },
    {
      "asset_type": "footprint",
      "name": "R_0603_1608Metric.kicad_mod",
      "target_library": "Passives_SMD",
      "target_name": "R_0603_1608Metric",
      "content_type": "application/x-kicad-footprint",
      "size_bytes": 5120,
      "sha256": "<hex sha256 of the served bytes>",
      "download_url": "https://kicad.example.com/downloads/R_0603_1608Metric.kicad_mod"
    }
  ]
}
```

Each download must answer `200` directly (redirects are refused) with a
`Content-Type` equal to `content_type` and exactly `size_bytes` bytes whose
sha256 is `sha256`. Content types: `application/x-kicad-symbol`,
`application/x-kicad-footprint`, `model/step`, `application/x-spice`.

When something fails, your page gets the KiCad error it would get from the
desktop: `IMPORT_FAILED` with a message naming the reason (for example a digest
mismatch or a symbol PCBJam cannot accept), or `ACCESS_DENIED` when the user may
not write to their team library. If the save succeeded but the library write was
refused, the message ends with "Click Place again to retry"; placing again is
safe.

PCBJam handles one part at a time. A Place or download sent while the previous
one is still waiting for the user's confirmation or being saved gets
`IMPORT_FAILED` ("PCBJam is still handling the previous part") straight away;
send it again once the first request has been answered. Every message, whether
posted as a string or as an object, must stay under `max_message_size` from
`CAPABILITIES` (6 MiB); larger ones are dropped without an answer.

If the user's access to your provider ends while the panel is open (the package
is disabled or removed, or its approval is withdrawn), PCBJam answers any
pending request with `ACCESS_DENIED` and closes the panel.

## Package your provider

A provider is installed as a package with a single file, `manifest.json`
(`README.md` and `LICENSE.txt` are optional):

```json
{
  "apiVersion": 1,
  "kind": "remote-provider",
  "id": "example-parts",
  "name": "Example Parts",
  "version": "1.0.0",
  "description": "Search and place Example parts",
  "surfaces": ["editor:eeschema"],
  "permissions": ["provider:embed", "provider:download", "editor:place-items"],
  "provider": { "origin": "https://kicad.example.com" }
}
```

- `provider.origin` is where PCBJam reads your `/.well-known` document.
- `surfaces` and `permissions` must be exactly these values.
- Zip the file, or choose the folder, and install it with **Plugins → Add
  plugin…** in a schematic, like any plugin. The review shows the user your
  name, origins, panel URL and limits.
- PCBJam approves each provider origin once before it can be installed with the
  panel enabled. Ask PCBJam to review your origin when you are ready.
- To publish a change to the package itself, increase `version`. Changes to
  your panel page, catalog and assets need no new package.

## Test before you ask for review

- Run your panel with `EMBEDDERS` empty and open it in desktop KiCad 10 first:
  if it works there, the protocol side is right.
- Check the headers: `curl -sI https://kicad.example.com/panel` must show both.
- Check every download: `curl -s <download_url> | shasum -a 256` and the
  byte count must equal the manifest, and `curl -sI` must show the exact
  `Content-Type` and no redirect.
- A local server works for development if it is reachable over `https` on a
  public name, for example through a tunnel. Your package's `provider.origin`
  must then be that name.

## Checklist

- [ ] `https://<origin>/.well-known/kicad-remote-provider` returns the metadata with `"auth": {"type": "none"}`.
- [ ] `panel_url` answers `200` with both headers and no redirect.
- [ ] The panel includes the shim before its own script and lists the PCBJam origins that may embed it.
- [ ] Everything the panel loads from another origin allows CORS or sends `Cross-Origin-Resource-Policy: cross-origin`.
- [ ] Every `download_url` is on the panel or API origin, `https`, without redirects, with `Content-Type` equal to the manifest's `content_type`.
- [ ] `size_bytes` and `sha256` match the served bytes exactly.
- [ ] Each asset is at most 4 MiB, and a manifest's total is at most `max_download_bytes`.
- [ ] Inline payloads use `compression: "NONE"`.
- [ ] Every part has one symbol asset.

Plugins that run code inside PCBJam are a different package kind:
[Build a plugin](0008-local-plugin-development.md).
