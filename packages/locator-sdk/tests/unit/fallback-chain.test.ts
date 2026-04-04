import { describe, it, expect, vi } from "vitest";
import { FallbackChain } from "../../src/fallback/chain.js";
import { ElementNotFoundError } from "../../src/types/strategy.types.js";
import type { BaseStrategy } from "../../src/strategies/base.strategy.js";
import type {
  LocatedElement,
  LocatorContext,
  LocatorTarget,
  StrategyResult,
} from "../../src/types/strategy.types.js";
import type { ElementHandle } from "playwright";

// ---------------------------------------------------------------------------
// Purpose: Black-box tests for FallbackChain
//
// FallbackChain implements Chain of Responsibility:
//   - Tries strategies in order (DOM → A11y → Vision)
//   - Stops on first non-null result
//   - Catches and records strategy errors without propagating them
//   - Throws ElementNotFoundError when all strategies fail
//   - Records StrategyAttempt[] for trajectory logging
// ---------------------------------------------------------------------------

function makeMockElementHandle(): ElementHandle {
  return {} as unknown as ElementHandle;
}

function makeLocatedElement(strategy: "dom" | "a11y" | "vision"): LocatedElement {
  return {
    handle: makeMockElementHandle(),
    strategy,
    confidence: 1.0,
    selector: `#${strategy}-element`,
  };
}

// Creates a mock BaseStrategy that returns the given result when locate() is called.
function makeMockStrategy(
  name: "dom" | "a11y" | "vision",
  result: StrategyResult | (() => Promise<StrategyResult>)
): BaseStrategy {
  const locateFn =
    typeof result === "function"
      ? result
      : vi.fn().mockResolvedValue(result);

  return {
    name,
    locate: typeof result === "function" ? result : locateFn,
  } as unknown as BaseStrategy;
}

// Creates a mock strategy that throws when locate() is called.
function makeFaultyStrategy(name: "dom" | "a11y" | "vision", message: string): BaseStrategy {
  return {
    name,
    locate: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as BaseStrategy;
}

function makeContext(): LocatorContext {
  return {
    page: {} as never,
    timeout: 5000,
  };
}

const TARGET: LocatorTarget = { description: "the login button" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FallbackChain", () => {
  it("returns the first strategy's result when it succeeds", async () => {
    const domEl = makeLocatedElement("dom");
    const chain = new FallbackChain([
      makeMockStrategy("dom", domEl),
      makeMockStrategy("a11y", makeLocatedElement("a11y")),
    ]);

    const { element, attempts } = await chain.locate(TARGET, makeContext());

    expect(element).toBe(domEl);
    expect(attempts).toHaveLength(1); // only one strategy was tried
    expect(attempts[0]!.strategy).toBe("dom");
    expect(attempts[0]!.succeeded).toBe(true);
  });

  it("falls through to the second strategy when the first returns null", async () => {
    const a11yEl = makeLocatedElement("a11y");
    const chain = new FallbackChain([
      makeMockStrategy("dom", null),
      makeMockStrategy("a11y", a11yEl),
    ]);

    const { element, attempts } = await chain.locate(TARGET, makeContext());

    expect(element).toBe(a11yEl);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.succeeded).toBe(false);
    expect(attempts[1]!.succeeded).toBe(true);
  });

  it("falls through all strategies and throws ElementNotFoundError when all return null", async () => {
    const chain = new FallbackChain([
      makeMockStrategy("dom", null),
      makeMockStrategy("a11y", null),
      makeMockStrategy("vision", null),
    ]);

    await expect(chain.locate(TARGET, makeContext())).rejects.toThrow(ElementNotFoundError);
  });

  it("records all strategy attempts in the returned attempts array", async () => {
    const chain = new FallbackChain([
      makeMockStrategy("dom", null),
      makeMockStrategy("a11y", null),
      makeMockStrategy("vision", makeLocatedElement("vision")),
    ]);

    const { attempts } = await chain.locate(TARGET, makeContext());

    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.strategy)).toEqual(["dom", "a11y", "vision"]);
  });

  it("catches a thrown strategy error, records it, and continues to the next strategy", async () => {
    const a11yEl = makeLocatedElement("a11y");
    const chain = new FallbackChain([
      makeFaultyStrategy("dom", "Playwright crash"),
      makeMockStrategy("a11y", a11yEl),
    ]);

    const { element, attempts } = await chain.locate(TARGET, makeContext());

    // A11y should have won despite DOM throwing
    expect(element).toBe(a11yEl);
    expect(attempts[0]!.succeeded).toBe(false);
    expect(attempts[0]!.error).toBe("Playwright crash");
    expect(attempts[1]!.succeeded).toBe(true);
  });

  it("records resolved_selector and confidence on successful attempts", async () => {
    const domEl = makeLocatedElement("dom");
    const chain = new FallbackChain([makeMockStrategy("dom", domEl)]);

    const { attempts } = await chain.locate(TARGET, makeContext());

    expect(attempts[0]!.resolved_selector).toBe("#dom-element");
    expect(attempts[0]!.confidence).toBe(1.0);
  });

  it("records null resolved_selector and confidence on failed attempts", async () => {
    const chain = new FallbackChain([
      makeMockStrategy("dom", null),
      makeMockStrategy("a11y", makeLocatedElement("a11y")),
    ]);

    const { attempts } = await chain.locate(TARGET, makeContext());

    expect(attempts[0]!.resolved_selector).toBeNull();
    expect(attempts[0]!.confidence).toBeNull();
  });

  it("records duration_ms for each attempt", async () => {
    const chain = new FallbackChain([makeMockStrategy("dom", makeLocatedElement("dom"))]);

    const { attempts } = await chain.locate(TARGET, makeContext());

    expect(typeof attempts[0]!.duration_ms).toBe("number");
    expect(attempts[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns totalDurationMs for the full chain run", async () => {
    const chain = new FallbackChain([
      makeMockStrategy("dom", null),
      makeMockStrategy("a11y", makeLocatedElement("a11y")),
    ]);

    const { totalDurationMs } = await chain.locate(TARGET, makeContext());

    expect(typeof totalDurationMs).toBe("number");
    expect(totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("still throws ElementNotFoundError when all strategies throw errors", async () => {
    const chain = new FallbackChain([
      makeFaultyStrategy("dom", "DOM crash"),
      makeFaultyStrategy("a11y", "A11y crash"),
      makeFaultyStrategy("vision", "Vision crash"),
    ]);

    await expect(chain.locate(TARGET, makeContext())).rejects.toThrow(ElementNotFoundError);
  });

  it("records error messages from throwing strategies", async () => {
    const chain = new FallbackChain([
      makeFaultyStrategy("dom", "Network timeout"),
      makeMockStrategy("a11y", makeLocatedElement("a11y")),
    ]);

    const { attempts } = await chain.locate(TARGET, makeContext());
    expect(attempts[0]!.error).toBe("Network timeout");
  });
});
