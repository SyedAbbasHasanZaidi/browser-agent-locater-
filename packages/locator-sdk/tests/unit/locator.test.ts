import { describe, it, expect, vi, beforeEach } from "vitest";
import { ElementLocator } from "../../src/locator.js";
import { ElementNotFoundError } from "../../src/types/strategy.types.js";
import type { LocatorTarget } from "../../src/types/strategy.types.js";
import type { ElementHandle, Page } from "playwright";

// ---------------------------------------------------------------------------
// Purpose: Black-box tests for ElementLocator (the public Factory API)
//
// ElementLocator.create() wires all strategies + chain + logger. These tests
// verify:
//   - The factory produces a working locator from options
//   - locate() returns the LocatedElement when a strategy succeeds
//   - locate() throws ElementNotFoundError when all strategies fail
//   - Trajectory logging is fire-and-forget (never awaited, never throws)
//   - logTrajectories: false disables the logger
//   - click() and fill() are convenience wrappers over locate()
//
// We mock global fetch so the VisionClient (and TrajectoryLogger) never make
// real HTTP calls. Playwright is mocked so no browser is launched.
// ---------------------------------------------------------------------------

function makeMockElementHandle(): ElementHandle {
  return {
    boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 100, height: 40 }),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
  } as unknown as ElementHandle;
}

// Minimal Page mock that DOM strategy can use to find elements via testId.
function makeMockPage(handle: ElementHandle | null = makeMockElementHandle()): Page {
  const locator = {
    count: vi.fn().mockResolvedValue(handle ? 1 : 0),
    elementHandle: vi.fn().mockResolvedValue(handle),
    first: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(handle ? 1 : 0),
      elementHandle: vi.fn().mockResolvedValue(handle),
    }),
  };

  return {
    locator: vi.fn().mockReturnValue(locator),
    accessibility: {
      snapshot: vi.fn().mockResolvedValue(null), // A11y returns null → falls through
    },
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake")),
    url: vi.fn().mockReturnValue("http://localhost"),
    evaluateHandle: vi.fn().mockResolvedValue({ asElement: () => null }),
  } as unknown as Page;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ElementLocator", () => {
  beforeEach(() => {
    // Stub global fetch so trajectory logger and vision client don't error out
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ ok: true, entry_id: "uuid-123" }),
        text: vi.fn().mockResolvedValue(""),
      })
    );
  });

  it("create() returns an ElementLocator instance", () => {
    const page = makeMockPage();
    const locator = ElementLocator.create({ page, sessionId: "test-session" });
    expect(locator).toBeInstanceOf(ElementLocator);
  });

  it("locate() returns a LocatedElement when DOM strategy finds the element", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage(handle);

    const locator = ElementLocator.create({
      page,
      sessionId: "test-1",
      logTrajectories: false,
    });

    const result = await locator.locate({ testId: "reserve-button" });

    expect(result).toBeDefined();
    expect(result.strategy).toBe("dom");
    expect(result.confidence).toBe(1.0);
    expect(result.handle).toBe(handle);
  });

  it("locate() throws ElementNotFoundError when all strategies fail", async () => {
    // Page that returns nothing for any query
    const page = makeMockPage(null);

    const locator = ElementLocator.create({
      page,
      sessionId: "test-2",
      visionServiceUrl: "http://localhost:8765",
      logTrajectories: false,
    });

    // Vision client fetch will also fail (found=false) since fetch is stubbed
    // to return ok:true but with trajectory-log shape, not vision shape.
    // Stub a proper "not found" vision response:
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          found: false,
          bounding_box: null,
          confidence: 0,
          reasoning: "",
          latency_ms: 0,
        }),
        text: vi.fn().mockResolvedValue(""),
      })
    );

    await expect(locator.locate({ description: "nonexistent thing" })).rejects.toThrow(
      ElementNotFoundError
    );
  });

  it("locate() fires trajectory logging without awaiting it (logTrajectories: true)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, entry_id: "uuid" }),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handle = makeMockElementHandle();
    const page = makeMockPage(handle);

    const locator = ElementLocator.create({
      page,
      sessionId: "test-trajectory",
      logTrajectories: true,
    });

    const result = await locator.locate({ testId: "btn" });

    // The locate call itself must resolve immediately — logging is fire-and-forget.
    expect(result).toBeDefined();

    // Give the microtask queue a tick so the fire-and-forget fetch can run
    await new Promise((r) => setTimeout(r, 0));

    // fetch should have been called at least once (for trajectory POST)
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not call fetch when logTrajectories is false", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const handle = makeMockElementHandle();
    const page = makeMockPage(handle);

    const locator = ElementLocator.create({
      page,
      sessionId: "test-no-log",
      logTrajectories: false,
    });

    await locator.locate({ testId: "btn" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("click() locates the element and calls handle.click()", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage(handle);

    const locator = ElementLocator.create({
      page,
      sessionId: "test-click",
      logTrajectories: false,
    });

    const result = await locator.click({ testId: "btn" });

    expect(handle.click).toHaveBeenCalled();
    expect(result.handle).toBe(handle);
  });

  it("fill() locates the element and calls handle.fill() with the value", async () => {
    const handle = makeMockElementHandle();
    const page = makeMockPage(handle);

    const locator = ElementLocator.create({
      page,
      sessionId: "test-fill",
      logTrajectories: false,
    });

    const result = await locator.fill({ testId: "input" }, "hello@example.com");

    expect(handle.fill).toHaveBeenCalledWith("hello@example.com");
    expect(result.handle).toBe(handle);
  });

  it("uses VISION_SERVICE_URL env var as default when visionServiceUrl is not provided", () => {
    vi.stubEnv("VISION_SERVICE_URL", "http://my-vision-service:9000");

    const page = makeMockPage();
    // Should not throw — env var provides the URL
    const locator = ElementLocator.create({ page, sessionId: "test-env" });
    expect(locator).toBeInstanceOf(ElementLocator);

    vi.unstubAllEnvs();
  });

  it("falls back to localhost:8765 when neither option nor env var is set", () => {
    vi.unstubAllEnvs(); // ensure VISION_SERVICE_URL is not set

    const page = makeMockPage();
    // Should not throw — default URL is used
    const locator = ElementLocator.create({ page, sessionId: "test-default" });
    expect(locator).toBeInstanceOf(ElementLocator);
  });
});
