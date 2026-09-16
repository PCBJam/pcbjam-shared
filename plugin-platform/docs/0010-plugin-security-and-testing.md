# Plugin security and testing

**Preview SDK v1.** This page explains the boundaries your plugin must respect
and the cases to test before sharing a package. See the [developer guide](0008-local-plugin-development.md)
and [API reference](0009-plugin-api-and-permissions.md) for callable methods.

## Where your code runs

Your logic runs in QuickJS inside a dedicated browser Worker. QuickJS has bounded
CPU turns, stack and heap. It has no browser, Node.js, network, cookie or native
editor access. PCBJam supplies a small SDK that sends validated requests through
a trusted wrapper. Results are copies; you never receive a `Y.Doc`, WASM pointer,
`Module` object or shared editor memory.

Your custom UI runs in a separate iframe with an opaque origin and
`sandbox="allow-scripts"`. Its Content Security Policy restricts scripts, styles,
network requests, frames and browser features. Bundle React, JavaScript and CSS
inside the package. Do not depend on remote fonts, CDNs or a development server.
The UI can call commands that your logic registered; it cannot call host APIs
directly. PCBJam checks the channel independently of the convenience SDK.

Iframe JavaScript does not have QuickJS's CPU or memory budgets. CSP blocks the
network channels tested by PCBJam, but arbitrary UI is not a guarantee of zero
data disclosure. Treat information passed to your custom UI as disclosed to
that plugin. Only request design access when the feature needs it.

## What authorizes a request

A signed-in user uploads a private release and reviews its requested permissions.
The release is immutable and pinned by content hashes. Opening it creates an
activation tied to that user, session, installed release, current project and
current document. Each host request checks the installed grants and fresh server
access before doing work. Long-running actions are checked again after waiting
for a picker, confirmation or data load.

An API key is not required for the browser SDK. A key pasted into your plugin
would be visible to anyone who has its package. Backend identity signing and
outbound proxy requests are not available in this preview.

Closing the panel, switching documents or accounts, disabling, updating or
uninstalling a plugin stops its instance and invalidates temporary handles.
Other tabs detect server revocation through their next request or a periodic
check, normally within two seconds plus request time. This is not instantaneous
revocation of information already delivered. Network failures fail closed.

## User-approved effects

File selection, downloads and placement confirmations belong to PCBJam outside
plugin-controlled HTML. You cannot read arbitrary paths or silently save a file.
A selected file handle belongs to one instance and expires when it stops.

Hosted symbol placement requires a writable schematic, an enabled placement
capability and user approval. A separate trusted Worker checks a bounded format
allowlist before the live native parser receives the proposal. Unsupported
resources, simulation fields, external definitions and footprint placement are
rejected. The promise resolves after native placement or cancellation; errors
reject it. The editor's normal commit provides Undo and collaboration.

These checks reduce the attack surface. They are not a certification that the
native editor or browser is free of vulnerabilities. Native placement remains
independently switchable by the deployment operator.

## Storage and release lifecycle

Installs and grants are private to the signed-in account. Plugin storage is local
to a browser and scoped to the account, plugin and project. Another plugin cannot
select that namespace. Writes use a revision check to avoid overwriting another
tab's changes. Disable retains data. Reset and uninstall revoke its namespace;
cleanup runs when the account refreshes the plugin list. Browser eviction can
remove settings at any time, so handle missing keys.

Upload a new manifest version whenever package bytes change. Updates require
permission review and invalidate old instances. A runtime upgrade can require
rebuilding and reinstalling a release during this preview. There is no silent
permission expansion, public marketplace or plugin backend delegation.

## Test your plugin

- Build the downloadable source in a fresh folder using `npm ci` and
  `npm run build`. Install the compiled ZIP or `dist/plugin`, not source code.
- Test first launch, restart, close/reopen, disable/enable, update, reset and
  uninstall. Test a second browser: installs follow the account; settings do not.
- Remove each requested permission and confirm that unavailable features show a
  useful explanation. Use `context.get()` to discover current capabilities.
- Try read-only projects, switching documents/accounts while a prompt is open,
  lost project access, network failures and cancelled file dialogs.
- Test malformed/large files and missing library parents. Do not assume every
  KiCad symbol form is accepted. Display a validation failure to the user.
- For symbol placement, assert no document edit before approval and canvas click.
  Test Esc, parse errors, Undo and visibility in another collaborative editor.
- Test storage conflicts, missing settings, quota errors and browser-data clearing.
- Keep React in UI code. Check that logic does not import browser globals and
  that dependencies are bundled rather than fetched at runtime.

## Platform checks and limits

PCBJam's automated suites exercise package traversal, duplicate entries,
compression bombs, release tampering, every registered SDK method's positive and
permission-denial paths, forged handles, invalid messages, bounded outputs,
QuickJS runaway code, UI isolation and instance teardown. Browser boundary suites
run against Chromium, Firefox and WebKit. The native editor has a separate test
requiring a compatible freshly built WASM artifact.

The hosted service also has tests using Postgres and the production Cloudflare
Worker bundle with private RPC and R2 emulation: cookie authentication, ownership,
permission review, stale grants, one-use tickets, revocation and storage epochs.
Local emulation is useful evidence; deployed HTTPS/header checks and the native
placement/Undo/collaboration test remain rollout gates. No coverage percentage,
zero-egress guarantee or absence of vulnerabilities is claimed.
