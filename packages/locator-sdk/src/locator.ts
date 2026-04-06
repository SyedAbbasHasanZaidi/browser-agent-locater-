import type { Page } from "playwright";
import type {
  LocateResult,
  LocatorContext,
  LocatorTarget,
} from "./types/strategy.types.js";
import { DomStrategy } from "./strategies/dom.strategy.js";
import { A11yStrategy } from "./strategies/a11y.strategy.js";
import { VisionStrategy } from "./strategies/vision.strategy.js";
import { FallbackChain } from "./fallback/chain.js";
import { VisionClient } from "./transport/vision-client.js";
import { TrajectoryLogger } from "./trajectory/logger.js";

// ---------------------------------------------------------------------------
// ElementLocator — Public API and Factory
// ---------------------------------------------------------------------------
//
// Design Pattern: Factory Method (ElementLocator.create())
// ---------------------------------------------------------
// Construction is deliberately hidden behind ElementLocator.create().
// The factory wires:
//   - All three strategies (Dom, A11y, Vision)
//   - VisionClient with the service URL from options or environment
//   - FallbackChain with strategies in priority order
//   - TrajectoryLogger with the session ID
//
// Callers never instantiate strategies directly — they only see:
//   const locator = ElementLocator.create({ page, sessionId })
//   const el = await locator.locate({ description: "the login button" })
//   await el.handle.click()
//
// This hides construction complexity and prevents callers from accidentally
// constructing a misconfigured chain (e.g. VisionStrategy with no client).
//
// Configuration philosophy:
//   The SDK works out-of-the-box with minimal config. Only `page` and
//   `sessionId` are required. Everything else has sensible defaults:
//     - Vision service URL → hosted instance (Railway)
//     - Anthropic API key  → reads from ANTHROPIC_API_KEY env var
//     - Timeout            → 5000ms
//     - Trajectory logging → enabled
//
//   Advanced users can override via options for self-hosted deployments
//   or custom key management. But the default path is:
//     1. Set ANTHROPIC_API_KEY in your environment
//     2. Call ElementLocator.create({ page, sessionId })
//     3. Done.
//
// Data Flow for a locate() call:
//   locator.locate(target)
//     → hydrate LocatorContext { page, timeout }
//     → FallbackChain.locate(target, context)
//         → DomStrategy.locate()     → LocatedElement | null
//         → A11yStrategy.locate()    → LocatedElement | null (if DOM failed)
//         → VisionStrategy.locate()  → LocatedElement | null (if A11y failed)
//     → void TrajectoryLogger.log() ← fire-and-forget
//     → return LocatedElement
//       OR throw ElementNotFoundError
// ---------------------------------------------------------------------------

// The default hosted vision service. Consumers get a working SDK without
// configuring a URL — same pattern as Stripe defaulting to api.stripe.com.
const DEFAULT_VISION_SERVICE_URL = "https://locator-sdk-production.up.railway.app";

export interface ElementLocatorOptions {
  /** The Playwright page to operate on */
  page: Page;
  /**
   * UUID v4 session identifier. All locate() calls on this instance share
   * the same session in trajectory logs, making agent runs reconstructable.
   */
  sessionId: string;
  /**
   * Per-locate timeout in milliseconds. Each strategy gets this budget.
   * Default: 5000ms. Increase to 10000+ if Railway cold-starts cause timeouts.
   */
  timeout?: number;
  /**
   * Override the vision service URL. Most users do NOT need to set this.
   *
   * Default resolution (first match wins):
   *   1. This option (if provided)
   *   2. process.env.VISION_SERVICE_URL
   *   3. Hosted service at https://locator-sdk-production.up.railway.app
   *
   * Only set this if you self-host the vision service or need to point at
   * a different instance (staging, local dev, etc.).
   */
  visionServiceUrl?: string;
  /**
   * Your Anthropic API key for the Vision strategy (BYOK).
   *
   * Default resolution (first match wins):
   *   1. This option (if provided)
   *   2. process.env.ANTHROPIC_API_KEY
   *
   * The recommended approach: set ANTHROPIC_API_KEY in your environment
   * and don't pass this option at all. The SDK reads it automatically.
   *
   * Only pass this option if you need per-instance key overrides
   * (e.g., multi-tenant setup with different keys per user).
   */
  anthropicApiKey?: string;
  /**
   * Set to false to disable trajectory logging (useful in unit tests).
   * Default: true
   */
  logTrajectories?: boolean;
}

export class ElementLocator {
  private readonly chain: FallbackChain;
  private readonly logger: TrajectoryLogger | null;
  private readonly page: Page;
  private readonly timeout: number;

  // Private constructor — use ElementLocator.create() instead
  private constructor(
    chain: FallbackChain,
    logger: TrajectoryLogger | null,
    page: Page,
    timeout: number
  ) {
    this.chain = chain;
    this.logger = logger;
    this.page = page;
    this.timeout = timeout;
  }

  // ---------------------------------------------------------------------------
  // create() — Factory method
  // ---------------------------------------------------------------------------
  static create(options: ElementLocatorOptions): ElementLocator {
    const {
      page,
      sessionId,
      timeout = 5000,
      visionServiceUrl = process.env["VISION_SERVICE_URL"] ?? DEFAULT_VISION_SERVICE_URL,
      anthropicApiKey = process.env["ANTHROPIC_API_KEY"],
      logTrajectories = true,
    } = options;

    const visionClient = new VisionClient(visionServiceUrl, anthropicApiKey);

    const chain = new FallbackChain([
      new DomStrategy(),
      new A11yStrategy(),
      new VisionStrategy(visionClient),
    ]);

    const logger = logTrajectories
      ? new TrajectoryLogger(sessionId, visionServiceUrl)
      : null;

    return new ElementLocator(chain, logger, page, timeout);
  }

  // ---------------------------------------------------------------------------
  // locate() — Find an element using the fallback chain
  // ---------------------------------------------------------------------------
  // The primary method callers use. Returns the located element on success.
  // Throws ElementNotFoundError if all strategies fail.
  //
  // Example:
  //   const el = await locator.locate({ description: "the search button" })
  //   await el.handle.click()
  // ---------------------------------------------------------------------------
  async locate(target: LocatorTarget): Promise<LocateResult> {
    const context: LocatorContext = {
      page: this.page,
      timeout: this.timeout,
    };

    const { element, attempts, totalDurationMs } = await this.chain.locate(
      target,
      context
    );

    // Fire-and-forget trajectory logging — never awaited
    // Uses the full LocatedElement (with selector + boundingBox) internally.
    if (this.logger) {
      void this.logger.log({
        target,
        pageUrl: this.page.url(),
        attempts,
        winner: element.strategy,
        resolvedSelector: element.selector,
        totalDurationMs,
      });
    }

    // Return the slim public type — strip internal metadata
    const result: LocateResult = {
      handle: element.handle,
      strategy: element.strategy,
      confidence: element.confidence,
    };
    return result;
  }

  // ---------------------------------------------------------------------------
  // click() — Convenience: locate + click in one call
  // ---------------------------------------------------------------------------
  async click(target: LocatorTarget): Promise<LocateResult> {
    const result = await this.locate(target);
    await result.handle.click();
    return result;
  }

  // ---------------------------------------------------------------------------
  // fill() — Convenience: locate + fill a text input in one call
  // ---------------------------------------------------------------------------
  async fill(target: LocatorTarget, value: string): Promise<LocateResult> {
    const result = await this.locate(target);
    await result.handle.fill(value);
    return result;
  }
}
