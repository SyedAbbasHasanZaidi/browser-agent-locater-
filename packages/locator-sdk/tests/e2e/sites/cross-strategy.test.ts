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
 * Strategy isolation is achieved by constructing a FallbackChain with only
 * the strategy under test — an internal testing technique that does not
 * require any public API surface for strategy selection.
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
import {
  DomStrategy,
  A11yStrategy,
  VisionStrategy,
  FallbackChain,
  VisionClient,
} from "../../../src/index.js";
import type { LocatorContext, LocatorTarget } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISION_AVAILABLE = !!process.env["VISION_SERVICE_URL"];

// ---------------------------------------------------------------------------
// Test element definitions
// ---------------------------------------------------------------------------

interface CrossStrategyElement {
  name: string;
  pageFile: string;
  dom?: { cssSelector?: string; testId?: string; ariaLabel?: string };
  a11y?: { description: string };
  vision?: { description: string };
  minA11yConfidence?: number;
}

const ELEMENTS: CrossStrategyElement[] = [
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
    a11y: { description: "Check-in date" },
  },
  {
    name: "Airbnb: checkout input (A11y-only — no stable DOM selector)",
    pageFile: "airbnb.html",
    a11y: { description: "Checkout date" },
  },
];

// ---------------------------------------------------------------------------
// Helpers — construct isolated chains directly (no public API needed)
// ---------------------------------------------------------------------------

function makeContext(page: Page, timeout = 5000): LocatorContext {
  return { page, timeout };
}

function domChain() {
  return new FallbackChain([new DomStrategy()]);
}

function a11yChain() {
  return new FallbackChain([new A11yStrategy()]);
}

function visionChain() {
  const url = process.env["VISION_SERVICE_URL"] ?? "https://locator-sdk-production.up.railway.app";
  const key = process.env["ANTHROPIC_API_KEY"];
  const client = new VisionClient(url, key);
  return new FallbackChain([new VisionStrategy(client)]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cross-Strategy Backward Compatibility", () => {
  let browser: Browser;
  const pages = new Map<string, Page>();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });

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

        const domResult = await domChain().locate(el.dom!, makeContext(page));
        expect(domResult.element.strategy).toBe("dom");
        expect(domResult.element.confidence).toBe(1.0);

        const a11yResult = await a11yChain().locate(el.a11y!, makeContext(page));
        expect(a11yResult.element.strategy).toBe("a11y");
        expect(a11yResult.element.confidence).toBeGreaterThanOrEqual(
          el.minA11yConfidence ?? 0.80
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Elements that only A11y can find (no DOM selector available).
  // -------------------------------------------------------------------------
  describe("A11y-only elements (no DOM selector)", () => {
    const a11yOnly = ELEMENTS.filter((e) => !e.dom && e.a11y);

    for (const el of a11yOnly) {
      it(`${el.name}`, async () => {
        const page = pages.get(el.pageFile)!;
        const result = await a11yChain().locate(el.a11y!, makeContext(page));

        expect(result.element.strategy).toBe("a11y");
        expect(result.element.confidence).toBeGreaterThanOrEqual(
          el.minA11yConfidence ?? 0.80
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Vision must find everything A11y finds (when Vision service is available).
  // -------------------------------------------------------------------------
  describe.skipIf(!VISION_AVAILABLE)(
    "Vision finds everything A11y finds",
    () => {
      const elementsWithVision = ELEMENTS.filter((e) => e.a11y && e.vision);

      for (const el of elementsWithVision) {
        it(`${el.name}`, async () => {
          const page = pages.get(el.pageFile)!;

          const a11yResult = await a11yChain().locate(el.a11y!, makeContext(page));
          expect(a11yResult.element.strategy).toBe("a11y");

          const visionResult = await visionChain().locate(
            el.vision!,
            makeContext(page, 12000)
          );
          expect(visionResult.element.strategy).toBe("vision");
          expect(visionResult.element.confidence).toBeGreaterThanOrEqual(0.70);
        });
      }
    }
  );

  // -------------------------------------------------------------------------
  // Confidence monotonicity: DOM should have highest confidence (1.0),
  // followed by A11y (>=0.80).
  // -------------------------------------------------------------------------
  describe("Confidence ranking: DOM >= A11y", () => {
    const elementsWithBoth = ELEMENTS.filter((e) => e.dom && e.a11y);

    for (const el of elementsWithBoth) {
      it(`${el.name}`, async () => {
        const page = pages.get(el.pageFile)!;

        const domResult = await domChain().locate(el.dom!, makeContext(page));
        const a11yResult = await a11yChain().locate(el.a11y!, makeContext(page));

        expect(domResult.element.confidence).toBeGreaterThanOrEqual(
          a11yResult.element.confidence
        );
      });
    }
  });
});
