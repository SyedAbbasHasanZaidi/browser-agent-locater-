/**
 * E2E: Airbnb dummy page
 *
 * Tests all three strategies on a single page:
 *   DOM    → Reserve button (has data-testid)
 *   A11y   → Check-in date input (aria-label but no testId)
 *   Vision → Adults increment button (no label, visually identified by row context)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { ElementLocator } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.resolve(__dirname, "../pages/airbnb.html");
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

function makeLocator(overrides: Partial<{ sessionId: string; timeout: number }> = {}) {
  return ElementLocator.create({
    page,
    sessionId: overrides.sessionId ?? "test-airbnb-session",
    timeout: overrides.timeout ?? 5000,
    logTrajectories: false,
  });
}

describe("Airbnb page — DOM Strategy", () => {
  it("finds the Reserve button by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "reserve-button" });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
    expect(result.selector).toBe('[data-testid="reserve-button"]');
  });

  it("finds the user menu button by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "user-menu-button" });

    expect(result.strategy).toBe("dom");
  });
});

describe("Airbnb page — A11y Strategy", () => {
  it("finds the check-in input by aria-label semantic match", async () => {
    // No testId — CSS-in-JS generated class names won't match.
    // aria-label="Check-in date" is stable.
    const locator = makeLocator();
    const result = await locator.locate({
      description: "check-in date",
      // No cssSelector, no testId — forces A11y path
    });

    expect(result.handle).toBeTruthy();
    expect(["dom", "a11y"]).toContain(result.strategy);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("finds the checkout input via A11y description", async () => {
    const locator = makeLocator();
    const result = await locator.locate({
      description: "checkout date",
    });

    expect(result.handle).toBeTruthy();
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("finds the Reserve button via A11y description (aria-label='Reserve')", async () => {
    const locator = makeLocator();
    const result = await locator.locate({
      description: "reserve button",
    });

    // Might win via DOM (testId) or A11y (aria-label="Reserve")
    expect(["dom", "a11y"]).toContain(result.strategy);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe.skipIf(!VISION_AVAILABLE)("Airbnb page — Vision Strategy", () => {
  it("finds the Adults increment (+) button via vision", async () => {
    // Two identical "+" buttons exist. No aria-label, no testId.
    // Vision must identify which + button is in the "Adults" row.
    const locator = ElementLocator.create({
      page,
      sessionId: "test-airbnb-vision",
      timeout: 12000,
      logTrajectories: false,
    });

    const result = await locator.locate({
      description: "the plus button to increase the number of adult guests",
    });

    expect(result.strategy).toBe("vision");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.boundingBox).toBeTruthy();
  });
});
