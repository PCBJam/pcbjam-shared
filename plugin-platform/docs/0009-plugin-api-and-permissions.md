# Available APIs

**Plugin SDK v1.** Call `pcbjam` from plugin logic. All host methods return
promises; failures reject them. Use `(await pcbjam.context.get()).methods` to
check which operations the current editor, account and permissions allow.

Download [sdk.d.ts](download/sdk.d.ts) for full argument and response types.
Below, `ref` means `{document, revision}` from `documents.getCurrent()`;
`page` means optional `{cursor, limit}` (defaults: 0 and 50).
The `types` filter in `items.list()` is also optional.

## Host methods

Add the listed permission to your manifest, alongside the two required UI
permissions. `context.get()` needs no additional permission.

<!-- BEGIN GENERATED HOST API -->
| Call (`await pcbjam.…`) | Permission | Result |
|---|---|---|
| `http.request(endpointId, {method, path, json?})` | `network:<id>`; plus `backend:identity:<id>` for identity | Send bounded JSON to an operator-approved endpoint; optionally carries a signed user identity. |
| `context.get()` | None extra | Editor name, read-only state, supported host methods and limits. |
| `project.getInfo()` | `project:read-info` | Current project ID, scope, name and editor read-only state. |
| `documents.list(page)` | `project:read-info` | Paged project design-file names; defaults cursor 0, limit 50. |
| `documents.getCurrent()` | `documents:read` | Current document handle, name, revision and read-only state. |
| `documents.snapshot(ref)` | `documents:read` | Bounded canonical content at an exact document revision. |
| `documents.poll({document, since})` | `documents:read` | Whether content changed since a revision; no event subscription. |
| `items.list({...ref, ...page, types})` | `documents:read` | Paged item IDs, types and parents at an exact revision; optional type filter. |
| `items.get({...ref, ids, partial?})` | `documents:read` | Canonical bodies for up to 100 unique item IDs in the current document. With `partial: true`, oversized items return `{id, error}` instead of failing the call. |
| `selection.get()` | `editor:read-selection` | Current item IDs, document revision and separate selection revision. |
| `storage.get(key)` | `storage:local` | Value, found flag and namespace revision for a key. |
| `storage.set({key, value, expectedRevision})` | `storage:local` | Write JSON with expectedRevision; return the new namespace revision. |
| `storage.delete({key, expectedRevision})` | `storage:local` | Delete a key with expectedRevision; return the new namespace revision. |
| `storage.list()` | `storage:local` | Sorted keys and namespace revision; never another plugin’s namespace. |
| `files.choose({extensions})` | `files:choose` | Trusted file picker; returns a temporary handle or null on cancellation. |
| `files.readText(handle)` | `files:choose` | Read a chosen file through its instance-bound handle. |
| `files.close(handle)` | `files:choose` | Release a file handle; resolves to null. |
| `files.save({name, text})` | `files:save` | Trusted text download confirmation; download-requested or cancelled. |
| `editor.requestPlacement({label, sexpr})` | `editor:place-items` | Confirmed symbol placement: placed or cancelled. |
<!-- END GENERATED HOST API -->

## SDK helpers

These execute inside QuickJS; they do not grant additional access.

| Helper | Purpose |
|---|---|
| `pcbjam.handle(name, handler)` | Register a UI-callable command; up to 32. |
| `pcbjam.randomUUID()` | Generate a UUID for proposed items. |
| `pcbjam.sexpr.parse(text)` | Parse s-expressions into nested arrays; atoms retain their spelling and quotes. |
| `pcbjam.sexpr.print(forms)` | Serialize those arrays; original whitespace is not preserved. |
| `pcbjam.sexpr.diff(before, after)` | Return added/updated/removed UUIDs and `layoutChanged`; compares structure, not electrical correctness. |
| `await pcbjam.documents.getSexpr(ref)` | Read a snapshot, serialize it in QuickJS, return `{revision, text}`. Requires `documents:read`. |

In the UI, `await pcbjamUI.call(command, params)` invokes a registered handler
and returns its JSON result. It waits for connection automatically;
`pcbjamUI.ready` is also available. One UI command may be outstanding at a time.

## Read the current document

Requires `documents:read`:

```js
pcbjam.handle('inspect', async () => {
  const { document, revision } = await pcbjam.documents.getCurrent();
  return pcbjam.items.list({ document, revision, limit: 50 });
});
```

The result contains `{revision, items, nextCursor}`. Each item summary has
`{id, type, parent}`. Pass `nextCursor` as `cursor` with the **same revision**
to continue; `null` means finished. If the document changes, reread its revision
and restart paging. Item bodies from `items.get()` contain ordered slots:
`{atom}`, `{k, v}` or `{item}` references.

A large filled zone can exceed the response limit by itself. By default that
fails the whole `items.get()` call. Pass `partial: true` and such an entry comes
back as `{id, error}` while the other items are returned normally:
`TOO_LARGE` means the item cannot be read through this call at all;
`DEFERRED` means it did not fit in what was left of this response, so request
it again, alone or in a smaller batch. An unknown ID still fails the call.

Handles and revisions belong to this running instance. Only the active document
is readable; `documents.list()` lists project file names without opening them.
Responses are copies of design content, excluding comments, presence and
credentials. Editing a returned object does not edit the project.

## Store a setting

Requires `storage:local`:

```js
pcbjam.handle('saveSettings', async () => {
  const previous = await pcbjam.storage.get('settings');
  return pcbjam.storage.set({
    key: 'settings',
    value: { unit: 'mm' },
    expectedRevision: previous.revision
  });
});
```

The host selects the account/project/plugin namespace. A missing key returns
`{found: false, value: null, revision}`. Revisions cover the whole namespace:
on a competing write, read again before retrying. Keys use 1–64 letters, digits,
dots, underscores or hyphens and start with a letter/digit. Values must be JSON.
Storage is browser-local, can be evicted, and is not a secret store.

## Files and placement

File selection, downloads and placement approval use **PCBJam-owned controls**.

- `files.choose()` accepts `.kicad_sym`, `.kicad_mod`, `.txt` and `.json`.
  Cancellation returns `null`. Read the returned handle with `readText()`;
  release it with `close()`. Handles expire when the instance stops.
- `files.save()` accepts a basename ending in `.txt`, `.json`, `.csv`,
  `.kicad_sym`, `.kicad_mod`, `.kicad_sch` or `.kicad_pcb`.
  It returns `{status: 'download-requested'}` or `{status: 'cancelled'}`;
  download handoff is not proof of a saved file.
- `editor.requestPlacement()` accepts a bounded, self-contained schematic symbol
  with an embedded definition. It requires a writable schematic and enabled
  placement capability. It resolves to `{status: 'placed'}` after the user's
  canvas click and native commit, or `{status: 'cancelled'}`; errors reject.
  Show instructions while waiting: approve, then click the canvas or press Esc.
  Normal Undo and collaboration apply. Use the downloadable starter for the
  clipboard format. Footprint placement, external resources, simulation fields
  and unresolved inheritance are rejected.

## Limits and unavailable features

| Resource | Current limit |
|---|---|
| Snapshot or item response | 1 MiB serialized JSON; use small item batches for large designs. |
| Item page / explicit item batch | 100 items; documents over 50,000 items are refused. |
| File catalog / selection | 5,000 catalog entries; 1,000 selected IDs. |
| Chosen file / text download | 4 MiB / 512 KiB. |
| Storage | 64 keys, 16 KiB per value, 256 KiB per namespace. |
| Parse, print and diff | 524,288 input/output characters as applicable, 48 nesting levels, 12,000 forms. |
| Document serialization | 1,048,576 output characters; CPU budget still applies. |
| Private uploads | 32 retained releases, 64 MiB per account. |
| Response structure | 100,000 JSON nodes, 48 nesting levels. |
| Host calls | 40 per 10 seconds per running plugin. Calls over that are **delayed, not rejected**, so a sequential read loop simply slows down. At most 4 calls may be in flight: `await` each one. A fifth is rejected with `Too many pending API calls`. |
| UI commands | 20 per 10 seconds, 64,000 characters each, one at a time; exceeding this stops the plugin. Pace them with timers in `ui.html`. |
| Command duration | 120 seconds from UI command to result, including delayed host calls. |
| Account request budget | Shared by all your running plugins and tabs. When exhausted, host calls wait for the next minute once, then fail with `error.code === 'RATE_LIMITED'`; the plugin keeps running. |

The same numbers are in `(await pcbjam.context.get()).limits`. Plugin logic has
no timers: rely on the host's delay rather than retrying in a loop.

There is no raw WASM/pointer access, direct Yjs mutation, sibling-document loading,
change subscription, user-profile API, OAuth delegation
signing. The only current write operation is confirmed symbol placement.
The only UI surface is a floating panel in the schematic or PCB editor.

[Build a plugin](0008-local-plugin-development.md) ·
[Architecture](0010-plugin-security-and-testing.md).

## Backend requests

Declare the exact destination in `manifest.json` and include both grants in
`permissions` for identity-bearing requests:

```json
{
  "endpoints": {
    "backend": {
      "origin": "https://api.your-domain.example",
      "paths": ["/v1/preferences"],
      "methods": ["GET", "POST"],
      "auth": "pcbjam-user"
    }
  },
  "permissions": ["ui:custom", "ui:project-data", "network:backend", "backend:identity:backend"]
}
```

```ts
const response = await pcbjam.http.request('backend', {
  method: 'POST', path: '/v1/preferences', json: { library: 'My library' }
});
// { status, headers: { 'content-type': 'application/json' }, body }
```

One endpoint, up to 16 exact paths; HTTPS port 443 only. No query strings,
redirects, percent-encoded paths, custom headers or arbitrary URLs. `GET` has no
`json`; `POST` requires it. `auth: "none"` only needs the network grant and sends
no identity. Network permission allows sending data the plugin can read.

The full request is limited to 128 KiB and the uncompressed JSON response to
256 KiB; deadline 30 seconds. Limits: two concurrent calls per activation, four
per account, 20/minute per account/plugin and 60/minute per account. A returned
HTTP error status is still a response; transport/policy failures reject with an
`Error`, optionally carrying `code` (for example `BACKEND_NOT_APPROVED`,
`DOMAIN_NOT_VERIFIED`, `RATE_LIMITED`, `DESTINATION_DENIED`, `UPSTREAM_TIMEOUT`,
`REDIRECT_DENIED`, `RESPONSE_TOO_LARGE`, `INVALID_RESPONSE`). Do not blindly retry
writes: a timeout can follow a successful backend write.

With `pcbjam-user`, PCBJam attaches a 60-second ES256 assertion on the server.
Your backend uses the starter verifier with fixed issuer, audience and plugin UUID.
It checks the exact method, URL and raw body, then atomically rejects reused
request IDs in shared durable storage. Key data by verified `(issuer, subject)`;
the subject is stable for this user/plugin, without exposing their email or
PCBJam account ID. Keep the raw request bytes until verification. JWT decoding
alone is not verification. Never accept a fallback user ID from plugin input.

[Download backend source and verifier](download/backend-preferences-source.zip).
