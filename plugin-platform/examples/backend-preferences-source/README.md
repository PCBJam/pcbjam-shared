# Backend preferences example

This example has TypeScript logic, a React UI, and a separate Node backend.
The backend receives signed requests identifying the PCBJam user for this plugin.
It uses PostgreSQL for preferences and durable replay protection.

1. Choose an HTTPS hostname you control, with a publicly routable address.
   Set `endpoints.backend.origin` in `manifest.json` to that exact origin.
   For local backend development, expose port 8080 through an HTTPS tunnel on
   your own hostname. Localhost/private IPs and `workers.dev` destinations are blocked.
2. Run `npm ci && npm run build` in this folder. Upload the compiled
   `dist/backend-preferences.zip` to PCBJam. It will await endpoint approval.
3. Send PCBJam the plugin UUID shown in the installation review. PCBJam supplies
   a DNS TXT challenge. Publish it, then ask for verification and approval.
   Domain verification expires after 30 days and must be renewed.
4. PCBJam gives you the exact **issuer**, **audience** and **plugin UUID**.
   Configure these on your backend as `PCBJAM_ISSUER`, `PCBJAM_AUDIENCE` and
   `PCBJAM_PLUGIN_ID`, plus `PUBLIC_ORIGIN` (your manifest origin) and
   `DATABASE_URL` (your backend's own PostgreSQL). Do not put DB credentials
   or other secrets in the plugin manifest or bundles.
5. Apply `backend/schema.sql` to your backend database. Inside `backend`, run
   `npm ci`, `npm run typecheck` and `npm start`. Put an HTTPS proxy/tunnel in front
   of the loopback server. Preserve the request path, Authorization header and
   exact body bytes. The externally visible URL is signed; the backend does
   not trust forwarded host headers to reconstruct it.
6. Re-upload the same compiled ZIP to refresh its approval status, review the
   permissions and install. Open Backend Preferences, enter a name and click Save.
   Close/reopen it and click Load. No PCBJam API key is needed.

The compiled example cannot be installed until its placeholder domain is replaced
and approved. The source ZIP includes the backend; the installable ZIP does not.
Run `npm run dev` to rebuild local edits; increase the manifest version to install
changed code. A new route/domain/method/auth policy needs fresh operator approval
and user consent.

`backend/backend-verifier.mjs` is the reusable verifier. Configure trusted values
on the server and supply an atomic, durable `consumeReplay` callback; an in-memory
Set is insufficient across replicas or restarts. It verifies ES256, issuer,
audience, plugin ID, expiry, method, exact URL and SHA-256 of the raw body, then
consumes the nonce before your handler executes. Keep clocks synchronized.

Key user data by the verified `(issuer, subject)`. The subject is a stable random
ID for this user and plugin; it is not their email or global PCBJam account ID.
A signed request proves PCBJam authenticated that session and authorized the plugin
request. It does not prove a human intentionally clicked a particular button.
Enforce your own permissions and business rules. Do not log Authorization headers.
There are no automatic retries. A timeout can occur after a write succeeded; Load
before deciding to Save again. Reset/uninstall in PCBJam does not erase backend data.

Current installation is private per account. An independently uploaded copy gets
a different server plugin UUID and requires separate approval. This example is
not a public marketplace or publisher registration workflow.
