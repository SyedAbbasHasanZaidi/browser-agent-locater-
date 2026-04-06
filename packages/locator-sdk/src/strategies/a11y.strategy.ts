import type {
  A11yNode,
  LocatedElement,
  LocatorContext,
  LocatorTarget,
  StrategyResult,
} from "../types/strategy.types.js";
import { BaseStrategy } from "./base.strategy.js";

// ---------------------------------------------------------------------------
// A11yStrategy — Priority 2 (~150ms)
// ---------------------------------------------------------------------------
//
// Finds elements by semantic meaning rather than DOM structure. Survives CSS
// class renames, DOM restructuring, and partial text changes that break the
// DOM strategy.
//
// Algorithm:
//   1. Collect all interactive elements from the page via DOM queries
//      (buttons, links, inputs, selects, and anything with aria-label or role)
//   2. For each element, extract its accessible name (aria-label, text content,
//      placeholder, or title)
//   3. Score each candidate against target.description using Jaro-Winkler
//      fuzzy string similarity
//   4. Pick the highest-scoring candidate above the 0.80 threshold
//   5. Return its ElementHandle
//
// Why not page.accessibility.snapshot()?
//   The accessibility snapshot API (page.accessibility) was removed in
//   Playwright v1.43. The replacement (page.ariaSnapshot) returns a YAML
//   string designed for assertions, not tree traversal. We collect candidates
//   directly from the DOM — which is more reliable and just as fast.
//
// Why Jaro-Winkler over Levenshtein?
//   Jaro-Winkler gives extra weight to matching prefixes, which makes it
//   better for UI labels where the important word comes first:
//   "Log In" vs "Sign In" → Jaro-Winkler 0.78 (below threshold, correct!)
//   "Submit Form" vs "Submit" → Jaro-Winkler 0.89 (above threshold, correct!)
//
// Why 0.80 as the threshold?
//   Below 0.80 the fuzzy match is too uncertain — it's better to let the
//   Vision strategy try than to click the wrong element with false confidence.
//
// Dependency Flow:
//   FallbackChain → A11yStrategy.locate() → BaseStrategy.withTimeout()
//                → _locate() → page.$$() (DOM query for interactive elements)
//                            → jaroWinkler()
//                            → ElementHandle
// ---------------------------------------------------------------------------

// Minimum Jaro-Winkler score to consider a node a valid match.
const CONFIDENCE_THRESHOLD = 0.80;

// CSS selector that targets all interactive / labelled elements.
// Covers buttons, links, inputs, selects, textareas, and anything explicitly
// labelled with aria-label or a non-presentation role.
const CANDIDATE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[aria-label]",
].join(", ");

export class A11yStrategy extends BaseStrategy {
  readonly name = "a11y" as const;

  protected async _locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<StrategyResult> {
    const { page } = context;

    // Always collect the a11y tree — even if we have no query to fuzzy-match.
    // Vision strategy needs this structural map for disambiguation, and it's
    // especially critical when DOM failed with a stale selector (no description
    // available to score against, but the a11y tree tells Claude what exists).
    const locator = page.locator(CANDIDATE_SELECTOR);
    const count = await locator.count();
    if (count === 0) {
      context.a11yTree = [];
      return null;
    }

    // Build a synthetic A11y node list from the live DOM elements.
    // For each element we extract its accessible name from (in priority order):
    //   aria-label attribute → innerText → placeholder → title
    // This mirrors how browsers compute accessible names for most elements.
    const nodes: A11yNode[] = [];
    // Maps nodes[j] → original DOM index i, so we can call locator.nth()
    // with the correct index even when empty-name elements are skipped.
    const domIndices: number[] = [];
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      const name = await el.evaluate((node: Element) => {
        return (
          node.getAttribute("aria-label") ||
          (node as HTMLElement).innerText?.trim() ||
          (node as HTMLInputElement).placeholder ||
          node.getAttribute("title") ||
          ""
        );
      });
      if (name) {
        // role is used for context.a11yTree hydration — approximate from tag/attr
        const role = await el.evaluate((node: Element) => {
          return (
            node.getAttribute("role") ||
            node.tagName.toLowerCase()
          );
        });
        // Collect bounding box for each candidate — forwarded to Vision strategy
        // so Claude can cross-reference visual position with known elements.
        const bbox = await el.boundingBox();
        nodes.push({
          role,
          name,
          boundingBox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : undefined,
        } as A11yNode);
        domIndices.push(i);
      }
    }

    // Hydrate the shared context — always, even if we can't score below.
    // Vision strategy reads this for disambiguation context.
    context.a11yTree = nodes;

    // Now check if we have a query to fuzzy-match. If not, we've done our job
    // (populating the a11y tree) but can't score candidates — return null.
    const query = target.description ?? target.ariaLabel ?? target.text;
    if (!query) {
      return null;
    }

    // Score every candidate against the query string.
    let bestIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const label = node?.name ?? "";
      if (!label) continue;

      const score = jaroWinkler(query.toLowerCase(), label.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    // Reject matches below the confidence threshold.
    // Report the near-miss so Vision strategy knows what A11y tried.
    const nearMiss = bestIndex >= 0 ? nodes[bestIndex] : undefined;
    if (bestScore < CONFIDENCE_THRESHOLD || bestIndex === -1) {
      context.failedAttempts ??= [];
      context.failedAttempts.push({
        strategy: "a11y",
        candidatesConsidered: nodes.length,
        bestCandidateName: nearMiss?.name ?? undefined,
        bestCandidateScore: bestScore > 0 ? bestScore : undefined,
        bestCandidateRole: nearMiss?.role,
      });
      return null;
    }

    const domIndex = domIndices[bestIndex];
    if (domIndex === undefined) {
      return null;
    }
    const bestLocator = locator.nth(domIndex);
    const handle = await bestLocator.elementHandle();
    if (handle === null) {
      return null;
    }

    const boundingBox = (await handle.boundingBox()) ?? undefined;

    // Build a human-readable selector for trajectory logging.
    const bestNode = nearMiss!;
    const safeName = (bestNode.name ?? "").replace(/"/g, '\\"');
    const selector = `a11y:${bestNode.role}[name="${safeName}"]`;

    const result: LocatedElement = {
      handle,
      strategy: "a11y",
      confidence: bestScore,
      selector,
      boundingBox,
    };

    return result;
  }
}

// ---------------------------------------------------------------------------
// jaroWinkler — Jaro-Winkler string similarity (0.0 to 1.0)
// ---------------------------------------------------------------------------
// Implementation follows the standard Jaro-Winkler algorithm:
//   1. Compute Jaro similarity
//   2. Apply Winkler prefix bonus (up to 4 chars matching prefix = bonus)
//
// Returns 1.0 for identical strings, 0.0 for completely different strings.
// ---------------------------------------------------------------------------
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;

  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Step 1: find matching characters within the match distance window
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Step 2: count transpositions (order swaps among matched characters)
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3;

  // Step 3: Winkler prefix bonus — reward strings that share a common prefix
  let prefixLength = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefixLength++;
    else break;
  }

  return jaro + prefixLength * 0.1 * (1 - jaro);
}
