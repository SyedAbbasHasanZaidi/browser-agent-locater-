import type { LocatorContext, LocatorTarget, StrategyResult } from "../types/strategy.types.js";

// ---------------------------------------------------------------------------
// BaseStrategy — Abstract contract for all location strategies
// ---------------------------------------------------------------------------
//
// Design Pattern: Template Method
// --------------------------------
// BaseStrategy defines the SKELETON of the locate algorithm:
//   1. Start a timeout timer
//   2. Call the subclass's _locate() implementation
//   3. Cancel the timer if it resolves first
//   4. Throw a TimeoutError if the timer fires first
//
// Subclasses (DomStrategy, A11yStrategy, VisionStrategy) implement _locate()
// and never need to think about timeouts. The timeout logic lives exactly once,
// here, and is guaranteed to run for every strategy.
//
// Why Abstract Class over Interface?
// ------------------------------------
// An interface would only enforce the shape (locate() exists). An abstract
// class lets us share the withTimeout() wrapper implementation — code that
// every concrete strategy needs identically. This eliminates copy-paste and
// ensures every strategy honours the timeout contract.
//
// Dependency Flow:
//   FallbackChain → BaseStrategy.locate() → subclass._locate()
//                                         → withTimeout()
// ---------------------------------------------------------------------------

export abstract class BaseStrategy {
  // The human-readable name of the strategy, used in logs and trajectory records.
  abstract readonly name: "dom" | "a11y" | "vision";

  // Default timeout for a single strategy attempt in milliseconds.
  // The FallbackChain passes context.timeout which overrides this default.
  protected readonly defaultTimeout: number = 5000;

  // ---------------------------------------------------------------------------
  // locate() — the public method called by FallbackChain
  // ---------------------------------------------------------------------------
  // Wraps _locate() with a timeout boundary. Returns null on timeout rather
  // than throwing, so the chain treats a timed-out strategy the same as one
  // that simply could not find the element.
  // ---------------------------------------------------------------------------
  async locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<StrategyResult> {
    const timeout = context.timeout ?? this.defaultTimeout;
    return this.withTimeout(this._locate(target, context), timeout);
  }

  // ---------------------------------------------------------------------------
  // _locate() — the abstract hook subclasses must implement
  // ---------------------------------------------------------------------------
  // Should return:
  //   - LocatedElement  : element found
  //   - null            : element not found by this strategy (chain continues)
  //
  // Should throw when something is broken (Playwright crashed, service down).
  // The FallbackChain catches thrown errors, logs them, and continues.
  // ---------------------------------------------------------------------------
  protected abstract _locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<StrategyResult>;

  // ---------------------------------------------------------------------------
  // withTimeout() — Template Method helper
  // ---------------------------------------------------------------------------
  // Races the strategy's promise against a timeout promise.
  // On timeout: returns null (not an error) — timed-out = "didn't find it".
  // Uses Promise.race() so the winning branch resolves immediately and the
  // losing branch is abandoned (no memory leak because Promises are GC'd).
  // ---------------------------------------------------------------------------
  private withTimeout(
    promise: Promise<StrategyResult>,
    ms: number
  ): Promise<StrategyResult> {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), ms)
    );
    return Promise.race([promise, timeout]);
  }
}
