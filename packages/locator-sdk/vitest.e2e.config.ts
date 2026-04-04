import { defineConfig } from "vitest/config";

// E2E test config — launches real Chromium browser, loads local HTML pages.
// Vision tests are skipped unless VISION_SERVICE_URL env var is set.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    globals: false,
    // E2E tests launch a real browser — allow 30s per test
    testTimeout: 30_000,
    // Run site tests sequentially (each creates its own browser instance)
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
