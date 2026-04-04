/**
 * E2E: Hacker News dummy page
 *
 * Validates that the fallback chain correctly passes through DOM and A11y
 * when only terse text labels exist, reaching Vision strategy.
 *
 * For tests that don't require Vision, we validate the intermediate failure
 * modes: DOM returns null (ambiguous text), A11y returns null (low score).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { ElementLocator, ElementNotFoundError } from "../../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.resolve(__dirname, "../pages/hacker-news.html");
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

function makeLocator(visionServiceUrl?: string) {
  return ElementLocator.create({
    page,
    sessionId: "test-hn-session",
    timeout: 5000,
    logTrajectories: false,
    ...(visionServiceUrl && { visionServiceUrl }),
  });
}

describe("Hacker News page — DOM Strategy (exact matches)", () => {
  it("finds the submit link by its ID (DOM wins)", async () => {
    // submit link has id="submit-link" — DOM cssSelector finds it
    const locator = makeLocator();
    const result = await locator.locate({ cssSelector: "#submit-link" });

    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
  });

  it("finds a story vote arrow by ariaRole=button would NOT work (no role)", async () => {
    // Vote arrows are just ▲ text with no semantic role — no match possible
    const locator = makeLocator();
    await expect(
      locator.locate({ ariaRole: "button", text: "▲" })
    ).rejects.toThrow(ElementNotFoundError);
  });
});

describe("Hacker News page — A11y short-label problem", () => {
  it("fails to find 'submit' via long natural-language description (below threshold)", async () => {
    // The a11y node for the submit link has name="submit" (just the link text).
    // Jaro-Winkler("the nav link for submitting a new story", "submit") is too low.
    // Without Vision, this should throw ElementNotFoundError.
    // With Vision, it would succeed — but we test the non-Vision failure here.
    const locator = ElementLocator.create({
      page,
      sessionId: "test-hn-no-vision",
      timeout: 3000,
      logTrajectories: false,
      // Force Vision service to an unreachable URL so Vision also fails
      visionServiceUrl: "http://localhost:1",
    });

    await expect(
      locator.locate({
        description: "the nav link for submitting a new story to Hacker News",
      })
    ).rejects.toThrow(ElementNotFoundError);
  });
});

describe.skipIf(!VISION_AVAILABLE)("Hacker News page — Vision Strategy", () => {
  it("finds the nav submit link via vision when description is natural language", async () => {
    const locator = ElementLocator.create({
      page,
      sessionId: "test-hn-vision",
      timeout: 12000,
      logTrajectories: false,
    });

    const result = await locator.locate({
      description: "the link to submit a new story in the orange navigation bar",
    });

    expect(result.strategy).toBe("vision");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.boundingBox).toBeTruthy();
  });
});
