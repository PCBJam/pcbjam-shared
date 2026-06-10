import { defineConfig } from "vitest/config";

// Tests live under test/ (kept out of the published package via package.json
// "files"). Pure-logic suite — node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
