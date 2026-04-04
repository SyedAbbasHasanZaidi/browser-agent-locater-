import { describe, it, expect, vi, beforeEach } from "vitest";
import { VisionStrategy } from "../../src/strategies/vision.strategy.js";
import { VisionClient, VisionServiceError } from "../../src/transport/vision-client.js";
import type { LocatorContext, LocatorTarget } from "../../src/types/strategy.types.js";
import type { ElementHandle, JSHandle, Page } from "playwright";

// ---------------------------------------------------------------------------
// Purpose: Black-box tests for VisionStrategy
//
// VisionStrategy:
//   1. Captures a full-page screenshot (only if context.screenshotBase64 is unset)
//   2. POSTs to VisionClient.locate() with description + screenshot
//   3. If found + confidence >= 0.70: resolves bounding box centroid to DOM handle
//      via page.evaluateHandle(document.elementFromPoint(cx, cy))
//   4. Returns LocatedElement | null
//
// VisionClient is mocked — no HTTP calls are made.
// ---------------------------------------------------------------------------

function makeMockVisionClient(
  overrides: Partial<{
    found: boolean;
    confidence: number;
    bounding_box: { x: number; y: number; width: number; height: number } | null;
  }> = {}
): VisionClient {
  const response = {
    found: true,
    confidence: 0.9,
    bounding_box: { x: 100, y: 200, width: 80, height: 40 },
    reasoning: "Found the button",
    latency_ms: 1200,
    ...overrides,
  };

  return {
    locate: vi.fn().mockResolvedValue(response),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as VisionClient;
}

function makeMockElementHandle(): ElementHandle {
  return {
    boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 200, width: 80, height: 40 }),
    click: vi.fn(),
  } as unknown as ElementHandle;
}

function makeMockPage(elementHandle: ElementHandle | null = makeMockElementHandle()): Page {
  const jsHandle = {
    asElement: vi.fn().mockReturnValue(elementHandle),
  } as unknown as JSHandle;

  return {
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
    url: vi.fn().mockReturnValue("http://localhost/test"),
    evaluateHandle: vi.fn().mockResolvedValue(jsHandle),
  } as unknown as Page;
}

function makeContext(page: Page, screenshotBase64?: string): LocatorContext {
  return { page, timeout: 5000, screenshotBase64 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VisionStrategy", () => {
  let client: VisionClient;
  let strategy: VisionStrategy;

  beforeEach(() => {
    client = makeMockVisionClient();
    strategy = new VisionStrategy(client);
  });

  it("has the correct strategy name", () => {
    expect(strategy.name).toBe("vision");
  });

  it("returns null when target has no description, text, or ariaLabel", async () => {
    const page = makeMockPage();
    const target: LocatorTarget = { testId: "btn" }; // no natural language
    const result = await strategy.locate(target, makeContext(page));
    expect(result).toBeNull();
    expect(client.locate).not.toHaveBeenCalled();
  });

  it("captures a screenshot if context.screenshotBase64 is not set", async () => {
    const page = makeMockPage();
    const ctx = makeContext(page); // no screenshot pre-set
    await strategy.locate({ description: "search button" }, ctx);

    expect(page.screenshot).toHaveBeenCalledWith({ fullPage: true });
    // screenshot should now be stored in context
    expect(ctx.screenshotBase64).toBeDefined();
  });

  it("reuses context.screenshotBase64 if already set (lazy capture — no second screenshot)", async () => {
    const page = makeMockPage();
    const ctx = makeContext(page, "already-captured-base64");
    await strategy.locate({ description: "search button" }, ctx);

    expect(page.screenshot).not.toHaveBeenCalled();
    // The pre-set value should be passed to the client
    expect(client.locate).toHaveBeenCalledWith(
      expect.objectContaining({ screenshot_base64: "already-captured-base64" })
    );
  });

  it("calls VisionClient.locate with description and page URL", async () => {
    const page = makeMockPage();
    await strategy.locate({ description: "the login button" }, makeContext(page));

    expect(client.locate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "the login button",
        page_url: "http://localhost/test",
      })
    );
  });

  it("returns null when VisionClient reports found=false", async () => {
    client = makeMockVisionClient({ found: false, bounding_box: null });
    strategy = new VisionStrategy(client);
    const page = makeMockPage();

    const result = await strategy.locate({ description: "ghost element" }, makeContext(page));
    expect(result).toBeNull();
  });

  it("returns null when confidence is below 0.70 threshold", async () => {
    client = makeMockVisionClient({ found: true, confidence: 0.65 });
    strategy = new VisionStrategy(client);
    const page = makeMockPage();

    const result = await strategy.locate({ description: "blurry button" }, makeContext(page));
    expect(result).toBeNull();
  });

  it("returns LocatedElement when found=true and confidence >= 0.70", async () => {
    const page = makeMockPage();
    const result = await strategy.locate({ description: "Reserve" }, makeContext(page));

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("vision");
    expect(result!.confidence).toBe(0.9);
  });

  it("calls elementFromPoint with the centroid of the bounding box", async () => {
    // Bounding box: x=100, y=200, w=80, h=40 → centroid: cx=140, cy=220
    const page = makeMockPage();
    await strategy.locate({ description: "Reserve" }, makeContext(page));

    expect(page.evaluateHandle).toHaveBeenCalledWith(
      expect.any(Function),
      { cx: 140, cy: 220 }
    );
  });

  it("encodes the centroid in the selector string for debugging", async () => {
    const page = makeMockPage();
    const result = await strategy.locate({ description: "Reserve" }, makeContext(page));

    // cx = 100 + 80/2 = 140, cy = 200 + 40/2 = 220
    expect(result!.selector).toBe("vision:elementFromPoint(140,220)");
  });

  it("returns null when elementFromPoint returns null (gap in layout)", async () => {
    const jsHandle = { asElement: vi.fn().mockReturnValue(null) } as unknown as JSHandle;
    const page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("s")),
      url: vi.fn().mockReturnValue("http://localhost"),
      evaluateHandle: vi.fn().mockResolvedValue(jsHandle),
    } as unknown as Page;

    const result = await strategy.locate({ description: "floating button" }, makeContext(page));
    expect(result).toBeNull();
  });

  it("includes the bounding box in the result", async () => {
    const page = makeMockPage();
    const result = await strategy.locate({ description: "Reserve" }, makeContext(page));

    expect(result!.boundingBox).toEqual({ x: 100, y: 200, width: 80, height: 40 });
  });

  it("re-throws VisionServiceError so FallbackChain can log it", async () => {
    (client.locate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new VisionServiceError("Service unreachable")
    );
    const page = makeMockPage();

    await expect(
      strategy.locate({ description: "login" }, makeContext(page))
    ).rejects.toThrow(VisionServiceError);
  });

  it("uses ariaLabel as description fallback when description is absent", async () => {
    const page = makeMockPage();
    await strategy.locate({ ariaLabel: "close modal" }, makeContext(page));

    expect(client.locate).toHaveBeenCalledWith(
      expect.objectContaining({ description: "close modal" })
    );
  });
});
