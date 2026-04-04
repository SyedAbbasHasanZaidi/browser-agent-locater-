import type {
  LocatedElement,
  LocatorContext,
  LocatorTarget,
  StrategyResult,
} from "../types/strategy.types.js";
import {
  ElementNotFoundError,
} from "../types/strategy.types.js";
import type { StrategyAttempt } from "../types/trajectory.types.js";
import type { BaseStrategy } from "../strategies/base.strategy.js";

// ---------------------------------------------------------------------------
// FallbackChain — Chain of Responsibility orchestrator
// ---------------------------------------------------------------------------
//
// Design Pattern: Chain of Responsibility
// -----------------------------------------
// FallbackChain holds an ordered list of strategies. For each locate() call:
//   1. Try each strategy in priority order (DOM → A11y → Vision)
//   2. If a strategy returns a non-null LocatedElement → stop, return it
//   3. If a strategy returns null → move to the next strategy
//   4. If a strategy throws → log the error as a failed attempt, move on
//   5. If ALL strategies return null → throw ElementNotFoundError
//
// The chain is constructed once (in ElementLocator.create()) and reused for
// every locate() call. Strategies are stateless so they are safe to share.
//
// Why Chain of Responsibility over a simple if-else ladder?
//   - Strategies are independently testable and swappable
//   - Adding a 4th strategy = add one entry to the strategies array, zero
//     changes to the chain logic
//   - The chain doesn't know what each strategy does — it only knows the
//     contract: locate() returns StrategyResult (LocatedElement | null)
//
// Dependency Flow:
//   ElementLocator → FallbackChain.locate()
//   FallbackChain  → strategy.locate() (for each strategy in order)
//   FallbackChain  → TrajectoryLogger.log() (fire-and-forget, after resolution)
// ---------------------------------------------------------------------------

export interface LocateCallResult {
  element: LocatedElement;
  attempts: StrategyAttempt[];
  totalDurationMs: number;
}

export class FallbackChain {
  constructor(
    // Strategies in priority order. The chain tries index 0 first.
    private readonly strategies: ReadonlyArray<BaseStrategy>
  ) {}

  // ---------------------------------------------------------------------------
  // locate() — the main entry point called by ElementLocator
  // ---------------------------------------------------------------------------
  // Returns LocateCallResult (element + trajectory data) on success.
  // Throws ElementNotFoundError if all strategies fail.
  // ---------------------------------------------------------------------------
  async locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<LocateCallResult> {
    const chainStart = performance.now();
    const attempts: StrategyAttempt[] = [];

    for (const strategy of this.strategies) {
      const strategyStart = performance.now();
      let result: StrategyResult = null;
      let errorMessage: string | undefined;

      try {
        result = await strategy.locate(target, context);
      } catch (error) {
        // The strategy threw — something broke (network, Playwright crash).
        // We log the error but continue to the next strategy. This means a
        // VisionServiceError (Python service down) doesn't kill the whole
        // locate() call if DOM or A11y already had a chance (though they
        // also failed if we got here).
        errorMessage =
          error instanceof Error ? error.message : String(error);
      }

      const durationMs = performance.now() - strategyStart;
      const succeeded = result !== null;

      // Record this attempt for trajectory logging regardless of outcome.
      const attempt: StrategyAttempt = {
        strategy: strategy.name,
        succeeded,
        duration_ms: durationMs,
        resolved_selector: succeeded ? result!.selector : null,
        confidence: succeeded ? result!.confidence : null,
        ...(errorMessage !== undefined && { error: errorMessage }),
      };

      attempts.push(attempt);

      // First success wins — stop the chain immediately.
      if (succeeded && result !== null) {
        const totalDurationMs = performance.now() - chainStart;
        return { element: result, attempts, totalDurationMs };
      }
    }

    // All strategies exhausted without finding the element.
    throw new ElementNotFoundError(target);
  }
}
