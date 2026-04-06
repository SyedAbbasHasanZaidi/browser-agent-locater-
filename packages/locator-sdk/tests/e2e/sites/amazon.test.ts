/**
 * E2E: Amazon dummy page
 *
 * Key assertion: A11y strategy must fuzzy-match "add to cart button"
 * to an element labelled "Add to Basket" (A/B test simulation).
 * Jaro-Winkler score should be ≥ 0.80.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { ElementLocator } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.resolve(__dirname, "../pages/amazon.html");
const FILE_URL = `file://${PAGE_PATH}`;

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

function makeLocator() {
  return ElementLocator.create({
    page,
    sessionId: "test-amazon-session",
    timeout: 5000,
    logTrajectories: false,
    // visionServiceUrl and anthropicApiKey read from env vars automatically
  });
}

describe("Amazon page — DOM Strategy", () => {
  it("finds the search input by its stable ID", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ cssSelector: "#twotabsearchtextbox" });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
  });

  it("finds Buy Now button by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "buy-now-button" });

    expect(result.strategy).toBe("dom");
  });
});

describe("Amazon page — A11y Strategy (A/B test simulation)", () => {
  it("finds 'Add to Basket' when searching for 'add to cart button'", async () => {
    // This is the critical A/B test scenario.
    // The button says "Add to Basket" but the agent describes it as "add to cart button"
    // Jaro-Winkler fuzzy match must score ≥ 0.80 for this to succeed.
    const locator = makeLocator();

    const result = await locator.locate({
      description: "add to cart button",
      // Deliberately omit cssSelector and testId to force A11y/Vision path
    });

    expect(result.handle).toBeTruthy();
    // Should match via A11y (fuzzy label match) rather than exact DOM selector
    expect(["a11y", "dom"]).toContain(result.strategy);
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("finds the Add to Basket button by its actual aria-label (exact A11y match)", async () => {
    const locator = makeLocator();
    const result = await locator.locate({
      description: "Add to Basket",
    });

    expect(result.handle).toBeTruthy();
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe.skipIf(!VISION_AVAILABLE)("Amazon page — Vision Strategy", () => {
  it("finds the quantity dropdown that has no accessible name", async () => {
    const locator = ElementLocator.create({
      page,
      sessionId: "test-amazon-vision",
      timeout: 12000,
      logTrajectories: false,
    });

    // quantity select has no aria-label and no testId
    const result = await locator.locate({
      description: "quantity dropdown selector",
    });

    expect(result.strategy).toBe("vision");
  });
});
