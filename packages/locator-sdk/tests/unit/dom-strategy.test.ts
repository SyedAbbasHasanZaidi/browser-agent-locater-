import { describe, it, expect, vi, beforeEach } from "vitest";
import { DomStrategy } from "../../src/strategies/dom.strategy.js";
import type { LocatorContext, LocatorTarget } from "../../src/types/strategy.types.js";
import type { ElementHandle, Locator, Page } from "playwright";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------
// We mock Playwright's Page and Locator objects because:
//   1. Unit tests must not require a running browser
//   2. We control exactly what count()/elementHandle() return, making edge
//      cases testable (0 elements, race condition null return, etc.)
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

  // first() returns a new Locator pointing to the first element
  (locator.first as ReturnType<typeof vi.fn>).mockReturnValue({
    count: vi.fn().mockResolvedValue(Math.min(count, 1)),
    elementHandle: vi.fn().mockResolvedValue(handle),
    first: vi.fn(),
  });

  return locator;
}

function makeMockPage(locatorImpl: (selector: string) => Locator): Page {
  return {
    locator: vi.fn().mockImplementation(locatorImpl),
  } as unknown as Page;
}

function makeContext(page: Page): LocatorContext {
  return { page, timeout: 5000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DomStrategy", () => {
  let strategy: DomStrategy;

  beforeEach(() => {
    strategy = new DomStrategy();
  });

  it("returns null when no target fields are provided", async () => {
    const page = makeMockPage(() => makeMockLocator(0));
    const result = await strategy.locate({}, makeContext(page));
    expect(result).toBeNull();
  });

  it("matches cssSelector and returns confidence 1.0", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage((sel) =>
      makeMockLocator(sel === "#login-btn" ? 1 : 0, handle)
    );

    const target: LocatorTarget = { cssSelector: "#login-btn" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("dom");
    expect(result!.confidence).toBe(1.0);
    expect(result!.selector).toBe("#login-btn");
    expect(result!.handle).toBe(handle);
  });

  it("falls through to testId when cssSelector returns 0 elements", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage((sel) => {
      if (sel === '[data-testid="submit-btn"]') return makeMockLocator(1, handle);
      return makeMockLocator(0);
    });

    const target: LocatorTarget = {
      cssSelector: ".old-class",  // stale, 0 matches
      testId: "submit-btn",       // this should win
    };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.selector).toBe('[data-testid="submit-btn"]');
  });

  it("returns null when elementHandle() races and returns null (dynamic DOM)", async () => {
    // Simulates the race condition: count()=1 but element disappears before
    // elementHandle() resolves (React re-render between the two calls)
    const unstableLocator = makeMockLocator(1, null);
    const page = makeMockPage(() => unstableLocator);

    const target: LocatorTarget = { cssSelector: ".btn" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result).toBeNull();
  });

  it("uses first() when multiple elements match", async () => {
    const handle = makeMockElementHandle();
    const locator = makeMockLocator(3, handle);
    const page = makeMockPage(() => locator);

    const target: LocatorTarget = { cssSelector: "button" };
    const result = await strategy.locate(target, makeContext(page));

    expect(locator.first).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("returns boundingBox from elementHandle", async () => {
    const handle = makeMockElementHandle();
    (handle.boundingBox as ReturnType<typeof vi.fn>).mockResolvedValue({
      x: 50, y: 100, width: 200, height: 50,
    });
    const page = makeMockPage(() => makeMockLocator(1, handle));

    const target: LocatorTarget = { cssSelector: "#btn" };
    const result = await strategy.locate(target, makeContext(page));

    expect(result!.boundingBox).toEqual({ x: 50, y: 100, width: 200, height: 50 });
  });

  it("has the correct strategy name", () => {
    expect(strategy.name).toBe("dom");
  });
});
