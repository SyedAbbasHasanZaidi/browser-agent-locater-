/**
 * E2E: Cross-Strategy Backward Compatibility
 *
 * Validates that stronger strategies can find everything weaker ones can.
 * The strategy strength hierarchy is:
 *
 *   DOM (weakest/fastest) < A11y (medium) < Vision (strongest/slowest)
 *
 * For each element, we define targets for all applicable strategies and verify:
 *   - If DOM can find it, A11y must also find it (via description)
 *   - If A11y can find it, Vision must also find it (if available)
 *
 * This catches regressions where a strategy rewrite (e.g. A11y moving from
 * page.accessibility.snapshot() to DOM queries) silently loses coverage.
 *
 * Strategy isolation is achieved via ElementLocator.create({ strategies: [...] })
 * which limits the fallback chain to only the specified strategies.
 *
 * +---------------------------------------------------------------+
 * |                   Cross-Strategy Test Matrix                   |
 * +---------------------------------------------------------------+
 * |  Element               | DOM target     | A11y target         |
 * |------------------------|----------------|---------------------|
 * |  Wikipedia: search     | #searchInput   | "Search Wikipedia"  |
 * |  Wikipedia: edit btn   | testId         | "Edit this page"    |
 * |  Wikipedia: search btn | aria-label     | "Search"            |
 * |  Airbnb: reserve btn   | testId         | "Reserve"           |
 * |  Airbnb: user menu     | testId         | "User menu"         |
 * |  Airbnb: check-in      | (none — A11y)  | "check-in date"     |
 * +---------------------------------------------------------------+
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { ElementLocator, type StrategyName } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISION_AVAILABLE = !!process.env["VISION_SERVICE_URL"];

// ---------------------------------------------------------------------------
// Test element definitions
// ---------------------------------------------------------------------------
// Each entry describes one element and the targets that should find it
// at each strategy tier. If a tier is undefined, it means that strategy
// is not expected to find this element (e.g. DOM can't find date pickers
// with generated IDs).
// ---------------------------------------------------------------------------

interface CrossStrategyElement {
  /** Human-readable name for test output */
  name: string;
  /** Page file to open */
  pageFile: string;
  /** Target for DOM strategy (structural selector) */
  dom?: { cssSelector?: string; testId?: string; ariaLabel?: string };
  /** Target for A11y strategy (description-based fuzzy match) */
  a11y?: { description: string };
  /** Target for Vision strategy (natural-language description) */
  vision?: { description: string };
  /** Minimum confidence expected from A11y match */
  minA11yConfidence?: number;
}

const ELEMENTS: CrossStrategyElement[] = [
  // --- Wikipedia ---
  {
    name: "Wikipedia: search input",
    pageFile: "wikipedia.html",
    dom: { cssSelector: "#searchInput" },
    a11y: { description: "Search Wikipedia" },
    vision: { description: "the search input field at the top of the page" },
  },
  {
    name: "Wikipedia: edit button",
    pageFile: "wikipedia.html",
    dom: { testId: "edit-page-button" },
    a11y: { description: "Edit this page" },
    vision: { description: "the edit button next to the article title" },
  },
  {
    name: "Wikipedia: search button",
    pageFile: "wikipedia.html",
    dom: { ariaLabel: "Search" },
    a11y: { description: "Search" },
  },

  // --- Airbnb ---
  {
    name: "Airbnb: reserve button",
    pageFile: "airbnb.html",
    dom: { testId: "reserve-button" },
    a11y: { description: "Reserve" },
    vision: { description: "the pink Reserve button in the booking card" },
  },
  {
    name: "Airbnb: user menu",
    pageFile: "airbnb.html",
    dom: { testId: "user-menu-button" },
    a11y: { description: "User menu" },
  },
  {
    name: "Airbnb: check-in input (A11y-only — no stable DOM selector)",
    pageFile: "airbnb.html",
    // No DOM target — generated IDs, CSS-in-JS class names
    a11y: { description: "Check-in date" },
  },
  {
    name: "Airbnb: checkout input (A11y-only — no stable DOM selector)",
    pageFile: "airbnb.html",
    a11y: { description: "Checkout date" },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocator(page: Page, strategies: StrategyName[]) {
  return ElementLocator.create({
    page,
    sessionId: `cross-strategy-${strategies.join("-")}`,
    timeout: 5000,
    logTrajectories: false,
    strategies,
    visionServiceUrl: process.env["VISION_SERVICE_URL"],
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
  });
}

// Group elements by page file so we open each page once.
function groupByPage(elements: CrossStrategyElement[]): Map<string, CrossStrategyElement[]> {
  const map = new Map<string, CrossStrategyElement[]>();
  for (const el of elements) {
    const list = map.get(el.pageFile) ?? [];
    list.push(el);
    map.set(el.pageFile, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cross-Strategy Backward Compatibility", () => {
  let browser: Browser;
  const pages = new Map<string, Page>();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });

    // Open each unique page file once and store the Page handle.
    const pageFiles = new Set(ELEMENTS.map((e) => e.pageFile));
    for (const file of pageFiles) {
      const page = await browser.newPage();
      const filePath = path.resolve(__dirname, "../pages", file);
      await page.goto(`file://${filePath}`);
      pages.set(file, page);
    }
  });

  afterAll(async () => {
    await browser.close();
  });

  // -------------------------------------------------------------------------
  // For each element: if DOM can find it, verify A11y also finds it.
  // -------------------------------------------------------------------------
  describe("A11y finds everything DOM finds", () => {
    const elementsWithBoth = ELEMENTS.filter((e) => e.dom && e.a11y);

    for (const el of elementsWithBoth) {
      it(`${el.name}`, async () => {
        const page = pages.get(el.pageFile)!;

        // Step 1: DOM must succeed (sanity check — the element exists)
        const domLocator = makeLocator(page, ["dom"]);
        const domResult = await domLocator.locate(el.dom!);
        expect(domResult.strategy).toBe("dom");
        expect(domResult.confidence).toBe(1.0);

        // Step 2: A11y (isolated, no DOM fallback) must also find it
        const a11yLocator = makeLocator(page, ["a11y"]);
        const a11yResult = await a11yLocator.locate(el.a11y!);
        expect(a11yResult.strategy).toBe("a11y");
        expect(a11yResult.confidence).toBeGreaterThanOrEqual(
          el.minA11yConfidence ?? 0.80
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Elements that only A11y can find (no DOM selector available).
  // Verify A11y works in isolation.
  // -------------------------------------------------------------------------
  describe("A11y-only elements (no DOM selector)", () => {
    const a11yOnly = ELEMENTS.filter((e) => !e.dom && e.a11y);

    for (const el of a11yOnly) {
      it(`${el.name}`, async () => {
        const page = pages.get(el.pageFile)!;
        const a11yLocator = makeLocator(page, ["a11y"]);
        const result = await a11yLocator.locate(el.a11y!);

        expect(result.strategy).toBe("a11y");
        expect(result.confidence).toBeGreaterThanOrEqual(
          el.minA11yConfidence ?? 0.80
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Vision must find everything A11y finds (when Vision service is available).
  // Skipped when VISION_SERVICE_URL is not set.
  // -------------------------------------------------------------------------
  describe.skipIf(!VISION_AVAILABLE)(
    "Vision finds everything A11y finds",
    () => {
      const elementsWithVision = ELEMENTS.filter((e) => e.a11y && e.vision);

      for (const el of elementsWithVision) {
        it(`${el.name}`, async () => {
          const page = pages.get(el.pageFile)!;

          // A11y must succeed first (sanity check)
          const a11yLocator = makeLocator(page, ["a11y"]);
          const a11yResult = await a11yLocator.locate(el.a11y!);
          expect(a11yResult.strategy).toBe("a11y");

          // Vision (isolated) must also find it
          const visionLocator = ElementLocator.create({
            page,
            sessionId: "cross-strategy-vision",
            timeout: 12000,
            logTrajectories: false,
            strategies: ["vision"],
            visionServiceUrl: process.env["VISION_SERVICE_URL"],
            anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
          });
          const visionResult = await visionLocator.locate(el.vision!);
          expect(visionResult.strategy).toBe("vision");
          expect(visionResult.confidence).toBeGreaterThanOrEqual(0.70);
        });
      }
    }
  );

  // -------------------------------------------------------------------------
  // Confidence monotonicity: DOM should have highest confidence (1.0),
  // followed by A11y (≥0.80). Verify the ranking holds.
  // -------------------------------------------------------------------------
  describe("Confidence ranking: DOM ≥ A11y", () => {
    const elementsWithBoth = ELEMENTS.filter((e) => e.dom && e.a11y);

    for (const el of elementsWithBoth) {
      it(`${el.name}`, async () => {
        const page = pages.get(el.pageFile)!;

        const domLocator = makeLocator(page, ["dom"]);
        const domResult = await domLocator.locate(el.dom!);

        const a11yLocator = makeLocator(page, ["a11y"]);
        const a11yResult = await a11yLocator.locate(el.a11y!);

        expect(domResult.confidence).toBeGreaterThanOrEqual(
          a11yResult.confidence
        );
      });
    }
  });
});
