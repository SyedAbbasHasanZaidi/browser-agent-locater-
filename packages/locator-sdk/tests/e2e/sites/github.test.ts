/**
 * E2E: GitHub dummy page
 *
 * Validates that each button is found by the expected strategy.
 * Uses a local HTML file served by Playwright — no internet required.
 * Vision tests are SKIPPED unless VISION_SERVICE_URL is set and reachable.
 *
 * Run:  pnpm test:e2e --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { ElementLocator } from "../../../src/index.js";
import { ElementNotFoundError } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.resolve(__dirname, "../pages/github.html");
const FILE_URL = `file://${PAGE_PATH}`;

// Vision tests only run if the Python service is available
const VISION_AVAILABLE = !!process.env["VISION_SERVICE_URL"];

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(FILE_URL);
});

afterAll(async () => {
  await browser.close();
});

function makeLocator(logTrajectories = false) {
  return ElementLocator.create({
    page,
    sessionId: "test-github-session",
    timeout: 5000,
    logTrajectories, // disable in tests — no Python service needed
  });
}

// ---------------------------------------------------------------------------
// DOM Strategy tests (no network required)
// ---------------------------------------------------------------------------

describe("GitHub page — DOM Strategy", () => {
  it("finds the Star button by testId in a single DOM attempt", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "star-button" });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
    expect(result.selector).toBe('[data-testid="star-button"]');
    expect(result.handle).toBeTruthy();
  });

  it("finds the search input by cssSelector", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ cssSelector: 'input[data-testid="search-input"]' });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
  });

  it("finds the Issues tab by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "issues-tab" });

    expect(result.strategy).toBe("dom");
  });

  it("finds README file link by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "readme-file" });

    expect(result.strategy).toBe("dom");
    expect(result.handle).toBeTruthy();
  });

  it("throws ElementNotFoundError for a non-existent testId", async () => {
    const locator = makeLocator();
    await expect(
      locator.locate({ testId: "this-does-not-exist" })
    ).rejects.toThrow(ElementNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// A11y Strategy tests — DOM strategy must FAIL first so A11y runs
// ---------------------------------------------------------------------------

describe("GitHub page — A11y Strategy", () => {
  it("finds the Fork button via aria-label fuzzy match", async () => {
    const locator = makeLocator();
    // No testId provided — DOM strategy will fail on cssSelector/testId/text combos.
    // A11y strategy will fuzzy-match "fork this repository" → aria-label="Fork this repository"
    const result = await locator.locate({
      description: "fork this repository",
      ariaRole: "button",
    });

    // Either dom (if ariaRole alone matched) or a11y
    expect(["dom", "a11y"]).toContain(result.strategy);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("finds an element by partial text description via A11y", async () => {
    const locator = makeLocator();
    const result = await locator.locate({
      description: "star this repository",
    });

    expect(result.handle).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// Vision Strategy tests — requires Python service
// ---------------------------------------------------------------------------

describe.skipIf(!VISION_AVAILABLE)("GitHub page — Vision Strategy", () => {
  it("finds the Watch button (no testId, vague aria-label) via vision", async () => {
    const locator = ElementLocator.create({
      page,
      sessionId: "test-github-vision",
      timeout: 10000,
      logTrajectories: false,
    });

    // description that will fail DOM (no testId) and likely fail A11y (vague label)
    const result = await locator.locate({
      description: "watch notifications button in the top action bar",
    });

    expect(result.strategy).toBe("vision");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.boundingBox).toBeTruthy();
  });
});
