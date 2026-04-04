import { describe, it, expect, vi, beforeEach } from "vitest";
import { A11yStrategy } from "../../src/strategies/a11y.strategy.js";
import type { LocatorContext, LocatorTarget } from "../../src/types/strategy.types.js";
import type { ElementHandle, Locator, Page } from "playwright";

// ---------------------------------------------------------------------------
// Purpose: Black-box tests for A11yStrategy (DOM-based implementation)
//
// A11yStrategy finds elements by:
//   1. Calling page.locator(CANDIDATE_SELECTOR) to collect interactive elements
//   2. For each element, extracting the accessible name via el.evaluate()
//      (aria-label → innerText → placeholder → title)
//   3. Scoring each candidate against target.description using Jaro-Winkler
//   4. Picking the highest-scoring candidate above the 0.80 threshold
//   5. Calling locator.nth(bestIndex).elementHandle() to resolve the handle
//
// NOTE: page.accessibility was completely removed in Playwright v1.43+.
// This strategy uses DOM queries instead — no accessibility snapshot API needed.
//
// These tests mock page.locator() so no real browser is needed.
// Each test exercises a distinct code path.
// ---------------------------------------------------------------------------

function makeMockElementHandle(): ElementHandle {
  return {
    boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 40 }),
    click: vi.fn(),
    fill: vi.fn(),
  } as unknown as ElementHandle;
}

// Builds a per-element nth-locator that simulates two evaluate() calls:
//   1st call → returns the accessible name (aria-label / innerText / placeholder / title)
//   2nd call → returns the role (role attr or tag name)
// This mirrors the two sequential el.evaluate() calls in A11yStrategy._locate().
function makeNthLocator(
  name: string,
  role: string,
  handle: ElementHandle | null
): Locator {
  let callCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? name : role);
    }),
    elementHandle: vi.fn().mockResolvedValue(handle),
    boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 40 }),
  } as unknown as Locator;
}

// Builds a mock top-level locator returned by page.locator(CANDIDATE_SELECTOR).
// Each entry in `candidates` becomes a separate nth-locator.
function makeCandidateLocator(
  candidates: Array<{ role: string; name: string; handle?: ElementHandle | null }>
): Locator {
  const nthLocators = candidates.map((c) =>
    makeNthLocator(c.name, c.role, c.handle !== undefined ? c.handle : makeMockElementHandle())
  );

  return {
    count: vi.fn().mockResolvedValue(candidates.length),
    nth: vi.fn().mockImplementation((i: number) => nthLocators[i]),
  } as unknown as Locator;
}

// Builds a minimal mock Page whose locator() returns the provided candidate set.
function makeMockPage(
  candidates: Array<{ role: string; name: string; handle?: ElementHandle | null }>
): Page {
  const locator = makeCandidateLocator(candidates);
  return {
    locator: vi.fn().mockReturnValue(locator),
  } as unknown as Page;
}

function makeContext(page: Page): LocatorContext {
  return { page, timeout: 5000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A11yStrategy", () => {
  let strategy: A11yStrategy;

  beforeEach(() => {
    strategy = new A11yStrategy();
  });

  it("has the correct strategy name", () => {
    expect(strategy.name).toBe("a11y");
  });

  it("returns null when target has no description, ariaLabel, or text", async () => {
    const page = makeMockPage([{ role: "button", name: "Submit" }]);
    const target: LocatorTarget = { testId: "btn" }; // no text query
    const result = await strategy.locate(target, makeContext(page));
    expect(result).toBeNull();
  });

  it("returns null when page returns zero interactive candidates", async () => {
    // Simulates a page that has no interactive / labelled elements at all
    const page = makeMockPage([]); // count() = 0
    const target: LocatorTarget = { description: "submit button" };
    const result = await strategy.locate(target, makeContext(page));
    expect(result).toBeNull();
  });

  it("finds an element when the accessible name is an exact match", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage([{ role: "button", name: "Submit", handle }]);

    const target: LocatorTarget = { description: "Submit" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("a11y");
    expect(result!.confidence).toBe(1.0);
    expect(result!.handle).toBe(handle);
  });

  it("finds an element via fuzzy match (partial label overlap)", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage([{ role: "button", name: "Search products", handle }]);

    // "search" should fuzzy-match "Search products" above 0.80
    const target: LocatorTarget = { description: "search" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("a11y");
    expect(result!.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it("returns null when best fuzzy score is below the 0.80 threshold", async () => {
    const page = makeMockPage([{ role: "button", name: "Completely unrelated text xyz" }]);

    const target: LocatorTarget = { description: "login" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("picks the highest-scoring node when multiple candidates exist", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage([
      { role: "link", name: "Contact us" },
      { role: "button", name: "Submit form" }, // closer than "Contact us" but not exact
      { role: "button", name: "Submit", handle }, // exact match — should win
    ]);

    const target: LocatorTarget = { description: "Submit" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0); // exact match wins
    expect(result!.handle).toBe(handle);
  });

  it("returns null when the winning candidate's elementHandle() returns null", async () => {
    const page = makeMockPage([
      { role: "button", name: "Confirm", handle: null },
    ]);

    const target: LocatorTarget = { description: "Confirm" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("resolves the correct nth element when the best match is not the first candidate", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage([
      { role: "button", name: "Cancel" },
      { role: "button", name: "Add to cart", handle }, // best match for "Add to cart"
    ]);

    const target: LocatorTarget = { description: "Add to cart" };
    const result = await strategy.locate(target, makeContext(page));

    // Should resolve to index 1 (the exact match), not index 0
    expect(result).not.toBeNull();
    expect(result!.handle).toBe(handle);
    expect(result!.confidence).toBe(1.0);
  });

  it("returns null when elementHandle() is null after DOM lookup", async () => {
    const page = makeMockPage([{ role: "button", name: "Login", handle: null }]);

    const target: LocatorTarget = { description: "Login" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("uses ariaLabel as query when description is not provided", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage([{ role: "textbox", name: "Search", handle }]);

    const target: LocatorTarget = { ariaLabel: "Search" }; // no description
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("a11y");
  });

  it("hydrates context.a11yTree with the collected DOM candidates", async () => {
    const page = makeMockPage([{ role: "button", name: "Go" }]);
    const ctx = makeContext(page);

    await strategy.locate({ description: "Go" }, ctx);

    // The candidate list should be stored on context for trajectory logging
    expect(ctx.a11yTree).toBeDefined();
    expect(ctx.a11yTree).toHaveLength(1);
  });

  it("returns boundingBox from the resolved element handle", async () => {
    const handle = makeMockElementHandle();
    (handle.boundingBox as ReturnType<typeof vi.fn>).mockResolvedValue({
      x: 50, y: 100, width: 200, height: 50,
    });
    const page = makeMockPage([{ role: "button", name: "Close", handle }]);

    const result = await strategy.locate({ description: "Close" }, makeContext(page));

    expect(result!.boundingBox).toEqual({ x: 50, y: 100, width: 200, height: 50 });
  });

  it("skips candidates with empty accessible names", async () => {
    const handle = makeMockElementHandle();
    // First candidate has no accessible name (empty string) — should be skipped.
    // Second candidate is a real match.
    const locator = {
      count: vi.fn().mockResolvedValue(2),
      nth: vi.fn().mockImplementation((i: number) => {
        if (i === 0) {
          let calls = 0;
          return {
            evaluate: vi.fn().mockImplementation(() => {
              calls++;
              return Promise.resolve(calls === 1 ? "" : "div"); // empty name
            }),
            elementHandle: vi.fn().mockResolvedValue(null),
          };
        }
        return makeNthLocator("Save", "button", handle);
      }),
    } as unknown as Locator;

    const page = {
      locator: vi.fn().mockReturnValue(locator),
    } as unknown as Page;

    const result = await strategy.locate({ description: "Save" }, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.handle).toBe(handle);
  });
});
