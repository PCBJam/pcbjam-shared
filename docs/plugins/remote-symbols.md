---
title: Remote Symbols
description: "Show your KiCad 10 Remote Symbols provider in PCBJam's schematic editor: shim, headers, metadata, sign-in, package and review."
created: 2026-09-23
updated: 2026-11-25
---

This page is for parts providers. If you already serve a **KiCad 10
remote-symbol provider** (the panel behind KiCad's *View → Panels → Remote
Symbols*), PCBJam can show the same panel in its schematic editor, under the
same name. At the end, PCBJam users search your catalog, click Place, and the
part lands in their team library and on their schematic.

The protocol is KiCad's, unchanged: the same `/.well-known/kicad-remote-provider`
document, the same JSON-RPC messages, the same `PLACE_COMPONENT` manifests. You
write no PCBJam plugin code. Two things differ, because your page runs in a
cross-origin `<iframe>` in a browser instead of KiCad's native web view:

1. **A bridge shim** of about 20 lines: KiCad injects `window.kicad` into your
   page; a browser can't, so your page provides it on top of `postMessage`.
2. **Two response headers** on the panel page: PCBJam's editor is cross-origin
   isolated, and a browser only embeds pages that opt in.

## Before you start

- A provider that works in desktop KiCad 10, or the
  [provider starter](download/remote-provider-starter.zip): a dependency-free
  Node.js server with the metadata, a panel with the shim, part manifests and
  downloads, ready to adapt.
- An https origin you control for the panel (and your API, if it is separate).
- A PCBJam account with developer access, to upload your package before it is
  published (see [Build a plugin](build-a-plugin.md#before-you-start)).

## Set up your provider

1. Add [the shim](#the-shim) to your panel page, before your own script.
2. Send [the headers](#the-headers) on the panel page and everything it loads.
3. Check your [metadata](#metadata) and download URLs against the
   [URL rules](#url-rules).
4. If your users sign in (`auth.type: "oauth2"`), prepare your sign-in server
   and your panel as [Sign-in](#sign-in) describes. A provider without sign-in
   skips this step.
5. [Test](#test-before-you-ask-for-review) with desktop KiCad and over an
   https tunnel.
6. [Package your provider](#package-your-provider): one `manifest.json` that
   names your origin.
7. Ask for the [review](#review) on the
   [PCBJam Discord](https://discord.gg/ybhqJxjR3E). PCBJam reviews your origin
   once, for every user.

The [checklist](#checklist) at the end repeats every requirement in one place.

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
- Send every message through `window.kicad.postMessage`. A panel that calls
  the webview's own channels directly (`webkit.messageHandlers`,
  `chrome.webview`) works in desktop KiCad and sends nothing in PCBJam.
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

**Framing.** Your page also has to let PCBJam show it inside the editor. A page
that sends `X-Frame-Options` (`DENY` or `SAMEORIGIN`), or a `frame-ancestors`
policy that does not name PCBJam's editor, would stay empty there, so PCBJam
refuses the package at upload and names the header. Do not just drop
`X-Frame-Options`, which would let any site frame your panel: replace it with a
`Content-Security-Policy` that names PCBJam's editor origins.

```http
Content-Security-Policy: frame-ancestors https://editor.pcbjam.com https://pcbjam-editor-staging.pcbjam-staging.workers.dev
```

Where a page sends `frame-ancestors`, browsers ignore `X-Frame-Options`, and so
does this check. Production and staging each check their own editor origin, so
keep both in the list if you test on staging.

## What PCBJam supports

| | Desktop KiCad 10 | PCBJam |
|---|---|---|
| `auth.type` | `none`, `oauth2` | `none`, and `oauth2` under the rules in [Sign-in](#sign-in) |
| `CAPABILITIES.compression` | `NONE`, `ZSTD` | `NONE`; a `ZSTD` payload is refused with `INVALID_PAYLOAD` |
| `PLACE_COMPONENT` / `DL_COMPONENT` manifests | download URLs on the panel or API origin, with sha256 and size | the same; downloads go through PCBJam's server, 4 MiB per asset and per part |
| Inline `DL_SYMBOL`, `DL_FOOTPRINT`, `DL_COMPONENT` | yes | yes |
| Assets kept | symbol, footprint, 3D, SPICE | symbol and the first footprint; 3D and SPICE are accepted but not stored yet |
| Where parts go | a project library | the user's team library, named after your domain |
| `REMOTE_LOGIN` | opens the system browser | opens a sign-in window in the user's browser, see [Sign-in](#sign-in); a provider without sign-in gets the same answer as from KiCad, `OK` with `auth_type: "none"` |
| Tokens | kept by KiCad, which signs the panel in again each time it opens | not kept; your page keeps its own session |
| Placement | immediately | after the user confirms in PCBJam's prompt and clicks the canvas; `PLACE_COMPONENT` is answered `OK` once the part is saved |

PCBJam answers `CAPABILITIES`, `GET_KICAD_VERSION`, `LIST_SUPPORTED_VERSIONS`
and `GET_SOURCE_INFO` like desktop KiCad does. Unknown commands get
`UNKNOWN_COMMAND`, a stale session id `SESSION_MISMATCH`.

PCBJam never tells your page who its user is. For account-specific pricing,
stock or private parts, sign your users in yourself: see [Sign-in](#sign-in).

## Sign-in

A provider whose users sign in with OAuth 2 in desktop KiCad can sign them in
inside PCBJam too. The steps are KiCad's; only the first one looks different,
because a browser has no system browser to hand over to.

1. Your page sends `REMOTE_LOGIN`. PCBJam answers at once and opens your
   sign-in server's authorization page in a window of its own. It asks for the
   authorization code flow with PKCE (`S256`), as a public client: PCBJam has
   no client secret.
2. Your sign-in server sends that window back to
   [PCBJam's callback address](#callback-addresses) with `code`, `state` and
   `iss`.
3. PCBJam's server sends the code to your token endpoint, then POSTs
   `{"access_token": "...", "next_url": "<your panel_url>"}` to your
   `session_bootstrap_url` and expects `{"nonce_url": "..."}`, as desktop
   KiCad does.
4. PCBJam loads your panel at `nonce_url`. Your page redeems the nonce, keeps
   **its own session**, and gets a new `NEW_SESSION`.

**PCBJam keeps nothing.** The access token exists on PCBJam's server only
while step 3 runs; no token, refresh token or session of your user is stored.
This is the one difference from desktop KiCad that your panel has to be built
for: PCBJam does not sign the panel in again the next time it opens. Your page
decides from its own session whether the user is signed in, and sends
`REMOTE_LOGIN` when it needs a new one.

### Sign-in in your metadata

```json
{
  "panel_url": "https://kicad.example.com/panel",
  "session_bootstrap_url": "https://kicad.example.com/session/bootstrap",
  "auth": {
    "type": "oauth2",
    "metadata_url": "https://auth.example.com/.well-known/oauth-authorization-server",
    "client_id": "kicad-remote-symbols",
    "scopes": ["parts.read"]
  }
}
```

- `auth.metadata_url` is your sign-in server's discovery document (RFC 8414).
  It follows the [URL rules](#url-rules).
- `auth.client_id` is the client PCBJam signs in with, unless your package
  names [a client of its own](#a-separate-client-for-pcbjam): 1 to 200
  printable ASCII characters. `auth.scopes` is optional: at most 32 distinct
  scope names.
- `session_bootstrap_url` is required, on the origin of `panel_url`, and
  follows the URL rules.

### Your sign-in server

PCBJam reads the discovery document **once, when your package is uploaded**,
and refuses the upload with the reason when a rule is not met. It must be
served like your provider metadata (`application/json`, uncompressed, no
redirect) and say:

| Field | Rule |
|---|---|
| `issuer` | A bare https origin without a path, for example `https://auth.example.com`. `auth.metadata_url` must be exactly `<issuer>/.well-known/oauth-authorization-server`. |
| `authorization_endpoint`, `token_endpoint` | On the issuer's origin, without a query string. |
| `response_types_supported` | Contains `code`. |
| `grant_types_supported` | When present, contains `authorization_code`. |
| `code_challenge_methods_supported` | Contains `S256`. |
| `token_endpoint_auth_methods_supported` | Contains `none`. |
| `authorization_response_iss_parameter_supported` | `true`. |

Three more rules:

- **Same registered domain.** The issuer's host and the host of your
  `provider.origin` must belong to one registered domain:
  `auth.example.com` for `kicad.example.com`, `api.example.com` for
  `example.com`. Hosts under a shared suffix of the public suffix list
  (`a.github.io` and `b.github.io`, two `pages.dev` sites) count as different
  domains. A hosted sign-in service on another domain is refused for now.
- **`iss` in every answer** (RFC 9207). Your server adds `iss=<issuer>` to
  every redirect back to the callback address, with a `code` and with an
  `error` alike. PCBJam compares it with `issuer` character for character. An
  answer without it, with two of them, or with another value (a trailing
  slash or another letter case is another value) ends the sign-in, and its
  code is never used.
- **Plain JSON from the token endpoint.** PCBJam's server sends a form POST
  (`grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`,
  `code_verifier`) and expects `200` with `application/json`, uncompressed and
  without a redirect, holding a non-empty `access_token` of at most 8 KiB and
  `token_type` `Bearer`.

These rules are stricter than desktop KiCad's on purpose: PCBJam shows many
providers to many users and makes sure no provider can receive another
provider's sign-in. An issuer with a path (a realm), an OpenID-only document
(`/.well-known/openid-configuration`) and a server that cannot send `iss` do
not work.

### Callback addresses

Register both on the client PCBJam uses, matched exactly, next to KiCad's own
loopback callback:

```text
https://editor.pcbjam.com/remote-provider-callback/<sign-in server host>
https://pcbjam-editor-staging.pcbjam-staging.workers.dev/remote-provider-callback/<sign-in server host>
```

`<sign-in server host>` is the host of your `issuer`, for example
`https://editor.pcbjam.com/remote-provider-callback/auth.example.com`.

### The session bootstrap and the nonce

`session_bootstrap_url` gets a JSON POST from PCBJam's server:
`{"access_token": "...", "next_url": "<your panel_url>"}`. Answer `200`,
`application/json`, with `{"nonce_url": "..."}`:

- `nonce_url` is https, on the origin of `session_bootstrap_url`, at most 2048
  characters, and does not contain the access token.
- Make the nonce single use and short lived. PCBJam loads it once.
- The page behind it removes the nonce from its address at once
  (`history.replaceState`), sends `Referrer-Policy: no-referrer`, and sends
  [the headers](#the-headers) like the panel itself.
- Token exchange and bootstrap together have about 30 seconds. PCBJam tries
  each once.

### `REMOTE_LOGIN` and `GET_SOURCE_INFO`

| Your page sends | PCBJam answers |
|---|---|
| `REMOTE_LOGIN` (`interactive` absent or `true`) | `OK`, `{"authenticated": false, "started": true}`, and the sign-in window opens. Sent again while that window is open, it starts over with a new window. |
| `REMOTE_LOGIN` with `interactive: false` | `OK`, `{"authenticated": false, "started": false}`. Nothing opens. |
| `REMOTE_LOGIN` with `sign_out: true` | `OK`, `{"authenticated": false, "signed_out": true}`. For a provider with sign-in PCBJam then loads your panel again at `panel_url`. It holds nothing to delete: end the session in your page before you send it. |
| `REMOTE_LOGIN` while a part is being saved, or while PCBJam finishes a sign-in | `ERROR`, `LOGIN_FAILED`. |
| `REMOTE_LOGIN` from a provider without sign-in | `OK`, `{"authenticated": false, "auth_type": "none"}`. |
| `GET_SOURCE_INFO` | `auth_type` is `oauth2` or `none`. `authenticated` is always `false`: PCBJam cannot see your page's session. |

- `started: true` means the window was asked for, not that the user signed
  in. Success arrives as a reload of your panel at `nonce_url`. Failure
  arrives as nothing: the user sees the reason in PCBJam ("Sign-in was
  cancelled", "The provider refused the sign-in", "Sign-in failed"), your page
  stays as it is, and its sign-in button must work again.
- Send `REMOTE_LOGIN` from a click in your page. Browsers open a window only
  shortly after a click. When the browser blocks the window anyway, PCBJam
  shows the user a "Sign in to <your name>" button of its own.
- While a sign-in runs, part commands are answered `IMPORT_FAILED` ("PCBJam is
  signing you in. Try again when it has finished.").
- A panel that waits for `authenticated: true` from the host stays signed out
  in PCBJam.

### Your page's session

Your page runs in a cross-site frame, so its storage follows the browser's
rules for such frames:

- Keep the session in the frame's own storage (`sessionStorage`,
  `localStorage`) or in partitioned cookies (`Partitioned`, CHIPS). Ordinary
  third-party cookies are blocked in the frame by most browsers.
- Browsers key that storage by PCBJam's site and browser profile, not by
  PCBJam account. Two PCBJam users of one browser profile share your session
  until one signs out. Show which account is signed in, and offer sign-out.
- Safari keeps a frame's `localStorage` only until the browser closes, so a
  session kept there asks for a new sign-in in every browser session.
- If your panel refreshes tokens, make sure that works for a session that
  started in PCBJam, with the client PCBJam used.

### A separate client for PCBJam

By default PCBJam signs in with the client in your metadata, the one desktop
KiCad uses, with PCBJam's callback addresses added to it. If you want PCBJam
on a client of its own (its own callbacks, its own line in your logs, switched
off without touching KiCad), name it in your PCBJam package:

```json
"provider": { "origin": "https://kicad.example.com", "oauthClientId": "pcbjam" }
```

- Register the two callback addresses on that client, and accept its tokens
  at `session_bootstrap_url`.
- A package that names a client is reviewed as its own configuration, and
  PCBJam approves it only when you, the provider, confirm that the client is
  yours.
- `oauthClientId` is refused for a provider without sign-in.

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
- With [sign-in](#sign-in), more is pinned when a package is uploaded:
  `auth.type`, `auth.metadata_url`, `auth.client_id`, `auth.scopes`,
  `session_bootstrap_url` and the whole `panel_url`. Changing any of them
  stops the panel (`PROVIDER_CHANGED`) until you publish a package with a new
  `version`: see [Change your sign-in](#change-your-sign-in).
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
| `LOGIN_FAILED` | `REMOTE_LOGIN` arrived while a part is being saved or while PCBJam is finishing a sign-in. Send it again afterwards. |
| `INVALID_PAYLOAD` | Inline data is not valid base64/JSON, or uses a compression other than `NONE`. |
| `IMPORT_FAILED` | The part was refused; `error_message` says why. Also `Cancelled in PCBJam.` when the user declines, "PCBJam is still handling the previous part" when a request arrives while another is pending, and "PCBJam is signing you in. Try again when it has finished." during a sign-in. |
| `ACCESS_DENIED` | The user may not write to their team library, or their access to your provider ended. |

When PCBJam's proxy refused a download, `error_message` ends with the reason in
brackets: `(DIGEST_MISMATCH)`, `(SIZE_MISMATCH)`, `(CONTENT_TYPE_MISMATCH)`,
`(REDIRECT_DENIED)`, `(DESTINATION_DENIED)` (a URL breaks the URL rules or
resolves to a private address), `(INVALID_RESPONSE)` (for example a compressed
response), `(RESPONSE_TOO_LARGE)`, `(UPSTREAM_TIMEOUT)`, `(UPSTREAM_FAILED)`
(connection or TLS failure), `(UPSTREAM_STATUS_<n>)` (your server answered
status `<n>`) or `(RATE_LIMITED)` (too many downloads, see [Limits](#limits)).

If the save succeeded but the library write was refused, the message ends with
"Click Place again to retry"; placing again is safe. A message PCBJam cannot read at all (not JSON, unknown keys, too large)
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
- `provider.oauthClientId` is optional, for a provider with sign-in only: see
  [A separate client for PCBJam](#a-separate-client-for-pcbjam).
- `surfaces` and `permissions` must be exactly these values.
- The ZIP (or folder) may contain only `manifest.json`, `README.md` and
  `LICENSE.txt`.
- Zip the file, or choose the folder, and install it with **Plugins → Add
  plugin…** in a schematic, like any plugin. The upload fetches your metadata
  and checks your panel's headers from PCBJam's server, so both must already be
  reachable over https. With sign-in it also reads your sign-in server's
  document. The review shows the user your name, origins, panel URL and
  limits, and where they will sign in.
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

With sign-in, the review covers your origin **and** your sign-in server, and
each configuration is reviewed on its own: your origin without sign-in, with
sign-in at a sign-in server, and with a client named by a package. Turning
sign-in on, or moving it to another server, therefore needs a new review, and
users who installed an earlier version are asked to agree again before they
update. Name your sign-in server when you ask.

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

### Change your sign-in

Each uploaded version pins one sign-in configuration (see
[Metadata](#metadata)). PCBJam reads your sign-in server's document at upload
only, so a change there is not noticed by itself.

- **Another client in your metadata, other scopes, a moved panel or bootstrap
  address:** publish a package with a new `version`. No new review.
- **Moved authorization or token endpoint** (same `issuer`): PCBJam keeps
  using the addresses it read at upload, so sign-in fails until you publish a
  new `version`. No new review.
- **Sign-in switched on, or another `issuer`:** a new `version`, a new review,
  and a new consent from each user.
- **Sign-in switched off:** a new `version`, and users are asked to agree to
  the update. No new review when your origin was approved without sign-in
  before.

## Test before you ask for review

Until your origin is approved, PCBJam won't open your panel, so test the
protocol and your server first:

1. Run the [provider starter](download/remote-provider-starter.zip) (or your
   own server) locally with `node serve.mjs`, and open it in desktop KiCad 10.
   If it works there, the protocol side is right. The starter's metadata sets
   `allow_insecure_localhost` so KiCad accepts `http://127.0.0.1:4400` while
   you develop; PCBJam itself only accepts https.
2. Expose it over https with a tunnel on a public name, for example
   `cloudflared tunnel --url http://127.0.0.1:4400` (a `*.trycloudflare.com`
   name) or ngrok (`*.ngrok-free.app`); both pass the URL rules. Run the
   starter with `PUBLIC_ORIGIN=https://<tunnel name>`, and set
   `provider.origin` in your package to that name.
3. Check what PCBJam will check:
   - `curl -s https://<origin>/.well-known/kicad-remote-provider` returns your
     metadata as `application/json`, uncompressed;
   - `curl -sI https://<origin>/panel` shows both isolation headers;
   - for every `download_url`, `curl -s <url> | shasum -a 256` and the byte
     count equal the manifest, and `curl -sI` shows the exact `Content-Type`
     and no redirect.
4. Upload the package. The upload itself checks your metadata and headers and
   shows your origins; installing waits for the review.
5. Ask for the review on Discord. A quick-tunnel name changes when the tunnel
   restarts, so ask for review of the origin you will actually serve from.

## Checklist

- [ ] `https://<origin>/.well-known/kicad-remote-provider` returns the metadata with `"auth": {"type": "none"}`, or with `"type": "oauth2"` and everything under "With sign-in" below.
- [ ] `panel_url` answers `200` with both headers and no redirect.
- [ ] The panel sends no `X-Frame-Options`; a `frame-ancestors` policy names the PCBJam editor origins instead.
- [ ] The panel includes the shim before its own script and lists the PCBJam origins that may embed it.
- [ ] The panel sends its messages through `window.kicad.postMessage`.
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

With sign-in:

- [ ] `auth.metadata_url` is `<issuer>/.well-known/oauth-authorization-server`, and the issuer is a bare https origin on your provider's registered domain.
- [ ] The sign-in server's document lists `code`, `S256` and the token endpoint auth method `none`, and sets `authorization_response_iss_parameter_supported` to `true`.
- [ ] Authorization and token endpoint are on the issuer's origin.
- [ ] Every redirect back to the callback address carries `iss`, also an error.
- [ ] Both PCBJam callback addresses are registered on the client PCBJam uses.
- [ ] The token endpoint answers a form POST from a public client with JSON, without a redirect.
- [ ] `session_bootstrap_url` is on the panel origin and returns a single-use `nonce_url` there.
- [ ] The page behind `nonce_url` sends both headers and `Referrer-Policy: no-referrer`, and removes the nonce from its address.
- [ ] The panel keeps its own session without ordinary third-party cookies, shows who is signed in, and offers sign-out.
- [ ] The panel's sign-in button works again after a sign-in that failed or was cancelled.

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
| Sign-ins | 6 per minute per provider and user, 12 per minute per user |
| Sign-in window | open for at most 5 minutes |
| Token exchange and session bootstrap | about 30 s together |
| Open panels | 8 plugin panels per user |

Plugins that run code inside PCBJam are a different package kind: see
[Build a plugin](build-a-plugin.md).
