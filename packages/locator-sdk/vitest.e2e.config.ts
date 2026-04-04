import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// E2E test config — launches real Chromium browser, loads local HTML pages.
// Vision tests are skipped unless VISION_SERVICE_URL env var is set.
//
// loadEnv reads the monorepo root .env file and merges its vars into
// process.env so VISION_SERVICE_URL and ANTHROPIC_API_KEY are available
// to E2E tests without manually exporting them in the shell.
export default defineConfig(({ mode }) => {
  // Load .env from the monorepo root (two levels up from packages/locator-sdk)
  const env = loadEnv(mode, "../../", "");
  return {
    test: {
      include: ["tests/e2e/**/*.test.ts"],
      environment: "node",
      globals: false,
      env,
      // E2E tests launch a real browser — allow 30s per test
      testTimeout: 30_000,
      // Run site tests sequentially (each creates its own browser instance)
      pool: "forks",
      poolOptions: {
        forks: { singleFork: true },
      },
    },
  };
});
