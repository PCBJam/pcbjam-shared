# Tour Starter

A minimal plugin that uses the guided-tour and part APIs
(docs: 0009 "Guided tours and pointers" and "Ship a part").

- `main.js` — the tour as data (`pcbjam.tour.start`), and a part it ships
  (`pcbjam.parts.save`) that lands in the plugin's own team library
  `plugin_tour_starter`.
- `ui.html` — Start tour / Add demo part; on open it resumes a tour still
  active in this tab (the page reloads when you switch editors).

Install the folder from **Plugins → Install from folder** in a local
development editor, open a schematic and click **Start tour**.
