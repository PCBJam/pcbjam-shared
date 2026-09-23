# Remote Symbols provider starter

A complete, dependency-free KiCad 10 Remote Symbols provider that works in
PCBJam and in desktop KiCad 10. Node.js 22+.

| File | What it is |
|---|---|
| `serve.mjs` | The server: `/.well-known/kicad-remote-provider`, `/panel`, `/v1/parts/<id>`, `/downloads/<file>`. |
| `panel.html` | The panel page: part cards, `PLACE_COMPONENT` and inline `DL_COMPONENT`, the `NEW_SESSION` reply. |
| `shim.js` | The PCBJam bridge (`window.kicad` on top of `postMessage`). Keep it before your panel script. |
| `data/` | Example symbol, footprint, 3D model and SPICE files. |
| `manifest.json` | The package you upload to PCBJam. Set `provider.origin` to your origin. |

## Run it

```sh
node serve.mjs                                            # http://127.0.0.1:4400, for desktop KiCad
PUBLIC_ORIGIN=https://<your-host> node serve.mjs          # behind an https tunnel or proxy, for PCBJam
```

- `PUBLIC_ORIGIN` is the https origin PCBJam reaches you at: lowercase, no
  trailing slash, no port. It is written into the metadata, the manifests and
  every download URL. For a quick test expose port 4400 with a tunnel, for
  example `cloudflared tunnel --url http://127.0.0.1:4400`.
- `EMBEDDERS` (comma-separated) overrides which PCBJam origins may embed the
  panel. Unset, the shim's defaults apply: `https://editor.pcbjam.com` and the
  staging editor `https://pcbjam-editor-staging.pcbjam-staging.workers.dev`.
  `EMBEDDERS=` (empty) accepts any embedder: local testing only.
- `PORT` changes the local port (default 4400).

Check it the way PCBJam will:

```sh
curl -s  https://<your-host>/.well-known/kicad-remote-provider    # application/json, not compressed
curl -sI https://<your-host>/panel                                 # both Cross-Origin-* headers
curl -s  https://<your-host>/v1/parts/r-10k-0603                  # sizes and sha256 of every asset
```

## Make it yours

1. Replace the files in `data/` and the `PARTS` list in `serve.mjs`. Sizes and
   sha256 are computed from the files at start-up.
2. Replace the panel with your own catalog UI; keep the shim first, the
   `NEW_SESSION` reply and the envelope shape.
3. Edit `manifest.json`: `id`, `name`, `description` and `provider.origin`.
   Zip it on its own (optionally with `README.md` and `LICENSE.txt`) and upload
   it in PCBJam with **Plugins → Add plugin…** in a schematic.
4. Ask for review of your origin on the PCBJam Discord:
   https://discord.gg/ybhqJxjR3E. Once an origin is approved, every user's
   upload of it works without another review.

Full reference: the Remote Symbols page of the PCBJam plugin developer guide
(`REMOTE-SYMBOLS.md` in the guide download).
