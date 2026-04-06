import type { Locator } from "playwright";
import type {
  LocatedElement,
  LocatorContext,
  LocatorTarget,
  StrategyResult,
} from "../types/strategy.types.js";
import { BaseStrategy } from "./base.strategy.js";

// ---------------------------------------------------------------------------
// DomStrategy — Priority 1 (~50ms)
// ---------------------------------------------------------------------------
//
// The fastest strategy. Uses Playwright's built-in locator API to find
// elements by CSS selector, XPath, data-testid, aria-label, or visible text.
//
// Control Flow (waterfall — stops on first match):
//   cssSelector → xpath → testId → ariaLabel → ariaRole+text → text
//
// Why a waterfall and not parallel?
//   Playwright's locator() calls are cheap (no network). Running them in
//   sequence and stopping on the first match avoids ambiguous results when
//   multiple techniques could match different elements. The caller's most
//   specific hint (e.g. a testId) wins over vaguer hints (e.g. text content).
//
// Confidence is always 1.0 on a DOM match — if Playwright found it via an
// exact selector, there is no uncertainty.
//
// Returns null when all techniques return 0 matching elements.
// Never throws for "element not found" — only throws if Playwright itself
// crashes (which BaseStrategy.withTimeout handles via the null fallback).
// ---------------------------------------------------------------------------

export class DomStrategy extends BaseStrategy {
  readonly name = "dom" as const;

  protected async _locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<StrategyResult> {
    const { page } = context;

    // Build a list of (selector-string, locator) pairs to try in priority order.
    // Only include entries where the target actually provided that hint.
    const candidates: Array<{ selector: string; locator: Locator }> = [];

    if (target.cssSelector) {
      candidates.push({
        selector: target.cssSelector,
        locator: page.locator(target.cssSelector),
      });
    }

    if (target.xpath) {
      candidates.push({
        selector: `xpath=${target.xpath}`,
        locator: page.locator(`xpath=${target.xpath}`),
      });
    }

    if (target.testId) {
      candidates.push({
        selector: `[data-testid="${target.testId}"]`,
        locator: page.locator(`[data-testid="${target.testId}"]`),
      });
    }

    if (target.ariaLabel) {
      candidates.push({
        selector: `[aria-label="${target.ariaLabel}"]`,
        locator: page.locator(`[aria-label="${target.ariaLabel}"]`),
      });
    }

    // aria role + visible text combined — more precise than either alone.
    // e.g. role=button >> text="Submit" avoids matching non-button "Submit" text.
    if (target.ariaRole && target.text) {
      const sel = `role=${target.ariaRole} >> text="${target.text}"`;
      candidates.push({ selector: sel, locator: page.locator(sel) });
    } else if (target.ariaRole) {
      const sel = `role=${target.ariaRole}`;
      candidates.push({ selector: sel, locator: page.locator(sel) });
    }

    // Plain visible text match — least specific, so it goes last.
    // Playwright's :text() pseudo-selector does substring matching.
    if (target.text) {
      const sel = `text="${target.text}"`;
      candidates.push({ selector: sel, locator: page.locator(sel) });
    }

    // Walk the waterfall — return on the first technique that finds ≥1 element
    for (const { selector, locator } of candidates) {
      const count = await locator.count();
      if (count > 0) {
        // If multiple elements match, take the first visible one.
        // Playwright's .first() returns a new Locator; .elementHandle() resolves
        // it to a live DOM ElementHandle that the caller can click/type on.
        const best = count === 1 ? locator : locator.first();
        const handle = await best.elementHandle();

        if (handle === null) {
          // elementHandle() can return null if the element disappears between
          // count() and elementHandle() (race condition on dynamic pages).
          // Treat as not found by this technique and continue the waterfall.
          continue;
        }

        const boundingBox = (await handle.boundingBox()) ?? undefined;

        const result: LocatedElement = {
          handle,
          strategy: "dom",
          confidence: 1.0,
          selector,
          boundingBox,
        };

        return result;
      }
    }

    // All techniques exhausted — report what was tried so Vision gets context.
    if (candidates.length > 0) {
      context.failedAttempts ??= [];
      context.failedAttempts.push({
        strategy: "dom",
        candidatesConsidered: candidates.length,
        selectorsTried: candidates.map((c) => c.selector),
      });
    }

    return null;
  }
}
