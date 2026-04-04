import { defineConfig } from "vitest/config";

// Unit test config — no browser, no network, mocked Playwright
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Unit tests should be fast — fail if a single test exceeds 10s
    testTimeout: 10_000,
  },
});
