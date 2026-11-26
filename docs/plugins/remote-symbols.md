---
title: Remote Symbols
description: "Show your KiCad 10 Remote Symbols provider in PCBJam's schematic editor: shim, headers, metadata, sign-in, package and review."
created: 2026-09-23
updated: 2026-11-26
---

This page is for parts providers. If you already serve a **KiCad 10
remote-symbol provider** (the panel behind KiCad's *View → Panels → Remote
Symbols*), PCBJam can show the same panel in its schematic editor. PCBJam users
search your catalog, click Place, and the part lands in their team library and
on their schematic.

Keep your KiCad messages, your `/.well-known/kicad-remote-provider` document
and your part manifests. You write no PCBJam plugin code. What changes follows
from one fact: in desktop KiCad your page runs in a web view that KiCad owns;
in PCBJam it runs in a cross-origin `<iframe>` inside a web page, and one
PCBJam shows many providers to many users.

1. [Embed your panel](#embed-your-panel): paste a shim of about 20 lines and
   set the response headers.
2. [Check your metadata and downloads](#check-your-metadata-and-downloads)
   against PCBJam's rules, which are stricter than KiCad's.
3. If your users sign in, prepare [sign-in](#sign-in-if-you-use-it).
4. [Package, test and publish](#package-test-and-publish).

You need a provider that works in desktop KiCad 10 (or the
[provider starter](download/remote-provider-starter.zip), a dependency-free
Node.js server with metadata, a panel with the shim, part manifests and
downloads), an https origin you control, and a PCBJam account with developer
access. For the access, sign up and post the account's email address and one
line about your provider on the
[PCBJam Discord](https://discord.gg/ybhqJxjR3E). Until PCBJam turns it on, the
editor has no **Plugins → Add plugin…**.

Your page never receives PCBJam cookies, tokens or project data, and PCBJam
never tells it who its user is. `postMessage` is its only channel.

## Embed your panel

### The shim

KiCad puts `window.kicad` into your page. A web page cannot put code into a
frame from another site, so your page provides it itself. Include this before
your panel script:

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

- **Send every message through `window.kicad.postMessage`.** A panel that
  calls the web view's own channels directly (`webkit.messageHandlers`,
  `chrome.webview`) works in desktop KiCad and sends nothing in PCBJam.
- **Receive in `window.kiclient.postMessage`**, as in KiCad. Messages that
  arrive before your client exists wait in `window.kicadMessages`:

  ```js
  window.kiclient = window.kiclient || {};
  window.kiclient.postMessage = handleMessage;
  for (const queued of window.kicadMessages || []) handleMessage(queued);
  window.kicadMessages = [];
  ```

- **`EMBEDDERS` lists who may talk to your page:** PCBJam's editor origins,
  production and staging (where new provider features arrive first). Keep
  both. An empty list accepts any embedder: use it only for local testing.
- You paste the shim instead of loading it from PCBJam, so no code of ours
  runs in your page. Inside desktop KiCad `window.kicad` already exists and
  the shim does nothing, so one page serves both.

### The headers

Serve the panel page (`panel_url`) directly, with `200` and no redirect, and
with both of these headers. With sign-in, the page your `nonce_url` opens
needs them too.

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

PCBJam's editor is cross-origin isolated, which it needs for its threads, and
a browser shows a frame on such a page only when the framed page opts in. The
first header also limits what your own page may load from **another** origin,
wherever it is opened: API calls with `fetch` and fonts need CORS, and what is
requested without CORS (a plain `<script>`, `<img>` or stylesheet) needs
`Cross-Origin-Resource-Policy: cross-origin`. Third-party analytics or captcha
scripts that send neither stop loading. Files from the panel's own origin need
nothing. The simplest layout is a panel on its own origin
(`https://kicad.example.com/panel`) with only your own assets.

If your page sends `X-Frame-Options`, replace it with this policy. Without
either, any site can frame your panel, so send it in any case:

```http
Content-Security-Policy: frame-ancestors https://editor.pcbjam.com https://pcbjam-editor-staging.pcbjam-staging.workers.dev
```

In KiCad your page is not a frame; in PCBJam it is, and `X-Frame-Options`
(`DENY` or `SAMEORIGIN`) forbids that. Add `'self'` if your own site frames
the panel too. If you already send a policy with `frame-ancestors`, change
that one: a second `Content-Security-Policy` header cannot loosen the first.

PCBJam checks the panel page's headers when a package is uploaded and names
the one that is wrong. Production and staging each check their own editor
origin, so keep both.

### The session

PCBJam speaks first. It sends `NEW_SESSION`, and your page **must answer it**
with `response_to` set to PCBJam's `message_id`. Without the reply PCBJam
repeats `NEW_SESSION` every second, 10 times, and then tells the user that
your page did not answer. Use the `session_id` from it in every message, with
`version` `1` and a `message_id` (an integer, 0 or more) that you increase for
each message. A new page load, or a navigation inside the frame, starts a new
session.

The messages are KiCad's JSON-RPC envelopes. PCBJam drops, without an answer,
a message that is not JSON, that has a key outside KiCad's envelope
(`version`, `session_id`, `message_id`, `response_to`, `command`, `status`,
`error_code`, `error_message`, `parameters`, `data`), or that is over the
message [limit](#errors-and-limits). Give your requests a timeout.

## Check your metadata and downloads

PCBJam's server, not the user's browser, reads your metadata and downloads
your part files, through an outbound proxy with strict rules.

**Metadata** (`https://<your origin>/.well-known/kicad-remote-provider`):

- Served as `application/json` (optionally `; charset=utf-8`), uncompressed
  and without a redirect.
- Only KiCad's keys: `provider_name`, `provider_version`, `api_base_url`,
  `panel_url`, `session_bootstrap_url`, `allow_insecure_localhost`, `auth`,
  `capabilities`, `max_download_bytes`, `supported_asset_types`, `parts`,
  `documentation_url`, `terms_url`, `privacy_url`. Any other key rejects the
  document. `capabilities` takes only `web_ui_v1` (must be `true`),
  `parts_v1`, `direct_downloads_v1` and `inline_payloads_v1`.
- `auth.type` is `none`, or `oauth2` under the rules in
  [Sign-in](#sign-in-if-you-use-it).
- PCBJam reads the document again each time the panel opens. What you may
  change without a new package is in
  [Update an installed provider](#update-an-installed-provider).

**URLs.** These rules hold for `provider.origin`, `api_base_url`, `panel_url`,
every `download_url` and, with sign-in, `session_bootstrap_url`,
`auth.metadata_url`, `authorization_endpoint` and `token_endpoint`:

- `https` on the default port, with a lowercase public host name of at least
  two labels whose last label is 2 to 63 letters: no port, no user info, no IP
  address, no `localhost`, no `xn--` label, no `.local`, `.internal`, `.test`,
  `.invalid` or `.onion` name, and no host on `pcbjam.com`, `workers.dev`,
  `r2.dev` or `cloudflarestorage.com`.
- Paths of letters, digits, `/`, `_`, `.` and `-` only, at most 512
  characters: no `%`-encoding, no `//`, no `.` or `..` segments.
- **No query string and no fragment.** A signed download link such as
  `…/file.kicad_sym?X-Amz-Signature=…` is refused. Serve assets from stable
  paths.
- Assets may only come from the origin of `panel_url` or of `api_base_url`.

**Downloads.** PCBJam's server fetches each `download_url` **without your
user's session**: no cookie and no token. If a file needs the session, fetch
it in your panel and send it [inline](#parts). Each download must answer `200`
directly (no redirect), with a `Content-Type` equal to the asset's
`content_type`, no compression, and exactly `size_bytes` bytes. `sha256` is the
SHA-256 of the served bytes as 64 hexadecimal digits.

## Package, test and publish

A provider is installed as a package with one file, `manifest.json`
(`README.md` and `LICENSE.txt` are optional, nothing else is allowed):

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

`provider.origin` is where PCBJam reads your `/.well-known` document: an
origin only, without a path or a trailing slash. `surfaces` and `permissions`
must be exactly these values. With sign-in, do
[Sign-in](#sign-in-if-you-use-it) before you upload. Then, in this order:

1. **A public https name.** PCBJam accepts only https. Deploy your provider,
   or expose a local one with a tunnel
   (`cloudflared tunnel --url http://127.0.0.1:4400`, or ngrok), and set
   `provider.origin` to that name. Start the starter with
   `PUBLIC_ORIGIN=https://parts.example.com node serve.mjs`, with your own
   origin, so that its metadata and download URLs use it. A quick tunnel's
   name changes when it restarts, so ask for the review of the origin you
   will really serve from.
   Test sign-in on your own domain: a tunnel's name is not on your sign-in
   server's registered domain.
2. **What PCBJam's server will see.** These show the headers of a `GET`
   without following redirects, and the digest of a download:

   ```sh
   ORIGIN=https://parts.example.com   # yours, like PANEL_URL and DOWNLOAD_URL
   curl -sS -D - -o /dev/null "$ORIGIN/.well-known/kicad-remote-provider"
   curl -sS -D - -o /dev/null "$PANEL_URL"
   curl -sS "$DOWNLOAD_URL" | shasum -a 256
   ```

3. **Upload** the ZIP, or the folder, with **Plugins → Add plugin…** in a
   schematic (this needs developer access). The upload reads your metadata,
   checks the panel's headers and, with sign-in, reads your sign-in server's
   document. It names what is wrong.
4. **Ask for the review** on the PCBJam Discord, with your origin, your
   sign-in server if you have one, and a contact. Your page is shown inside
   PCBJam to every user who installs it, so PCBJam reviews your origin once,
   for everyone; with sign-in, your origin and your sign-in server together.
   Until then installing fails with "Remote provider awaits operator
   approval". Afterwards install the package, or upload the same ZIP again,
   which reuses the release.
5. **Try it in PCBJam.** Open the provider from **Plugins** in a schematic.
   The panel appears and answers `NEW_SESSION`. Place a part, confirm it,
   click the canvas, and find the symbol and its footprint in the team library
   named after your domain. With sign-in also cancel a sign-in and start it
   again, complete one, close and reopen the panel, and sign out.
6. **Ask for publication** on the PCBJam Discord. Until PCBJam publishes
   your provider in the marketplace (`app.pcbjam.com/plugins`), only accounts
   with developer access can use it.

The upload cannot see what your page does. Check these yourself: the shim and
`window.kicad.postMessage`; `iss` also on an error answer; the page behind
`nonce_url` (both headers, `Referrer-Policy: no-referrer`, the nonce removed
from its address); a sign-in button that works again after a sign-in that
failed or was cancelled.

If PCBJam withdraws the approval, open panels close and the provider stops
working for everyone until it is approved again.

## Sign-in, if you use it

A provider whose users sign in with OAuth 2 in desktop KiCad can sign them in
inside PCBJam too. The steps are KiCad's, with two differences: a web page
cannot listen on a loopback address, so the answer comes back to a page on
PCBJam's editor; and PCBJam keeps no tokens.

1. Your page sends `REMOTE_LOGIN`, from a click. PCBJam opens your sign-in
   server's authorization page in a window of its own. It asks for the
   authorization code flow with PKCE (`S256`), as a public client without a
   secret.
2. Your sign-in server sends that window back to PCBJam's
   [callback address](#callback-addresses) with `code`, `state` and `iss`.
3. PCBJam's server sends the code to your token endpoint, then POSTs
   `{"access_token": "...", "next_url": "<your panel_url>"}` to your
   `session_bootstrap_url` and expects `{"nonce_url": "..."}`, as desktop
   KiCad does.
4. PCBJam loads your panel at `nonce_url`. Your page redeems the nonce and
   keeps **its own session**.

PCBJam discards the token after step 3 and stores nothing of your user. So,
unlike desktop KiCad, it does not sign the panel in again the next time it
opens. Your page decides from its own session whether the user is signed in,
and sends `REMOTE_LOGIN` when it needs a new one.

### In your metadata

Keep your existing metadata and add or replace these fields:

```json
{
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
- `auth.client_id` is the client PCBJam signs in with, unless your package
  names [a client of its own](#callback-addresses): 1 to 200 printable ASCII
  characters. `auth.scopes` is optional: at most 32 distinct scope names of
  at most 128 characters each.
- `session_bootstrap_url` is required and on the origin of `panel_url`.

### Your sign-in server

PCBJam reads the discovery document **once, when your package is uploaded**,
and refuses the upload with the reason when a rule is not met. It must be
served like your provider metadata and say:

| Field | Rule |
|---|---|
| `issuer` | A bare https origin without a path, for example `https://auth.example.com`. `auth.metadata_url` must be exactly `<issuer>/.well-known/oauth-authorization-server`. |
| `authorization_endpoint`, `token_endpoint` | On the issuer's origin, without a query string. |
| `response_types_supported` | Contains `code`. |
| `grant_types_supported` | When present, contains `authorization_code`. |
| `code_challenge_methods_supported` | Contains `S256`. |
| `token_endpoint_auth_methods_supported` | Contains `none`. |
| `authorization_response_iss_parameter_supported` | `true`. |

Three more rules. They are stricter than desktop KiCad's because PCBJam signs
many users in at many providers' sign-in servers, and no provider may receive
another provider's sign-in:

- **Same registered domain.** The issuer's host and the host of your
  `provider.origin` must belong to one registered domain: `auth.example.com`
  for `kicad.example.com`, `api.example.com` for `example.com`. Hosts under a
  shared suffix of the public suffix list (`a.github.io` and `b.github.io`,
  two `pages.dev` sites) count as different domains.
- **`iss` in every answer** (RFC 9207). Your server adds `iss=<issuer>` to
  every redirect back to the callback address, with a `code` and with an
  `error` alike. It tells PCBJam which server answered. PCBJam compares it
  with `issuer` character for character: an answer without it, with two of
  them, or with another value (a trailing slash or another letter case is
  another value) ends the sign-in, and its code is never used.
- **Plain JSON from the token endpoint.** PCBJam's server sends a form POST
  (`grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`,
  `code_verifier`) and expects `200` with `application/json`, uncompressed and
  without a redirect, holding a non-empty `access_token` of at most 8 KiB and
  `token_type` `Bearer`.

So these do not work: an issuer with a path (a realm), a document published
only as `/.well-known/openid-configuration`, a server that cannot send `iss`,
and a hosted sign-in service on another domain than your provider.

### Callback addresses

A sign-in server only sends answers to addresses it knows. Register both,
matched exactly, next to KiCad's own loopback callback:

```text
https://editor.pcbjam.com/remote-provider-callback/<sign-in server host>
https://pcbjam-editor-staging.pcbjam-staging.workers.dev/remote-provider-callback/<sign-in server host>
```

`<sign-in server host>` is the host of your `issuer`, for example
`https://editor.pcbjam.com/remote-provider-callback/auth.example.com`. The
address ends in that host so that an answer says which server it was meant
for.

Register them on the client PCBJam uses. By default that is `auth.client_id`
in your metadata, the client desktop KiCad uses. Or give PCBJam a client of
its own (its own callbacks, its own line in your logs, switched off without
touching KiCad), register the two addresses on that one, and name it in your
package:

```json
"provider": { "origin": "https://kicad.example.com", "oauthClientId": "pcbjam" }
```

Your `session_bootstrap_url` must accept that client's tokens. Such a package
is reviewed on its own, and PCBJam approves it only when you confirm that the
client is yours. `oauthClientId` is refused for a provider without sign-in.

### The bootstrap and the nonce

The POST to `session_bootstrap_url` comes from PCBJam's server, not from the
browser, so its answer cannot set the browser's session. Answer `200` with
`application/json`. The session starts when your page redeems the nonce
inside the frame.

- `nonce_url` is https, on the origin of `session_bootstrap_url`, at most 2048
  characters, and does not contain the access token.
- Make the nonce single use and short lived. PCBJam loads it once.
- The page behind it removes the nonce from its address at once
  (`history.replaceState`), and sends `Referrer-Policy: no-referrer` and
  [the headers](#the-headers).
- Token exchange and bootstrap together have about 30 seconds. PCBJam tries
  each once.

### What your page sees

| Your page sends | PCBJam answers |
|---|---|
| `REMOTE_LOGIN` (`interactive` absent or `true`) | `OK`, `{"authenticated": false, "started": true}`, and PCBJam asks the browser for the sign-in window. Sent again while that window is open, it starts over with a new window. |
| `REMOTE_LOGIN` with `interactive: false` | `OK`, `{"authenticated": false, "started": false}`. Nothing opens. |
| `REMOTE_LOGIN` with `sign_out: true` | `OK`, `{"authenticated": false, "signed_out": true}`. For a provider with sign-in PCBJam then loads your panel again at `panel_url`. It holds nothing to delete: end the session in your page before you send it. |
| `REMOTE_LOGIN` while a part is being saved, or while PCBJam finishes a sign-in | `ERROR`, `LOGIN_FAILED`. Send it again afterwards. |
| `REMOTE_LOGIN` from a provider without sign-in | `OK`, `{"authenticated": false, "auth_type": "none"}`, as from KiCad. |
| `GET_SOURCE_INFO` | `auth_type` is `oauth2` or `none`. `authenticated` is always `false`: PCBJam cannot see your page's session, so a panel that waits for `authenticated: true` stays signed out. |

- `started: true` means the window was asked for, not that the user signed
  in. Success arrives as a reload of your panel at `nonce_url`. Failure
  arrives as nothing: the user sees the reason in PCBJam, your page stays as
  it is, and its sign-in button must work again.
- Browsers open a window only shortly after a click. When the browser blocks
  the window anyway, PCBJam shows the user a sign-in button of its own.

### Your page's session

Your page runs in a cross-site frame, so its storage follows the browser's
rules for such frames:

- Keep the session in the frame's own storage (`sessionStorage`,
  `localStorage`) or in partitioned cookies (`Partitioned`, CHIPS). Ordinary
  third-party cookies are blocked in the frame by most browsers.
- Browsers key that storage by PCBJam's site and browser profile, not by
  PCBJam account. Two PCBJam users of one browser profile share your session
  until one signs out. Show which account is signed in, and offer sign-out.
- A browser may clear the frame's storage (Safari does when it closes). Offer
  sign-in again when the session is gone.
- If your panel refreshes tokens, make sure that works for a session that
  started in PCBJam, with the client PCBJam used.

## Parts

PCBJam handles your `PLACE_COMPONENT` and `DL_*` messages like desktop KiCad,
with these differences. Sizes are under [limits](#errors-and-limits).

| | Desktop KiCad 10 | PCBJam |
|---|---|---|
| Compression | `NONE`, `ZSTD` | `NONE` only. `ZSTD` is refused with `INVALID_PAYLOAD`. |
| Assets kept | symbol, footprint, 3D, SPICE | The first symbol and the first footprint. 3D and SPICE are accepted but not stored yet. |
| Where parts go | a project library | The user's team library, named after your domain. |
| Placement | at once | After the user confirms in PCBJam's prompt, which shows the part name and your origin, and clicks the canvas. The request is answered `OK` once the part is saved. |

**A manifest** (the `parameters` of `PLACE_COMPONENT`, or of `DL_COMPONENT`
with `assets`) is KiCad's, checked strictly:

- Top-level keys: `part_id`, `display_name` and `assets`, and optionally
  `summary`, `license`, `symbol_name`, `library_name` and `mode`. Any other
  key rejects the manifest.
- Each asset has `asset_type`, `name`, `content_type`, `size_bytes`, `sha256`,
  `download_url` and `required` (a boolean), and optionally `target_library`
  and `target_name`. Nothing else: `summary` and `license` are not allowed
  inside an asset.
- `asset_type` is `symbol`, `footprint`, `3dmodel` or `spice`, and listed in
  your `supported_asset_types`. One asset must be a `symbol`.
- `content_type` is `application/x-kicad-symbol`,
  `application/x-kicad-footprint`, `model/step` or `application/x-spice`.
- `mode` is `PLACE` or `SAVE`. `PLACE_COMPONENT` always places;
  `DL_COMPONENT` places only with `mode: "PLACE"`.

**Inline.** Instead of URLs, the files can travel in the message. This is the
way for files that need your user's session. `DL_COMPONENT` puts them in the
envelope's top-level `data`: base64 of the UTF-8 JSON array of entries, each
`{type, name, content, compression}`, where `content` is the file's bytes in
base64. This is KiCad's format. Encode the file's bytes: for text, get the
UTF-8 bytes with `TextEncoder` and base64-encode those bytes. `btoa(text)`
fails on a character like `Ω`, and `btoa` of the byte array encodes the wrong
thing.

- The files are encoded twice, so the finished message reaches the message
  limit at about 3.3 MiB of files, below the limit for a part. Measure the
  message: one that is too large is dropped without an answer.
- `type` is `symbol`, `footprint`, `3dmodel` or `spice`. `name` is the item's
  name in the library; without it PCBJam uses `parameters.name` or the entry
  type. `compression`, in `parameters` and in each entry, is `NONE` or left
  out.
- `part_id` and `display_name` are optional labels for the confirmation.
- `DL_SYMBOL`, `DL_FOOTPRINT`, `DL_3DMODEL` and `DL_SPICE` send a single file:
  `data` is that file's bytes in base64 (not a JSON array) and
  `parameters.name` names it. A `DL_SYMBOL` with `mode: "PLACE"` places it.

## Update an installed provider

Raise `version` in `manifest.json` whenever you change the package itself.
PCBJam also pins some things when a package is uploaded. A change to one of
them needs a new version too; until users have it, the old version stops with
`PROVIDER_CHANGED`, or keeps using the old address.

| What you change | New version | New review |
|---|---|---|
| Panel page, catalog, assets; limits and capabilities in the metadata | no | no |
| `panel_url` on the same origin, provider without sign-in | no | no |
| The origin of `panel_url` or of `api_base_url` | yes | no |
| `provider.origin` | yes | yes, it is a new provider |
| With sign-in: `panel_url`, `session_bootstrap_url`, `auth.scopes` (their order does not count), or `auth.client_id` unless your package names its own client | yes | no |
| Authorization or token endpoint moved, same `issuer` | yes | no |
| Sign-in switched on, or another `issuer` | yes | yes |
| Sign-in switched off | yes | no, when your origin was approved without sign-in before |
| The client named by your package (`oauthClientId`) | yes | yes |

- PCBJam reads your sign-in server's document at upload only. After you move
  an endpoint, installed versions keep calling the old address: keep it
  working until your users have the new version.
- Users are asked to agree again when sign-in is switched on or off, or moves
  to another sign-in server.
- Uploading the same version again keeps what was pinned, so the panel keeps
  failing.

## Errors and limits

Errors arrive as `ERROR` replies with KiCad's codes (`UNSUPPORTED_VERSION`,
`INVALID_PARAMETERS`, `SESSION_MISMATCH`, `UNKNOWN_COMMAND`). PCBJam answers
`CAPABILITIES`, `GET_KICAD_VERSION` and `LIST_SUPPORTED_VERSIONS` like desktop
KiCad. What differs:

| Situation | What your page gets |
|---|---|
| A message PCBJam cannot read (not JSON, unknown key, too large) | No reply. |
| The user declines the part | `IMPORT_FAILED`, "Cancelled in PCBJam." |
| A part request while another waits for the user or is being saved | `IMPORT_FAILED` at once. Send it again when the first is answered. |
| A part request during a sign-in | `IMPORT_FAILED`. Try again when it has finished. |
| The part was refused | `IMPORT_FAILED`; `error_message` says why. |
| PCBJam's proxy refused a download | `IMPORT_FAILED`; `error_message` ends with the reason in brackets, see below. |
| The download worked but the library write was refused | The message ends with "Click Place again to retry". Placing again is safe. |
| Inline data that is not valid base64 or JSON, or is compressed | `INVALID_PAYLOAD` |
| The user may not write to their team library | `ACCESS_DENIED` |
| The user's access to your provider ended (package disabled or removed, approval withdrawn) | `ACCESS_DENIED` for any pending request, and PCBJam closes the panel. |

Proxy reasons: `(DIGEST_MISMATCH)`, `(SIZE_MISMATCH)`,
`(CONTENT_TYPE_MISMATCH)`, `(REDIRECT_DENIED)`, `(DESTINATION_DENIED)` (a URL
breaks the URL rules or resolves to a private address), `(INVALID_RESPONSE)`
(for example a compressed response), `(RESPONSE_TOO_LARGE)`,
`(UPSTREAM_TIMEOUT)`, `(UPSTREAM_FAILED)` (connection or TLS failure),
`(UPSTREAM_STATUS_<n>)` (your server answered status `<n>`) and
`(RATE_LIMITED)`.

| | Limit |
|---|---|
| Metadata document | 64 KiB, answered within 10 s |
| Message (either direction) | 6 MiB |
| Assets per manifest, entries per inline bundle | 16 |
| One asset / one part | 4 MiB / the smaller of 4 MiB and `max_download_bytes` |
| Download time | about 30 s per asset |
| Parts in progress | one at a time per panel |
| Downloads through PCBJam | 30 per minute per provider and user, 90 per minute per user |
| Panel opens | 6 per minute per provider and user, 12 per minute per user |
| Sign-ins | 6 per minute per provider and user, 12 per minute per user |
| Sign-in window | open for at most 5 minutes |
| Open panels | 8 plugin panels per user |
