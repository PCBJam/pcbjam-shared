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

Then you publish a one-file package that names your origin, and PCBJam reviews
that origin once, for every user.

Start from the [provider starter](download/remote-provider-starter.zip): a
dependency-free Node.js server with the metadata, a panel with the shim, part
manifests and downloads, ready to adapt. Questions and review requests go to the
[PCBJam Discord](https://discord.gg/ybhqJxjR3E).

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
    "https://pcbjam-editor-staging.pcbjam-staging.workers.dev",
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
- PCBJam's editor origins: `https://editor.pcbjam.com` (production) and
  `https://pcbjam-editor-staging.pcbjam-staging.workers.dev` (staging, where
  new provider features arrive first). Keep both while you test.

## Messages

Every message in either direction is one JSON object (the shim sends it as a
string) with only these keys; a message with any other key, or over 6 MiB, is
dropped without an answer:

| Key | Type | Meaning |
|---|---|---|
| `version` | number | `1`. Anything else is answered `UNSUPPORTED_VERSION`. |
| `session_id` | string | The id from PCBJam's `NEW_SESSION`. |
| `message_id` | integer ≥ 0 | Your own counter; increase it for each message. |
| `response_to` | integer | On a reply: the `message_id` it answers. |
| `command` | string | `NEW_SESSION`, `CAPABILITIES`, `PLACE_COMPONENT`, `DL_COMPONENT`, … |
| `status` | string | On a reply: `OK` or `ERROR`. |
| `error_code`, `error_message` | string | On an `ERROR` reply. |
| `parameters` | object | Command arguments. |
| `data` | string | Base64 payload for inline downloads. |

PCBJam opens every session with `NEW_SESSION` and your page **must answer it**,
with `response_to` set to PCBJam's `message_id`. Without that reply PCBJam
repeats `NEW_SESSION` every second, 10 times, and then shows the user that your
page did not answer. Use the `session_id` from it in every message; any other
id is answered `SESSION_MISMATCH`.

```json
← {"version":1,"session_id":"8d1f…","message_id":1,"command":"NEW_SESSION","status":"OK",
   "parameters":{"client_name":"PCBJam","client_version":"10.0","supported_versions":[1]}}
→ {"version":1,"session_id":"8d1f…","message_id":2,"response_to":1,"command":"NEW_SESSION","status":"OK",
   "parameters":{"server_name":"Example Parts","server_version":"1.0.0"}}
→ {"version":1,"session_id":"8d1f…","message_id":3,"command":"CAPABILITIES","parameters":{}}
← {"version":1,"session_id":"8d1f…","message_id":2,"response_to":3,"command":"CAPABILITIES","status":"OK",
   "parameters":{"commands":["NEW_SESSION","…"],"compression":["NONE"],"max_message_size":6291456}}
```

`←` is PCBJam to your page, `→` your page to PCBJam. A new page load (or a
navigation inside the frame) starts a new session with a new `session_id`.

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
| `PLACE_COMPONENT` / `DL_COMPONENT` manifests | download URLs on the panel or API origin, with sha256 and size | the same; downloads go through PCBJam's server, 4 MiB per asset and per part |
| Inline `DL_SYMBOL`, `DL_FOOTPRINT`, `DL_COMPONENT` | yes | yes |
| Assets kept | symbol, footprint, 3D, SPICE | symbol and the first footprint; 3D and SPICE are accepted but not stored yet |
| Where parts go | a project library | the user's team library, named after your domain |
| `REMOTE_LOGIN` | opens the system browser | answered with `LOGIN_FAILED` |
| Placement | immediately | after the user confirms in PCBJam's prompt and clicks the canvas; `PLACE_COMPONENT` is answered `OK` once the part is saved |

PCBJam answers `CAPABILITIES`, `GET_KICAD_VERSION`, `LIST_SUPPORTED_VERSIONS`
and `GET_SOURCE_INFO` like desktop KiCad does. Unknown commands get
`UNKNOWN_COMMAND`, a stale session id `SESSION_MISMATCH`.

Your page cannot learn who the user is, and `auth.type: "oauth2"` is refused at
upload, so account-specific pricing or stock is not possible in PCBJam yet.

## Metadata

`https://<your origin>/.well-known/kicad-remote-provider` is KiCad's document.
PCBJam's server fetches it through its outbound proxy, so it must be served
with `Content-Type: application/json` (optionally `; charset=utf-8`), without
compression (`Content-Encoding` absent or `identity`), directly (no redirect),
within 10 seconds and at most 64 KiB. For example:

```json
{
  "provider_name": "Example Parts",
  "provider_version": "1.0.0",
  "api_base_url": "https://kicad.example.com/v1",
  "panel_url": "https://kicad.example.com/panel",
  "auth": { "type": "none" },
  "capabilities": { "web_ui_v1": true, "parts_v1": true, "direct_downloads_v1": true, "inline_payloads_v1": true },
  "max_download_bytes": 4194304,
  "supported_asset_types": ["symbol", "footprint", "3dmodel", "spice"],
  "parts": { "endpoint_template": "/v1/parts/{part_id}" }
}
```

- Only these keys are allowed: `provider_name`, `provider_version`,
  `api_base_url`, `panel_url`, `session_bootstrap_url`,
  `allow_insecure_localhost`, `auth`, `capabilities`, `max_download_bytes`,
  `supported_asset_types`, `parts`, `documentation_url`, `terms_url`,
  `privacy_url`. Any other key rejects the document. `capabilities` takes only
  the four keys above, and `web_ui_v1` must be `true`.
- A part may total at most `max_download_bytes` **and** at most 4 MiB, whichever
  is smaller.
- PCBJam re-reads this document every time the panel opens. You can change
  `panel_url`, limits and capabilities freely, as long as both **origins** stay
  the same. Changing the origin of `panel_url` or `api_base_url` stops the
  panel for everyone (`PROVIDER_CHANGED`): see
  [Change your origin](#change-your-origin).
- `panel_url` is resolved like any URL: relative links in your page resolve
  against it, so `https://kicad.example.com/panel` and
  `https://kicad.example.com/panel/` load `assets/app.js` from different
  places. Prefer absolute paths.

### URL rules

`provider.origin`, `api_base_url`, `panel_url` and every `download_url` go
through PCBJam's proxy, which only accepts:

- `https` on the default port, with a lowercase public host name of at least
  two labels whose last label is 2–63 letters: no port, no user info, no IP
  address, no `localhost`, no `xn--` (internationalised) label, and no
  `.local`, `.internal`, `.test`, `.invalid` or `.onion` name;
- no host on `pcbjam.com`, `workers.dev`, `r2.dev` or `cloudflarestorage.com`;
- paths of letters, digits, `/`, `_`, `.` and `-` only: no `%`-encoding, `+`,
  `~` or `@`, no `//`, `.` or `..` segments;
- **no query string and no fragment**: signed download links such as
  `…/file.kicad_sym?X-Amz-Signature=…` are refused. Serve assets from stable
  paths instead;
- `provider.origin` in your package is an origin only: no path and no trailing
  slash (`https://kicad.example.com`).

Assets may only come from the origin of `panel_url` or of `api_base_url`.

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
      "download_url": "https://kicad.example.com/downloads/R_0603_1608Metric.kicad_mod",
      "required": false
    }
  ]
}
```

Send it as the `parameters` of a `PLACE_COMPONENT` (or `DL_COMPONENT`)
request. Only the keys shown plus `summary` and `license` are allowed, in the
manifest and in each asset.

- Every asset needs `asset_type`, `name`, `content_type`, `size_bytes`,
  `sha256`, `download_url` and `required` (a boolean). `target_library` and
  `target_name` are optional.
- At most 16 assets, each at most 4 MiB, and one of them a `symbol`.
- `asset_type` is one of `symbol`, `footprint`, `3dmodel`, `spice`, and must be
  listed in your metadata's `supported_asset_types`.
- `mode` is `PLACE` or `SAVE`; `PLACE_COMPONENT` always places.

Each download must answer `200` directly (redirects are refused) with a
`Content-Type` equal to `content_type`, no compression, and exactly
`size_bytes` bytes whose sha256 is `sha256`. Content types:
`application/x-kicad-symbol`, `application/x-kicad-footprint`, `model/step`,
`application/x-spice`. PCBJam allows about 30 seconds per download.

## Inline downloads

Instead of URLs, the part can travel in the message itself. `DL_COMPONENT`
puts the files in the envelope's top-level `data`: base64 of the UTF-8 JSON
array of entries, each `{type, name, content, compression}` where `content` is
the file's bytes in base64:

```js
const entries = [
  { type: "symbol", name: "R", content: btoa(symbolFileText), compression: "NONE" },
  { type: "footprint", name: "R_0603_1608Metric", content: btoa(footprintFileText), compression: "NONE" },
];
kicad.postMessage(JSON.stringify({
  version: 1, session_id, message_id: ++counter, command: "DL_COMPONENT",
  parameters: { compression: "NONE", library: "Passives", mode: "PLACE",
                part_id: "r-10k-0603", display_name: "R 10k 0603" },
  data: btoa(JSON.stringify(entries)),
}));
```

- `type` is `symbol`, `footprint`, `3dmodel` or `spice`; at most 16 entries,
  4 MiB in total after decoding. The first symbol and first footprint are kept.
- `name` is the item's name in the library; without it PCBJam uses
  `parameters.name` or the entry type.
- `compression` in `parameters` and in each entry must be `NONE`.
- `mode: "PLACE"` places the symbol after saving; without it the part is only
  saved. `part_id` and `display_name` are optional labels for the confirmation.
- `DL_SYMBOL`, `DL_FOOTPRINT`, `DL_3DMODEL` and `DL_SPICE` send a single file:
  `data` is that file's bytes in base64 (not a JSON array) and
  `parameters.name` names it. A `DL_SYMBOL` with `mode: "PLACE"` places it.
- `btoa` only accepts Latin-1 text: encode UTF-8 files (for example a `Ω` in a
  description) with `TextEncoder` first.

## Errors

When something fails your page gets an `ERROR` reply, as from desktop KiCad:

| `error_code` | When |
|---|---|
| `UNSUPPORTED_VERSION` | `version` is not `1` (or missing). |
| `INVALID_PARAMETERS` | `session_id` is missing. |
| `SESSION_MISMATCH` | `session_id` is not the current session's. |
| `UNKNOWN_COMMAND` | A command PCBJam does not handle. |
| `LOGIN_FAILED` | `REMOTE_LOGIN`: sign-in is not supported. |
| `INVALID_PAYLOAD` | Inline data is not valid base64/JSON, or uses a compression other than `NONE`. |
| `IMPORT_FAILED` | The part was refused; `error_message` says why. Also `Cancelled in PCBJam.` when the user declines, and "PCBJam is still handling the previous part" when a request arrives while another is pending. |
| `ACCESS_DENIED` | The user may not write to their team library, or their access to your provider ended. |

When PCBJam's proxy refused a download, `error_message` ends with the reason in
brackets: `(DIGEST_MISMATCH)`, `(SIZE_MISMATCH)`, `(CONTENT_TYPE_MISMATCH)`,
`(REDIRECT_DENIED)`, `(DESTINATION_DENIED)` (a URL breaks the URL rules or
resolves to a private address), `(INVALID_RESPONSE)` (for example a compressed
response), `(RESPONSE_TOO_LARGE)`, `(UPSTREAM_TIMEOUT)`, `(UPSTREAM_FAILED)`
(connection or TLS failure), `(UPSTREAM_STATUS_<n>)` (your server answered
status `<n>`) or `(RATE_LIMITED)` (too many downloads, see [Limits](#limits)). If the save succeeded but the library write was
refused, the message ends with "Click Place again to retry"; placing again is
safe. A message PCBJam cannot read at all (not JSON, unknown keys, too large)
is dropped without a reply, so give your requests a timeout.

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
- The ZIP (or folder) may contain only `manifest.json`, `README.md` and
  `LICENSE.txt`.
- Zip the file, or choose the folder, and install it with **Plugins → Add
  plugin…** in a schematic, like any plugin. The upload fetches your metadata
  and checks your panel's headers from PCBJam's server, so both must already be
  reachable over https. The review shows the user your name, origins, panel URL
  and limits.
- To publish a change to the package itself, increase `version`. Changes to
  your panel page, catalog and assets need no new package.

### Review

PCBJam reviews each provider origin **once, for everyone**. Until your origin
is approved, the upload succeeds and shows the review, but installing it fails
with "Remote provider awaits operator approval". Ask for the review on the
[PCBJam Discord](https://discord.gg/ybhqJxjR3E) with your origin and a contact.
Once it is approved, install it (or upload the same ZIP again, which reuses
the release); from then on every PCBJam user who uploads a package for that origin
can install and open it straight away. If PCBJam withdraws the approval, open panels
close and the provider stops working for everyone until it is approved again.

Users install your provider from the PCBJam marketplace
(`app.pcbjam.com/plugins`) once PCBJam publishes it there; ask on Discord.
Until then, only accounts with developer access can try it, by uploading your
package with **Plugins → Add plugin…**.

### Change your origin

The review is for your `provider.origin`. Each uploaded version also pins the
origins of your `panel_url` and `api_base_url` as they were at upload time; if
either origin later changes, open panels fail with `PROVIDER_CHANGED`.

- **Panel or API origin moved** (same `provider.origin`): publish a package
  with a **new `version`** and have users upload it. No new review is needed.
  Re-uploading the same version keeps the old origins, so the panel keeps
  failing.
- **`provider.origin` moved**: that is a new provider. Serve the new origin, ask
  on Discord for it to be reviewed, publish a new `version` with the new
  `provider.origin`, and have users upload it.

## Test before you ask for review

Until your origin is approved, PCBJam will not open your panel, so test the
protocol and your server first:

- Start from the [provider starter](download/remote-provider-starter.zip) and
  run it locally (`node serve.mjs`). Open it in desktop KiCad 10: if it works
  there, the protocol side is right. The starter's metadata sets
  `allow_insecure_localhost` so KiCad accepts `http://127.0.0.1:4400` while you
  develop; PCBJam itself only accepts https.
- Expose it over https with a tunnel on a public name, for example
  `cloudflared tunnel --url http://127.0.0.1:4400` (a `*.trycloudflare.com`
  name) or ngrok (`*.ngrok-free.app`); both pass the URL rules. Run the starter
  with `PUBLIC_ORIGIN=https://<tunnel name>`, and set `provider.origin` in your
  package to that name.
- Check what PCBJam will check:
  - `curl -s https://<origin>/.well-known/kicad-remote-provider` returns your
    metadata as `application/json`, uncompressed;
  - `curl -sI https://<origin>/panel` shows both isolation headers;
  - every `download_url`: `curl -s <url> | shasum -a 256` and the byte count
    equal the manifest, and `curl -sI` shows the exact `Content-Type` and no
    redirect.
- Upload the package: the upload itself checks your metadata and headers and
  shows your origins; installing waits for the review. Ask on Discord. A
  quick-tunnel name changes when the tunnel restarts, so ask for review of the
  origin you will actually serve from.

## Checklist

- [ ] `https://<origin>/.well-known/kicad-remote-provider` returns the metadata with `"auth": {"type": "none"}`.
- [ ] `panel_url` answers `200` with both headers and no redirect.
- [ ] The panel includes the shim before its own script and lists the PCBJam origins that may embed it.
- [ ] Everything the panel loads from another origin allows CORS or sends `Cross-Origin-Resource-Policy: cross-origin`.
- [ ] Every `download_url` is on the panel or API origin, `https`, without redirects, with `Content-Type` equal to the manifest's `content_type`.
- [ ] `size_bytes` and `sha256` match the served bytes exactly.
- [ ] Each asset is at most 4 MiB, and a part's total is at most 4 MiB and at most `max_download_bytes`.
- [ ] Every asset has `required` (`true` or `false`).
- [ ] No URL has a query string, a port, or characters outside `A–Z a–z 0–9 / _ . -` in its path.
- [ ] The metadata uses only the documented keys and is served as uncompressed `application/json`.
- [ ] Your page answers `NEW_SESSION` with `response_to` set to PCBJam's `message_id`.
- [ ] Inline payloads use `compression: "NONE"`.
- [ ] Every part has one symbol asset.

## Limits

| | Limit |
|---|---|
| Metadata document | 64 KiB, answered within 10 s |
| Message (either direction) | 6 MiB |
| Assets per manifest | 16 |
| One asset / one part | 4 MiB / the smaller of 4 MiB and `max_download_bytes` |
| Download time | about 30 s per asset |
| Parts in progress | one at a time per panel |
| Downloads through PCBJam | 30 per minute per provider and user, 90 per minute per user |
| Panel opens | 6 per minute per provider and user, 12 per minute per user |
| Open panels | 8 plugin panels per user |

Plugins that run code inside PCBJam are a different package kind:
[Build a plugin](0008-local-plugin-development.md).
