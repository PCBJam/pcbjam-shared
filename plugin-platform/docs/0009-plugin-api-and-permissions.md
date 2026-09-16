# Plugin API and permissions catalog

**Preview SDK v1 · 2026-09-16.** The reference below describes implemented APIs.
The last section distinguishes proposed extensions from callable methods.
Download `sdk.d.ts` through the [developer guide](0008-local-plugin-development.md)
for complete argument and response types. All host methods return promises.

## Implemented host APIs

This table and the SDK's host-method union are generated from the runtime's
allowlist. The build fails when they disagree. Parameter names and examples are
in the [author guide](0008-local-plugin-development.md#read-the-current-design).

<!-- BEGIN GENERATED HOST API -->
| Host method (`await pcbjam.…`) | Required permission | Result |
|---|---|---|
| `context.get` | Basic context | Editor name, read-only state, supported host methods and limits. |
| `project.getInfo` | `project:read-info` | Current project ID, scope, name and editor read-only state. |
| `documents.list` | `project:read-info` | Paged project design-file names; defaults cursor 0, limit 50. |
| `documents.getCurrent` | `documents:read` | Current document handle, name, revision and read-only state. |
| `documents.snapshot` | `documents:read` | Bounded canonical content at an exact document revision. |
| `documents.poll` | `documents:read` | Whether content changed since a revision; no event subscription. |
| `items.list` | `documents:read` | Paged item IDs, types and parents at an exact revision; optional type filter. |
| `items.get` | `documents:read` | Canonical bodies for up to 100 unique item IDs in the current document. |
| `selection.get` | `editor:read-selection` | Current item IDs, document revision and separate selection revision. |
| `storage.get` | `storage:local` | Value, found flag and namespace revision for a key. |
| `storage.set` | `storage:local` | Write JSON with expectedRevision; return the new namespace revision. |
| `storage.delete` | `storage:local` | Delete a key with expectedRevision; return the new namespace revision. |
| `storage.list` | `storage:local` | Sorted keys and namespace revision; never another plugin’s namespace. |
| `files.choose` | `files:choose` | Trusted file picker; returns a temporary handle or null on cancellation. |
| `files.readText` | `files:choose` | Read a chosen file through its instance-bound handle. |
| `files.close` | `files:choose` | Release a file handle; resolves to null. |
| `files.save` | `files:save` | Trusted text download confirmation; download-requested or cancelled. |
| `editor.requestPlacement` | `editor:place-items` | Hosted symbol placement: placed or cancelled; legacy lab: queued. |
<!-- END GENERATED HOST API -->

The table uses host method names. Call them through the SDK methods shown in
`sdk.d.ts`, for example `pcbjam.storage.get('settings')`, not a generic dispatcher.
`context.get().methods` lists host methods supported by the current grants,
editor and account state. It excludes unavailable placement in read-only editors.

## Compute and UI helpers

| Helper | Contract |
|---|---|
| `pcbjam.handle(name, handler)` | Register one of at most 32 commands; duplicate/invalid names rejected. |
| `pcbjam.randomUUID()` | Generate a random UUID; grants no authority. |
| `pcbjam.sexpr.parse(text)` | S-expression forms as nested arrays; atoms preserve quoting and numeric spelling. |
| `pcbjam.sexpr.print(forms)` | Convert those forms to compact text; whitespace is not preserved. |
| `pcbjam.sexpr.diff(before, after)` | Added/updated/removed UUIDs and `layoutChanged`; structural comparison, not electrical validation. Both texts must have the same root kind. |
| `await pcbjam.documents.getSexpr({document, revision})` | Read a permitted snapshot, then serialize it **inside QuickJS**; returns `{revision, text}`. Requires `documents:read`. |
| `await pcbjamUI.ready` / `pcbjamUI.call(command, params)` | Connect the iframe to registered guest handlers; no direct access to host methods. |

Compute helpers have no independent host grant. They execute within QuickJS's
CPU/heap/stack budgets. Parse/print/diff inputs are limited to 524,288 characters,
48 nesting levels and 12,000 forms; print also bounds AST nodes and rejects cycles.
They do not validate whether KiCad can safely import a design. Document
serialization is bounded to 1,048,576 output characters and uses the same CPU
budget. Helpers are not listed in `context.methods` because they are local SDK
functions, not new host operations.

## Resource and data boundaries

**Project:** metadata comes only from the project already open in the editor.
The design-file catalog contains names, kinds and the current-file flag; no
download URLs, tokens or arbitrary project lookup. It is the editor's current
loaded catalog, not a live server subscription. Refresh the editor to reload it.

**Document:** a handle is random and bound to this plugin instance's current
Yjs document. It cannot open a sibling document, a different project or an
arbitrary path. Reads contain canonical KiCad content only: root, item bodies,
layout and embedded library definitions. They exclude comments, presence,
collaborator identity, sync metadata and host credentials. Snapshot values are
copies, never `Y.Doc`, `Module`, pointers or shared WASM memory. Both stored
s-expression formats are normalized to the same `Slot` representation.

**Revisions:** content and selection revisions are independent counters scoped
to this instance. They are not persistent versions or proof of server commit.
A stale `revision` rejects the read; get the current revision and restart the
whole multi-page read. `poll` returns a change flag and revision, with no retained
history. Selection returns at most 1,000 IDs present in the current document.
An empty selection can also mean the editor has not reported one yet.

**Bounds:** snapshots and item responses have a 1 MiB serialized UTF-8 cap, plus
node/depth guards before conversion. Item pages and explicit item batches are
limited to 100; a document with more than 50,000 items is refused. Catalogs have
at most 5,000 loaded entries and 100 results per page. Large designs should use
small item batches rather than repeated full snapshots. Paging is for inspection;
there is no chunked full-file export API yet.

**Storage:** the trusted host chooses `(API service, authenticated account,
project scope, project ID, plugin ID)`. Callers can supply only a key, never a
namespace, user or project. Storage is unavailable without a known authenticated
account. A fresh `/api/me` check precedes host calls for signed-in instances;
logout, account mismatch or a failed check denies the operation. Account data
used for this check is not returned to the plugin. Project access still relies
on the editor's existing loading/authentication path; this preview has no new
server-side installation grants or immediate project-ACL revocation service.

Each storage namespace has at most 64 keys, 16 KiB of serialized JSON per value
and 256 KiB total. Keys are 1–64 ASCII letters/digits/dots/hyphens/underscores,
starting with a letter/digit. Values must be finite JSON. Every mutation supplies
the last observed namespace revision. A single IndexedDB transaction checks the
revision and quota and commits the update, so competing tabs cannot both succeed
with the same revision. Stopping the instance aborts pending transactions. A
completed transaction is not rolled back if the instance stops afterward.

Storage persists on this browser/origin, across document changes in the same
project and plugin version updates. Browser eviction or clearing site data can
remove it. Uninstall does **not** erase it in the preview; reinstalling the same
plugin ID in the same account/project can read it. Plugin authors can offer reset
using `list` and `delete`; don't store credentials. Local data is not encrypted
against other trusted code on the editor origin. Browser storage isolation is
origin-based; the plugin namespace is enforced by PCBJam's broker.
[IndexedDB terminology](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology).

**Downloads:** `files.save` supports text, JSON, CSV and KiCad file extensions,
with a simple basename and 512 KiB UTF-8 limit. PCBJam shows a separate trusted
confirmation. The result acknowledges browser download handoff, not successful
saving to disk. It cannot overwrite a specified filesystem path or save a project.

**Placement:** the existing confirmed symbol/footprint placement operation is
still the only editor write API. It uses the native tool and normal Undo and
collaboration. `queued` is not a successful parse, canvas commit or save receipt.
Native semantic validation and completion receipts remain production work.

## Permission and credential model

A release declares permissions; the user reviews and installs it. Every call is
checked against a fixed operation allowlist, strict input schema, current
instance/context and installed manifest. Unknown fields—including supplied user
IDs, namespaces and project selectors—are rejected. Output data is bounded.
Local computations do not grant document access. `ui:project-data` means the
user accepts data disclosure to this plugin's custom iframe. Do not assume the
iframe guarantees zero network egress.

The intended production grant intersection remains:

```text
release requests ∩ user-approved grants ∩ organization policy
                 ∩ user's current resource access ∩ editor capabilities
```

The preview has local release checks and current-editor context checks, but no
account installation records, organization policy or server activation grants.
API keys do not replace those controls. Deny by default and check each request.
[OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## Features deliberately unavailable

Existing app functionality does not automatically make its internal function a
safe public plugin API. These are explicit implementation gates, not aliases a
plugin can call today:

| Area | Why it is not exposed yet |
|---|---|
| Closed/sibling Yjs documents and subscriptions | Need authorized lazy loading, per-document handles, bounded event queues and gap recovery. Current reads/polling cover only the active document. |
| Arbitrary updates, diffs applied to Yjs, multi-document changes | Need reviewed semantic operations, revision/conflict checks, native Undo, collaboration and committed receipts. Raw Yjs updates could write unintended fields. |
| Library provider search/import | The app has providers, but lacks a bounded plugin-facing provider contract with scoped reads, conflicts, write consent and receipts. Chosen-file symbol/footprint placement is already available. |
| Generic WASM/native operations | Existing test hooks and arbitrary dispatchers are not a public permission boundary. Each operation needs its own validated adapter. No `Module`, pointer or function-name dispatcher is exposed. |
| User profile/identity | Needs a server-derived plugin-specific identity contract. The private account check for storage is not a public profile or backend assertion API. |
| Menus/toolbars/setup pages/tutorial anchors | Need a declarative contribution registry and ownership/cleanup/accessibility rules. The current custom UI surface is the right editor sidebar. |
| Project/app/site, symbol-editor and footprint-editor surfaces | No complete plugin lifecycle/adapters on those surfaces yet. Supported manifest surfaces are `editor:eeschema` and `editor:pcbnew`. |
| Public publishing/account installs | Need publisher ownership, scoped publishing credentials, per-user grants and consent/revocation lifecycle. The registry is still local and shared by the test environment. |
| Backend requests, identity signing, backend-to-PCBJam access | Need endpoint registration, SSRF defenses, request-bound assertions and optional scoped OAuth delegation. See the design below; no unrestricted fetch/proxy is enabled. |

## Credentials and user identity

### Installed plugin: permissions, no embedded key

The plugin's manifest selects requested permissions. The user approves them.
The trusted host binds API calls to that installation; a secret in a public ZIP
would add no reliable identity. Production host-to-server activation tokens, if
used, remain in trusted code and are short-lived, resource-bound and revocable.

### Publisher: a restricted publishing key

A future developer dashboard should issue a key for owned plugin IDs with
permissions such as `plugins:upload` or `plugins:publish`. Show its secret once;
store only a hash, key ID/prefix, owner, allowed plugin IDs/scopes, expiry,
revocation state and last-use metadata. Verify scope and ownership on every
upload/publish call. Publishing permission never grants project reads or edits.

Keep this key in the developer's CLI/CI secret store, never in plugin files,
browser storage, URLs or logs. Installing a release still requires user consent.
Changing a key's publishing scope cannot silently upgrade installed permissions.

### PCBJam calling the plugin's backend

The plugin asks to call a registered backend operation. PCBJam's server verifies
the signed-in user and installation, then constructs the outbound request and
attaches a short-lived identity assertion. The plugin does not sign itself.

The plugin backend verifies the assertion with PCBJam's published verification
keys: allowlisted algorithm/key, issuer, exact backend audience, token type,
expiry and issued-at bounds. It maps the plugin-specific `sub` to its own account.
A submitted `userId` in the body is not evidence of identity. A valid assertion
means PCBJam authorized the request on behalf of that user; it does not prove
the person physically clicked a button or authorize access back into PCBJam.

Where the backend needs proof for a particular request, also bind the signed
assertion to the exact method, canonical destination/path/query and body digest.
Use a short-lived unique `jti` and a backend replay cache; reject reused IDs and
altered bodies. Define canonicalization and signing test vectors together. Plain
bearer identity tokens alone are not proof that a body was unchanged. Keep signing
keys server-side and rotate verification keys with a bounded overlap window.

### The plugin's backend calling PCBJam

This is a separate future integration: user-approved OAuth delegation with
explicit scopes, project/document restrictions, audience, expiry and revocation.
Use authorization-code flows with PKCE where applicable, backend-held access
tokens, and protected/rotated refresh tokens. A service-account API key is only
appropriate for resources explicitly granted to that service account. Do not
reuse an identity assertion addressed to the plugin backend as a PCBJam token.

These credential boundaries follow OAuth's current security guidance on scope,
audience and public clients. [OAuth security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

PCBJam's current MCP API-key resolver maps a bearer key to a user; it is not a
fine-grained plugin authorization system. Reuse key hashing, expiry and revocation
primitives where appropriate, but add explicit scope/resource enforcement before
allowing those keys on plugin routes. Do not inherit the user's entire authority.

## Registered backend endpoints

The frontend should choose a registered operation and provide its payload.
It should not provide an unrestricted URL and arbitrary headers for the server
to fetch. A future release can request endpoint IDs; the authoritative registry
stores the approved HTTPS origins, path templates, methods, request/response
schemas, authentication strategy and disclosure policy. Installation grants are
bound to that endpoint policy's digest. Policy changes require review/consent.

For each call, validate the operation, substitute only validated path/query
parameters, strip caller-supplied cookies/auth/forwarding headers, and add only
the approved backend assertion. Reject non-HTTPS, userinfo, unexpected ports,
private/loopback/link-local/reserved IPs including IPv6 and mapped forms. Resolve
and validate DNS at connection time with infrastructure that prevents rebinding;
default to no redirects. If redirects are needed, reauthorize every hop and do
not forward credentials across origins. Bound upload, response, decompression,
duration and concurrency. A server-side proxy solves CORS but does not itself
make a request safe. [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

## Next implementation gates

The APIs above are implemented in the preview. Before public distribution, add
account-scoped installations and server authorization/revocation. Then add
cross-document loading and subscription backpressure, reviewed semantic writes
with native receipts, contribution surfaces, publisher accounts and backend
integration. A publishing key is never a shortcut to editor authority.

See the [test matrix](0010-plugin-security-and-testing.md) for the completed
checks and the additional requirements for each future capability.
