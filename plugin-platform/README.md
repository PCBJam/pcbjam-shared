# PCBJam plugin platform

MIT-licensed trusted browser Worker, QuickJS runtime, host API and SDK shared by
the editor and the benchmark lab. Plugin code is evaluated only inside QuickJS;
the host bundles are PCBJam code and must never be replaced with uploaded code.

`buildPluginRuntime(directory)` creates an immutable SHA-256-addressed directory
with the matching Worker, host, SDK, QuickJS WASM and per-file integrity manifest.
The editor's Vite build invokes it automatically. No private repository, local
POC server, previously copied assets, or Git metadata is needed to build it.

The Worker response must use `WORKER_CSP` from `build.mjs`. A browser page's CSP
does not replace the network Worker's response policy. Guest UI remains on the
separately configured isolated delivery origin.
