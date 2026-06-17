import { defineConfig } from "vitest/config";

// Pure-logic suite — the store / http / realtime channel are all injected as
// in-memory fakes (test/fake-server.ts), so no IndexedDB or WebSocket is needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
