import type {
  LocatedElement,
  LocatorContext,
  LocatorTarget,
  StrategyResult,
} from "../types/strategy.types.js";
import { VisionClient, VisionServiceError } from "../transport/vision-client.js";
import { BaseStrategy } from "./base.strategy.js";

// ---------------------------------------------------------------------------
// VisionStrategy — Priority 3 (~2500ms)
// ---------------------------------------------------------------------------
//
// The most resilient strategy. Captures a full-page screenshot, sends it to
// the Python FastAPI vision service (which calls Claude), receives a pixel
// bounding box, then resolves the bounding box back to a live DOM element
// using document.elementFromPoint().
//
// This strategy only runs when both DOM and A11y have returned null. It is
// the "last resort" that works even when:
//   - All CSS selectors are stale (post-deploy DOM restructure)
//   - The element has no accessible label (Jaro-Winkler has nothing to match)
//   - The element appears only after a dynamic animation or lazy load
//
// Control Flow:
//   1. Lazily capture full-page screenshot (only if not already in context)
//   2. POST to Python /locate with screenshot + description
//   3. If found=false or confidence<threshold → return null
//   4. Compute centroid of bounding box: cx = x + w/2, cy = y + h/2
//   5. page.evaluate(document.elementFromPoint(cx, cy)) → live ElementHandle
//   6. Return LocatedElement with confidence from Claude
//
// Why document.elementFromPoint() instead of Playwright's mouse.click()?
//   elementFromPoint() returns the DOM node at that pixel coordinate. We need
//   the ElementHandle to return to the caller (so they can decide whether to
//   click, focus, read text, etc.). Using mouse.click() directly would bypass
//   the caller's control and is too opinionated for an SDK.
//
// Confidence threshold: 0.70
//   Below 0.70, Claude's bounding box is likely to miss the element center,
//   causing elementFromPoint() to resolve to an adjacent or parent element.
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.70;

export class VisionStrategy extends BaseStrategy {
  readonly name = "vision" as const;

  constructor(private readonly visionClient: VisionClient) {
    super();
  }

  protected async _locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<StrategyResult> {
    // Vision strategy requires a natural-language description to prompt Claude.
    // Without it we have nothing to send to the vision service.
    const description = target.description ?? target.text ?? target.ariaLabel;
    if (!description) {
      return null;
    }

    // Lazy screenshot capture — only taken if we actually reach this strategy.
    // Base64-encode a full-page PNG. Full-page (not viewport-only) ensures
    // elements below the fold are visible to Claude.
    if (!context.screenshotBase64) {
      const buffer = await context.page.screenshot({ fullPage: true });
      context.screenshotBase64 = buffer.toString("base64");
    }

    const pageUrl = context.page.url();

    let serviceResponse;
    try {
      serviceResponse = await this.visionClient.locate({
        screenshot_base64: context.screenshotBase64,
        description,
        page_url: pageUrl,
      });
    } catch (error) {
      if (error instanceof VisionServiceError) {
        // Service is unreachable or returned an error — treat as not found
        // (the chain will throw ElementNotFoundError after all strategies fail).
        // We re-throw so BaseStrategy can log it, but it won't block the chain.
        throw error;
      }
      throw error;
    }

    // Claude couldn't find the element or is below our confidence floor
    if (
      !serviceResponse.found ||
      serviceResponse.bounding_box === null ||
      (serviceResponse.confidence ?? 0) < CONFIDENCE_THRESHOLD
    ) {
      return null;
    }

    const { x, y, width, height } = serviceResponse.bounding_box;

    // Compute the centroid of the bounding box for elementFromPoint()
    const cx = x + width / 2;
    const cy = y + height / 2;

    // Resolve pixel coords → live DOM ElementHandle via browser-side evaluation.
    // page.evaluateHandle runs in the browser context and returns the node at
    // those exact pixel coordinates in the document coordinate space.
    const handle = await context.page.evaluateHandle(
      ({ cx, cy }) => document.elementFromPoint(cx, cy),
      { cx, cy }
    );

    // evaluateHandle returns JSHandle<Element | null>.
    // asElement() narrows it to ElementHandle<Element> | null.
    const elementHandle = handle.asElement();

    if (elementHandle === null) {
      // No element at those coordinates (gap in the layout, scrolled out of
      // viewport for non-fullPage coordinates, etc.)
      return null;
    }

    const result: LocatedElement = {
      handle: elementHandle,
      strategy: "vision",
      confidence: serviceResponse.confidence ?? 0,
      // The selector encodes the bounding box centroid — useful for debugging
      // and trajectory inspection even though it's not a CSS selector.
      selector: `vision:elementFromPoint(${cx},${cy})`,
      boundingBox: { x, y, width, height },
    };

    return result;
  }
}
