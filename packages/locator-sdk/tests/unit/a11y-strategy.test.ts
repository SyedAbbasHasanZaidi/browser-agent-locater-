import { describe, it, expect, vi, beforeEach } from "vitest";
import { A11yStrategy } from "../../src/strategies/a11y.strategy.js";
import type { LocatorContext, LocatorTarget } from "../../src/types/strategy.types.js";
import type { ElementHandle, Locator, Page } from "playwright";

// ---------------------------------------------------------------------------
// Purpose: Black-box tests for A11yStrategy
//
// A11yStrategy finds elements by:
//   1. Calling page.accessibility.snapshot() to get the semantic tree
//   2. BFS traversal + Jaro-Winkler fuzzy match against target.description
//   3. Mapping the winning node back to DOM via page.locator(role + name)
//
// These tests mock page.accessibility.snapshot() and page.locator() so no
// real browser is needed. Each test exercises a distinct code path.
// ---------------------------------------------------------------------------

function makeMockElementHandle(): ElementHandle {
  return {
    boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 40 }),
    click: vi.fn(),
    fill: vi.fn(),
  } as unknown as ElementHandle;
}

function makeMockLocator(count: number, handle: ElementHandle | null = makeMockElementHandle()): Locator {
  const locator = {
    count: vi.fn().mockResolvedValue(count),
    elementHandle: vi.fn().mockResolvedValue(handle),
    first: vi.fn(),
  } as unknown as Locator;

  (locator.first as ReturnType<typeof vi.fn>).mockReturnValue({
    count: vi.fn().mockResolvedValue(Math.min(count, 1)),
    elementHandle: vi.fn().mockResolvedValue(handle),
    first: vi.fn(),
  });

  return locator;
}

// Builds a minimal mock Page with a configurable a11y snapshot and locator.
function makeMockPage(
  snapshot: object | null,
  locatorImpl: (selector: string) => Locator = () => makeMockLocator(1)
): Page {
  return {
    accessibility: {
      snapshot: vi.fn().mockResolvedValue(snapshot),
    },
    locator: vi.fn().mockImplementation(locatorImpl),
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
    const page = makeMockPage({ role: "RootWebArea", children: [] });
    const target: LocatorTarget = { testId: "btn" }; // no text query
    const result = await strategy.locate(target, makeContext(page));
    expect(result).toBeNull();
  });

  it("returns null when page.accessibility.snapshot() returns null (page still loading)", async () => {
    const page = makeMockPage(null);
    const target: LocatorTarget = { description: "submit button" };
    const result = await strategy.locate(target, makeContext(page));
    expect(result).toBeNull();
  });

  it("finds an element when the a11y name is an exact match", async () => {
    const handle = makeMockElementHandle();
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "button", name: "Submit" },
      ],
    };
    const page = makeMockPage(snapshot, () => makeMockLocator(1, handle));

    const target: LocatorTarget = { description: "Submit" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("a11y");
    expect(result!.confidence).toBe(1.0);
    expect(result!.handle).toBe(handle);
  });

  it("finds an element via fuzzy match (partial label overlap)", async () => {
    const handle = makeMockElementHandle();
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "button", name: "Search products" },
      ],
    };
    const page = makeMockPage(snapshot, () => makeMockLocator(1, handle));

    // "search" should fuzzy-match "Search products" above 0.80
    const target: LocatorTarget = { description: "search" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("a11y");
    expect(result!.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it("returns null when best fuzzy score is below the 0.80 threshold", async () => {
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "button", name: "Completely unrelated text xyz" },
      ],
    };
    const page = makeMockPage(snapshot);

    const target: LocatorTarget = { description: "login" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("picks the highest-scoring node when multiple nodes exist", async () => {
    const handle = makeMockElementHandle();
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "link", name: "Contact us" },
        { role: "button", name: "Submit form" }, // closer match to "submit"
        { role: "button", name: "Submit" },       // exact match — should win
      ],
    };

    // Locator returns our handle for the "Submit" selector
    const page = makeMockPage(snapshot, (sel: string) => {
      if (sel.includes("Submit")) return makeMockLocator(1, handle);
      return makeMockLocator(1);
    });

    const target: LocatorTarget = { description: "Submit" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0); // exact match
  });

  it("returns null when the winning a11y node cannot be found in DOM (custom ARIA)", async () => {
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "button", name: "Confirm" },
      ],
    };
    // Locator returns 0 elements — node is in the a11y tree but Playwright can't find it
    const page = makeMockPage(snapshot, () => makeMockLocator(0));

    const target: LocatorTarget = { description: "Confirm" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("uses first() when multiple DOM elements match the a11y selector", async () => {
    const handle = makeMockElementHandle();
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "button", name: "Add to cart" },
      ],
    };
    const locator = makeMockLocator(3, handle); // 3 matching elements
    const page = makeMockPage(snapshot, () => locator);

    const target: LocatorTarget = { description: "Add to cart" };
    const result = await strategy.locate(target, makeContext(page));

    expect(locator.first).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("returns null when elementHandle() is null after DOM lookup", async () => {
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "button", name: "Login" },
      ],
    };
    // elementHandle() returns null (element disappeared between snapshot and handle())
    const page = makeMockPage(snapshot, () => makeMockLocator(1, null));

    const target: LocatorTarget = { description: "Login" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("uses ariaLabel as query when description is not provided", async () => {
    const handle = makeMockElementHandle();
    const snapshot = {
      role: "RootWebArea",
      children: [
        { role: "textbox", name: "Search" },
      ],
    };
    const page = makeMockPage(snapshot, () => makeMockLocator(1, handle));

    const target: LocatorTarget = { ariaLabel: "Search" }; // no description
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("a11y");
  });

  it("hydrates context.a11yTree with the snapshot", async () => {
    const snapshot = {
      role: "RootWebArea",
      children: [{ role: "button", name: "Go" }],
    };
    const page = makeMockPage(snapshot, () => makeMockLocator(1));
    const ctx = makeContext(page);

    await strategy.locate({ description: "Go" }, ctx);

    // The snapshot should have been stored on the context for trajectory logging
    expect(ctx.a11yTree).toBeDefined();
    expect(ctx.a11yTree).toHaveLength(1);
  });

  it("returns boundingBox from the resolved element handle", async () => {
    const handle = makeMockElementHandle();
    (handle.boundingBox as ReturnType<typeof vi.fn>).mockResolvedValue({
      x: 50, y: 100, width: 200, height: 50,
    });
    const snapshot = {
      role: "RootWebArea",
      children: [{ role: "button", name: "Close" }],
    };
    const page = makeMockPage(snapshot, () => makeMockLocator(1, handle));

    const result = await strategy.locate({ description: "Close" }, makeContext(page));

    expect(result!.boundingBox).toEqual({ x: 50, y: 100, width: 200, height: 50 });
  });
});
