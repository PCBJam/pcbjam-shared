import { useEffect, useRef, useState } from 'react';
import type { LoadedLibrary } from '../contracts';
import { callPlugin } from './pcbjam';

export function App() {
  const [library, setLibrary] = useState<LoadedLibrary | null>(null);
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState('Connecting to PCBJam…');
  const pending = useRef(true);

  useEffect(() => {
    let mounted = true;
    void pcbjamUI.ready.then(() => {
      if (!mounted) return;
      pending.current = false;
      setBusy(false);
      setStatus('Choose a library to get started.');
    });
    return () => { mounted = false; };
  }, []);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The plugin action failed.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function chooseLibrary() {
    void run(async () => {
      setStatus('Choose a file in the PCBJam controls above this plugin.');
      const result = await callPlugin('chooseLibrary', {});
      if ('cancelled' in result) { setStatus('File selection cancelled.'); return; }
      setLibrary(result);
      setSymbol(result.names[0] ?? '');
      setStatus(`${result.names.length} symbols available. Choose one and add it.`);
    });
  }

  function placeSymbol() {
    void run(async () => {
      setStatus('Approve in the PCBJam controls, then click the canvas to place. Esc cancels.');
      const result = await callPlugin('placeSymbol', { name: symbol });
      setStatus(result.status === 'placed' ? 'Symbol placed. Undo in the editor removes it.' : result.status === 'queued'
        ? 'Placement requested. Move onto the canvas and click to place; Esc cancels.'
        : 'Placement cancelled.');
    });
  }

  return (
    <main>
      <h1>External Symbol Import</h1>
      <p>Bring a symbol from a local KiCad library into your schematic.</p>
      <button disabled={busy} onClick={chooseLibrary}>Choose symbol library</button>
      {library && (
        <section>
          <div className="file">{library.fileName}</div>
          <label htmlFor="symbol">Symbol</label>
          <select id="symbol" value={symbol} disabled={busy} onChange={event => setSymbol(event.target.value)}>
            {library.names.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <button disabled={busy || !symbol} onClick={placeSymbol}>Add symbol</button>
        </section>
      )}
      <p role="status" className="status">{status}</p>
      <p className="note">Choose a .kicad_sym file. PCBJam will ask you to confirm placement;
        you then click on the canvas. Esc cancels and Undo removes a placed symbol.</p>
    </main>
  );
}
