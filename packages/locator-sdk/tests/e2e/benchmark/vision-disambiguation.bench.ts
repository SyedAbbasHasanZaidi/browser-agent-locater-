/**
 * Vision Disambiguation Benchmark
 *
 * Measures the Vision strategy's accuracy on ambiguous elements that DOM
 * and A11y strategies cannot resolve. Each case has a known ground-truth
 * element (identified by CSS selector or ID) that we verify against.
 *
 * Ambiguity categories:
 *   - terse-label:  Element has a short/generic accessible name that doesn't
 *                   match long natural-language descriptions (Jaro-Winkler fails)
 *   - duplicate:    Multiple visually identical elements exist; only spatial
 *                   context distinguishes them
 *   - unlabeled:    Element has no accessible name at all; must be identified
 *                   purely by visual context
 *   - spatial:      Element can only be found by its position relative to a
 *                   nearby heading, label, or section
 *
 * Usage:
 *   VISION_SERVICE_URL=https://... ANTHROPIC_API_KEY=sk-ant-... \
 *   npx vitest run --config vitest.e2e.config.ts tests/e2e/benchmark/
 *
 * Results are printed as a summary table after all cases run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import {
  FallbackChain,
  VisionStrategy,
  VisionClient,
} from "../../../src/index.js";
import type { LocatorContext } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISION_AVAILABLE = !!process.env["VISION_SERVICE_URL"];

// ---------------------------------------------------------------------------
// Benchmark case definition
// ---------------------------------------------------------------------------

interface BenchmarkCase {
  /** Human-readable name */
  name: string;
  /** HTML fixture file in tests/e2e/pages/ */
  pageFile: string;
  /** Natural-language description sent to Vision */
  description: string;
  /**
   * CSS selector that identifies the EXPECTED ground-truth element.
   * After Vision resolves a handle, we check if that handle matches this selector.
   */
  expectedSelector: string;
  /** Ambiguity category for reporting */
  category: "terse-label" | "duplicate" | "unlabeled" | "spatial";
}

const CASES: BenchmarkCase[] = [
  // --- Hacker News: terse label ---
  {
    name: "HN: submit link in nav bar",
    pageFile: "hacker-news.html",
    description: "the link to submit a new story in the orange navigation bar",
    expectedSelector: "#submit-link",
    category: "terse-label",
  },

  // --- Airbnb: duplicate elements ---
  {
    name: "Airbnb: adults increment (+) button",
    pageFile: "airbnb.html",
    description: "the plus button to increase the number of adult guests",
    expectedSelector: "#adults-increment",
    category: "duplicate",
  },

  // --- Amazon: unlabeled control ---
  {
    name: "Amazon: quantity dropdown",
    pageFile: "amazon.html",
    description: "the quantity dropdown selector for choosing how many items to buy",
    expectedSelector: ".quantity-select-container select",
    category: "unlabeled",
  },

  // --- Airbnb: spatial context ---
  {
    name: "Airbnb: Reserve button (spatial — in booking card)",
    pageFile: "airbnb.html",
    description: "the pink Reserve button in the booking card on the right side",
    expectedSelector: '[data-testid="reserve-button"]',
    category: "spatial",
  },

  // --- Hacker News: spatial context ---
  {
    name: "HN: first story title link",
    pageFile: "hacker-news.html",
    description: "the title link of the first story on the page",
    expectedSelector: ".storylink:first-of-type",
    category: "spatial",
  },
];

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  case: BenchmarkCase;
  correct: boolean;
  confidence: number;
  latencyMs: number;
  resolvedSelector: string;
  error?: string;
}

const results: BenchmarkResult[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!VISION_AVAILABLE)("Vision Disambiguation Benchmark", () => {
  let browser: Browser;
  const pages = new Map<string, Page>();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const pageFiles = new Set(CASES.map((c) => c.pageFile));
    for (const file of pageFiles) {
      const page = await browser.newPage();
      const filePath = path.resolve(__dirname, "../pages", file);
      await page.goto(`file://${filePath}`);
      pages.set(file, page);
    }
  });

  afterAll(async () => {
    await browser.close();

    // Print summary table
    if (results.length > 0) {
      console.log("\n╔══════════════════════════════════════════════════════════════╗");
      console.log("║            Vision Disambiguation Benchmark Results          ║");
      console.log("╠══════════════════════════════════════════════════════════════╣");

      const categories = [...new Set(results.map((r) => r.case.category))];
      for (const cat of categories) {
        const catResults = results.filter((r) => r.case.category === cat);
        const correct = catResults.filter((r) => r.correct).length;
        const total = catResults.length;
        const avgConf = catResults.reduce((s, r) => s + r.confidence, 0) / total;
        const avgLat = catResults.reduce((s, r) => s + r.latencyMs, 0) / total;
        console.log(
          `║  ${cat.padEnd(14)} │ ${correct}/${total} correct │ ` +
          `avg conf: ${avgConf.toFixed(2)} │ avg latency: ${avgLat.toFixed(0)}ms`
        );
      }

      const totalCorrect = results.filter((r) => r.correct).length;
      console.log("╠══════════════════════════════════════════════════════════════╣");
      console.log(
        `║  TOTAL: ${totalCorrect}/${results.length} correct ` +
        `(${((totalCorrect / results.length) * 100).toFixed(0)}% accuracy)`.padEnd(50) + "║"
      );
      console.log("╚══════════════════════════════════════════════════════════════╝");
    }
  });

  for (const benchCase of CASES) {
    it(`[${benchCase.category}] ${benchCase.name}`, async () => {
      const page = pages.get(benchCase.pageFile)!;
      const start = performance.now();

      // Construct Vision-only chain directly (no public API for strategy isolation)
      const url = process.env["VISION_SERVICE_URL"] ?? "https://locator-sdk-production.up.railway.app";
      const key = process.env["ANTHROPIC_API_KEY"];
      const client = new VisionClient(url, key);
      const chain = new FallbackChain([new VisionStrategy(client)]);
      const context: LocatorContext = { page, timeout: 15000 };

      let correct = false;
      let confidence = 0;
      let resolvedSelector = "(none)";
      let error: string | undefined;

      try {
        const { element: result } = await chain.locate(
          { description: benchCase.description },
          context
        );

        confidence = result.confidence;
        resolvedSelector = result.selector;

        // Verify: does the resolved handle match the expected element?
        const expected = await page.$(benchCase.expectedSelector);
        if (expected && result.handle) {
          // Compare by checking if both refer to the same DOM node
          correct = await page.evaluate(
            ({ resolved, expected }) => resolved === expected,
            { resolved: result.handle, expected }
          );
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      const latencyMs = performance.now() - start;

      results.push({
        case: benchCase,
        correct,
        confidence,
        latencyMs,
        resolvedSelector,
        error,
      });

      // The benchmark records results regardless — but we assert correctness
      // so failing cases show as test failures for visibility.
      expect(correct, `Expected to resolve to ${benchCase.expectedSelector}`).toBe(true);
    });
  }
});
