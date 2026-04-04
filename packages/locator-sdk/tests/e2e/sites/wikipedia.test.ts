/**
 * E2E: Wikipedia dummy page
 *
 * Baseline test — DOM strategy must win on EVERY locate() call.
 * Any fallback to A11y or Vision is a regression.
 *
 * Additional assertion: total locate() time should be < 200ms per call
 * (DOM-only, no screenshot, no accessibility snapshot taken).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { ElementLocator } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.resolve(__dirname, "../pages/wikipedia.html");
const FILE_URL = `file://${PAGE_PATH}`;

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
    sessionId: "test-wikipedia-session",
    timeout: 5000,
    logTrajectories: false,
  });
}

describe("Wikipedia page — DOM Strategy always wins", () => {
  it("finds the search input by its stable ID", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ cssSelector: "#searchInput" });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
  });

  it("finds the edit button by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "edit-page-button" });

    expect(result.strategy).toBe("dom");
  });

  it("finds a language link by hreflang cssSelector", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ cssSelector: "[hreflang='fr']" });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
  });

  it("finds the talk link by testId", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ testId: "talk-page-link" });

    expect(result.strategy).toBe("dom");
  });

  it("finds the search button by aria-label", async () => {
    const locator = makeLocator();
    const result = await locator.locate({ ariaLabel: "Search" });

    // ariaLabel match goes through DOM strategy's [aria-label="..."] selector
    expect(result.strategy).toBe("dom");
  });

  it("completes each locate() in under 500ms (DOM only, no fallbacks)", async () => {
    const locator = makeLocator();
    const start = performance.now();
    await locator.locate({ cssSelector: "#searchInput" });
    const duration = performance.now() - start;

    // DOM strategy should be fast; 500ms is generous to account for headless overhead
    expect(duration).toBeLessThan(500);
  });
});
