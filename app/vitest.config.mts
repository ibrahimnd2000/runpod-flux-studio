import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit and route tests for the app. No network: Runpod and Anthropic calls are
// either avoided (dry runs, scripted model) or mocked per test.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server bundle; tests import server code directly.
      "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Every test file gets a fresh module graph, so in-memory stores start empty.
    isolate: true,
    env: { DEMO_ACCESS_CODE: "test-code", DATA_DIR: "", DRY_RUN_DELAY_SCALE: "0", RUNPOD_API_KEY: "", ANTHROPIC_API_KEY: "", RUNPOD_LLM_ENDPOINT_ID: "" },
  },
});
