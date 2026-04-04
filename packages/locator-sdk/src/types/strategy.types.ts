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
// LocatedElement
// ---------------------------------------------------------------------------
// The result returned when an element IS found. Contains:
//   - `handle`     : the live Playwright ElementHandle for direct interaction
//   - `strategy`   : which strategy succeeded (for logging + debugging)
//   - `confidence` : 0–1 certainty score. DOM matches are always 1.0.
//                    A11y matches reflect the Jaro-Winkler score (≥0.80).
//                    Vision matches come from Claude's confidence in its bbox.
//   - `selector`   : the resolved selector string — can be stored and replayed
//                    on the next run to skip the fallback chain entirely.
//   - `boundingBox`: present when the Vision strategy resolves the element, or
//                    when Playwright can measure the element's position.
// ---------------------------------------------------------------------------
export interface LocatedElement {
  handle: ElementHandle;
  strategy: "dom" | "a11y" | "vision";
  confidence: number;
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
