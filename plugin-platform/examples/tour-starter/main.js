// Tour Starter — a guided tour PCBJam runs for this plugin (overlay-system 0003), plus a part the
// plugin ships. The tour is data: PCBJam watches the editor and moves the card; this code only
// runs when the panel asks it to.

const CHOOSER = 'DIALOG_SYMBOL_CHOOSER';
// Parts this plugin saves land in its own team library, named after its id.
const PART = 'plugin_tour_starter:Demo_Part';
const NEW_R = { symbols: { libId: 'Device:R', min: 1, new: true } };

const TOUR = {
  id: 'first-part',
  editor: 'eeschema',
  steps: [
    { id: 'tool', target: 'tool:eeschema.InteractiveDrawing.placeSymbol', spotlight: true, pulse: true,
      title: 'Add a symbol', text: 'Click Place Symbols (or press A), then click on the sheet to open the chooser.',
      lostText: 'The Place Symbols button is on the right-hand toolbar.',
      until: { any: [{ dialogOpened: CHOOSER }, NEW_R] } },
    { id: 'search', when: { dialogOpen: CHOOSER }, target: `dialog:${CHOOSER}/control:searchctrl`, placement: 'right', pulse: true,
      title: 'Find a resistor', text: 'Type R, pick R from the Device library, then press OK.',
      until: NEW_R },
    { id: 'place', title: 'Place it', text: 'Click on the sheet to drop the resistor, then press Esc.',
      until: NEW_R },
    { id: 'part', title: 'Parts from outside',
      text: 'Not every part is in the standard library. Expand the Tour Starter panel (top right, or reopen it from the menu) and click "Add demo part": it is saved to your team library and follows the cursor — click to place it.',
      until: { symbols: { libId: PART, min: 1, new: true } } },
    { id: 'done', target: `new:${PART}`, title: 'Done',
      text: 'This part came from the plugin, with its footprint already assigned.',
      until: { next: true } },
  ],
};

const SYMBOL = `(kicad_symbol_lib (version 20241209) (generator "tour-starter")
  (symbol "Demo_Part"
    (pin_numbers (hide yes))
    (pin_names (offset 0) (hide yes))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 2.54 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "Demo_Part" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "Demo_Part_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "Demo_Part_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))
`;

const FOOTPRINT = `(footprint "Demo_Part"
  (version 20241229)
  (generator "tour-starter")
  (layer "F.Cu")
  (attr smd)
  (fp_rect (start -1.6 -0.9) (end 1.6 0.9) (stroke (width 0.12) (type solid)) (fill no) (layer "F.SilkS"))
  (pad "1" smd rect (at -1 0) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste"))
  (pad "2" smd rect (at 1 0) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste")))
`;

pcbjam.handle('start', () => pcbjam.tour.start(TOUR));
// Called when the panel opens: continues the tour after the page switch between editors.
pcbjam.handle('resume', () => pcbjam.tour.start(TOUR, { resume: true }));
pcbjam.handle('status', () => pcbjam.tour.status());
pcbjam.handle('addPart', () => pcbjam.parts.save({
  displayName: 'Demo part',
  symbol: { name: 'Demo_Part', text: SYMBOL },
  footprint: { name: 'Demo_Part', text: FOOTPRINT },
  place: true,
}));
