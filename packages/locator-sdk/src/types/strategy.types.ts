import type { ElementHandle, Page } from "playwright";

// ---------------------------------------------------------------------------
// LocatorTarget
// ---------------------------------------------------------------------------
// Describes WHAT the caller wants to find. All fields are optional so the
// caller can provide as much or as little information as they have:
//   - Structured selectors (cssSelector, xpath, testId, ariaLabel, ariaRole)
//     feed the DOM strategy directly.
//   - `text` is used by the DOM strategy's :text() pseudo-selector.
//   - `description` is a natural-language hint used by both the A11y strategy
//     (fuzzy label matching) and the Vision strategy (sent to Claude as the
//     prompt describing the element to locate).
// ---------------------------------------------------------------------------
export interface LocatorTarget {
  /** Natural-language description: "the blue submit button", "search input" */
  description?: string;
  /** CSS selector, e.g. "#login-btn" or ".nav > a:first-child" */
  cssSelector?: string;
  /** XPath expression, e.g. "//button[text()='Submit']" */
  xpath?: string;
  /** Value of the data-testid attribute */
  testId?: string;
  /** aria-label attribute value */
  ariaLabel?: string;
  /** ARIA role, e.g. "button", "textbox", "link" */
  ariaRole?: string;
  /** Visible text content of the element */
  text?: string;
}

// ---------------------------------------------------------------------------
// BoundingBox
// ---------------------------------------------------------------------------
// Pixel coordinates of an element's bounding rectangle. Matches Playwright's
// own BoundingBox type but is re-declared here so the SDK's public types don't
// force consumers to import from Playwright directly.
// ---------------------------------------------------------------------------
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// LocateResult — Public return type from ElementLocator.locate()
// ---------------------------------------------------------------------------
// What consumers see. Contains only what they need to interact with the
// element and understand how it was found:
//   - `handle`     : live Playwright ElementHandle for click/fill/etc.
//   - `strategy`   : which strategy succeeded (diagnostics + trajectory)
//   - `confidence` : 0–1 certainty score (DOM=1.0, A11y≥0.80, Vision≥0.70)
// ---------------------------------------------------------------------------
export interface LocateResult {
  handle: ElementHandle;
  strategy: "dom" | "a11y" | "vision";
  confidence: number;
}

// ---------------------------------------------------------------------------
// LocatedElement — Internal type used by strategies, chain, and logger
// ---------------------------------------------------------------------------
// Extends LocateResult with metadata needed for trajectory logging and
// debugging. NOT exposed to consumers — they see LocateResult instead.
//   - `selector`   : human-readable string describing how the element was
//                    found. Only DOM selectors are replayable; A11y and Vision
//                    selectors are for logging only.
//   - `boundingBox`: pixel position, used by trajectory logger and Vision
//                    post-processing to cross-reference with a11y nodes.
// ---------------------------------------------------------------------------
export interface LocatedElement extends LocateResult {
  selector: string;
  boundingBox?: BoundingBox;
}

// ---------------------------------------------------------------------------
// LocatorContext
// ---------------------------------------------------------------------------
// Runtime context passed to every strategy on each locate() call. Holds:
//   - `page`              : the live Playwright Page object
//   - `screenshotBase64`  : lazily populated — only captured if the Vision
//                           strategy runs (avoids expensive full-page screenshot
//                           when DOM or A11y succeeds first)
//   - `a11yTree`          : lazily populated — only extracted if the A11y
//                           strategy runs (page.accessibility.snapshot() is
//                           non-trivial on large DOMs)
//   - `timeout`           : per-locate timeout in ms (default: 5000)
// ---------------------------------------------------------------------------
export interface LocatorContext {
  page: Page;
  screenshotBase64?: string;
  a11yTree?: A11yNode[];
  timeout?: number;
  /** Metadata from strategies that tried and failed — forwarded to Vision */
  failedAttempts?: FailedAttemptInfo[];
}

// ---------------------------------------------------------------------------
// A11yNode
// ---------------------------------------------------------------------------
// Represents an interactive element collected by the A11y strategy.
// Originally from page.accessibility.snapshot() (removed in Playwright v1.43+),
// now built from DOM queries (page.locator + el.evaluate).
//
// The optional boundingBox field is populated when the A11y strategy collects
// element positions — this data is forwarded to the Vision strategy so Claude
// can cross-reference its visual identification with known interactive elements.
// ---------------------------------------------------------------------------
export interface A11yNode {
  role: string;
  name?: string;
  description?: string;
  value?: string | number;
  checked?: boolean;
  children?: A11yNode[];
  boundingBox?: BoundingBox;
}

// ---------------------------------------------------------------------------
// FailedAttemptInfo
// ---------------------------------------------------------------------------
// Metadata about a strategy that tried and failed to find the target element.
// Populated by the FallbackChain and individual strategies (e.g. A11y reports
// its best near-miss). Forwarded to the Vision strategy so Claude can see
// what was already tried and why it failed — avoiding redundant reasoning.
// ---------------------------------------------------------------------------
export interface FailedAttemptInfo {
  strategy: "dom" | "a11y";
  error?: string;
  candidatesConsidered?: number;
  bestCandidateName?: string;
  bestCandidateScore?: number;
  /** Role of the best near-miss candidate (e.g. "button", "link") — inferred by A11y */
  bestCandidateRole?: string;
  /** CSS selectors / locator strings that DOM strategy tried and got 0 matches */
  selectorsTried?: string[];
}

// ---------------------------------------------------------------------------
// StrategyResult
// ---------------------------------------------------------------------------
// What a strategy's locate() method returns:
//   - `null`           : element not found — move to the next strategy
//   - `LocatedElement` : element found — stop the chain, return to caller
//
// Throwing an Error means something went wrong (network, Playwright crash).
// The FallbackChain catches that, logs it, and advances to the next strategy.
// ---------------------------------------------------------------------------
export type StrategyResult = LocatedElement | null;

// ---------------------------------------------------------------------------
// ElementNotFoundError
// ---------------------------------------------------------------------------
// Thrown by FallbackChain only after ALL strategies return null. Carries the
// original target so the caller can log it or use it for retry logic.
// ---------------------------------------------------------------------------
export class ElementNotFoundError extends Error {
  constructor(public readonly target: LocatorTarget) {
    super(
      `Element not found after exhausting all strategies. Target: ${JSON.stringify(target)}`
    );
    this.name = "ElementNotFoundError";
  }
}
