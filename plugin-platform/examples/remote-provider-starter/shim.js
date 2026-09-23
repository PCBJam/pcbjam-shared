// PCBJam bridge shim for KiCad 10 remote-symbol provider panels.
//
// Desktop KiCad embeds your panel in a native WebView and injects
// `window.kicad.postMessage` (WebKit: webkit.messageHandlers.kicad, WebView2:
// chrome.webview). PCBJam embeds the same panel in a cross-origin <iframe>, where
// nothing can be injected, so this file provides `window.kicad` on top of the
// standard `window.parent.postMessage` channel. Include it before your own panel
// script; everything else about your KiCad integration stays unchanged.
//
// PCBJam always speaks first (NEW_SESSION), so the embedder's origin is learned
// from that message and checked against EMBEDDERS. Replies go only to it.
(function () {
  // Add every PCBJam origin that may embed you. An empty list accepts any
  // embedder — fine for a local test fixture, never for production.
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
