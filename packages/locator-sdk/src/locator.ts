import type { Page } from "playwright";
import type {
  LocatedElement,
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

/** Strategy names that can be selectively enabled */
export type StrategyName = "dom" | "a11y" | "vision";

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
   * Default: 5000ms
   */
  timeout?: number;
  /**
   * URL of the Python vision service.
   * Default: process.env.VISION_SERVICE_URL or "http://localhost:8765"
   */
  visionServiceUrl?: string;
  /**
   * BYOK (Bring Your Own Key) — your Anthropic API key.
   * When provided, forwarded as X-Anthropic-Key on every POST /locate request
   * so the Python service uses your key instead of its own configured key.
   * Required when using a shared/hosted vision service without a server-side key.
   */
  anthropicApiKey?: string;
  /**
   * Set to false to disable trajectory logging (useful in unit tests).
   * Default: true
   */
  logTrajectories?: boolean;
  /**
   * Subset of strategies to enable, in priority order.
   * Default: ["dom", "a11y", "vision"] (the full fallback chain).
   *
   * Use this to isolate a single strategy for testing or to skip expensive
   * strategies (e.g. vision) in performance-sensitive paths.
   *
   * Example: strategies: ["a11y"] — only A11y runs; DOM and Vision are skipped.
   */
  strategies?: StrategyName[];
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
      visionServiceUrl = process.env["VISION_SERVICE_URL"] ?? "http://localhost:8765",
      anthropicApiKey,
      logTrajectories = true,
      strategies: enabledStrategies,
    } = options;

    const visionClient = new VisionClient(visionServiceUrl, anthropicApiKey);

    // Build the full strategy set in priority order, then filter if the caller
    // specified a subset. This preserves the canonical DOM → A11y → Vision
    // ordering even when only a subset is enabled.
    const allStrategies: Array<{ name: StrategyName; instance: BaseStrategy }> = [
      { name: "dom", instance: new DomStrategy() },
      { name: "a11y", instance: new A11yStrategy() },
      { name: "vision", instance: new VisionStrategy(visionClient) },
    ];

    const filtered = enabledStrategies
      ? allStrategies.filter((s) => enabledStrategies.includes(s.name))
      : allStrategies;

    const chain = new FallbackChain(filtered.map((s) => s.instance));

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
  async locate(target: LocatorTarget): Promise<LocatedElement> {
    const context: LocatorContext = {
      page: this.page,
      timeout: this.timeout,
    };

    const { element, attempts, totalDurationMs } = await this.chain.locate(
      target,
      context
    );

    // Fire-and-forget trajectory logging — never awaited
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

    return element;
  }

  // ---------------------------------------------------------------------------
  // click() — Convenience: locate + click in one call
  // ---------------------------------------------------------------------------
  async click(target: LocatorTarget): Promise<LocatedElement> {
    const element = await this.locate(target);
    await element.handle.click();
    return element;
  }

  // ---------------------------------------------------------------------------
  // fill() — Convenience: locate + fill a text input in one call
  // ---------------------------------------------------------------------------
  async fill(target: LocatorTarget, value: string): Promise<LocatedElement> {
    const element = await this.locate(target);
    await element.handle.fill(value);
    return element;
  }
}
