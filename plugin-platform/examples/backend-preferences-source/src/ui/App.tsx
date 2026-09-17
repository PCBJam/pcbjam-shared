import { useState } from "react";
declare const pcbjamUI: {
  call(command: string, params?: unknown): Promise<unknown>;
};
export function App() {
  const [library, setLibrary] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(command: "load" | "save") {
    setBusy(true);
    try {
      const result = (await pcbjamUI.call(command, { library })) as {
        library?: unknown;
      };
      if (typeof result?.library === "string") setLibrary(result.library);
      setStatus(
        command === "save"
          ? "Saved to your backend."
          : "Loaded from your backend."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>Backend preferences</h1>
      <p>Save a library name to your own service.</p>
      <label>
        Preferred library
        <input
          value={library}
          maxLength={100}
          onChange={(e) => setLibrary(e.target.value)}
        />
      </label>
      <p>
        <button disabled={busy} onClick={() => void run("load")}>
          Load
        </button>{" "}
        <button disabled={busy} onClick={() => void run("save")}>
          Save
        </button>
      </p>
      <p role="status">{status}</p>
    </main>
  );
}
