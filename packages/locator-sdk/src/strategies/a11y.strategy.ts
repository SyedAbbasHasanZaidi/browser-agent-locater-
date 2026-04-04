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
// Uses Playwright's accessibility tree snapshot to find elements by semantic
// meaning rather than DOM structure. Survives CSS class renames, DOM
// restructuring, and partial text changes that break the DOM strategy.
//
// Algorithm:
//   1. Call page.accessibility.snapshot() → full semantic tree
//   2. BFS the tree, collecting all leaf/interactive nodes
//   3. Score each node against target.description using Jaro-Winkler
//      fuzzy string similarity
//   4. Pick the highest-scoring node above the 0.80 threshold
//   5. Map the winning a11y node back to a live DOM element via
//      page.locator(`role=${role} >> name="${name}"`)
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
//                → _locate() → page.accessibility.snapshot()
//                            → bfsNodes()
//                            → jaroWinkler()
//                            → page.locator().elementHandle()
// ---------------------------------------------------------------------------

// Minimum Jaro-Winkler score to consider a node a valid match.
const CONFIDENCE_THRESHOLD = 0.80;

export class A11yStrategy extends BaseStrategy {
  readonly name = "a11y" as const;

  protected async _locate(
    target: LocatorTarget,
    context: LocatorContext
  ): Promise<StrategyResult> {
    const { page } = context;

    // Only run if we have something to fuzzy-match against.
    // description is the primary signal; fall back to ariaLabel or text.
    const query = target.description ?? target.ariaLabel ?? target.text;
    if (!query) {
      return null;
    }

    // Capture the accessibility tree. Playwright returns null for pages with
    // no accessible content (e.g. a blank page during load).
    const snapshot = await page.accessibility.snapshot();
    if (!snapshot) {
      return null;
    }

    // Hydrate the shared context so FallbackChain can log it later.
    // Cast Playwright's untyped snapshot to our A11yNode interface.
    context.a11yTree = [snapshot as unknown as A11yNode];

    // BFS to collect all nodes that have a name (accessible label).
    // Unnamed nodes (pure layout divs, etc.) cannot be matched or located.
    const nodes = bfsNodes(context.a11yTree);

    // Score every named node against the query string.
    let bestNode: A11yNode | null = null;
    let bestScore = 0;

    for (const node of nodes) {
      const label = node.name ?? node.description ?? "";
      if (!label) continue;

      const score = jaroWinkler(query.toLowerCase(), label.toLowerCase());

      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    // Reject matches below the confidence threshold.
    if (bestScore < CONFIDENCE_THRESHOLD || bestNode === null) {
      return null;
    }

    // Map the winning a11y node back to a live Playwright Locator.
    // Playwright's role + name filter is the most reliable way to go from
    // an a11y tree node to a DOM element — it uses the browser's own
    // accessibility API to find the element.
    const role = bestNode.role;
    const name = bestNode.name ?? "";

    // Escape quotes in the name to prevent selector injection.
    const safeName = name.replace(/"/g, '\\"');
    const selector = `role=${role} >> name="${safeName}"`;
    const locator = page.locator(selector);

    const count = await locator.count();
    if (count === 0) {
      // The a11y node exists in the tree but Playwright can't locate it —
      // this can happen with custom ARIA roles or shadowed components.
      return null;
    }

    const handle = await (count === 1 ? locator : locator.first()).elementHandle();
    if (handle === null) {
      return null;
    }

    const boundingBox = (await handle.boundingBox()) ?? undefined;

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
// bfsNodes — BFS traversal of the A11y tree
// ---------------------------------------------------------------------------
// Returns all nodes in breadth-first order. BFS means we find the most
// prominent/top-level matching element first (e.g. a nav button before a
// nested span inside it), which is almost always the right element to click.
// ---------------------------------------------------------------------------
function bfsNodes(roots: A11yNode[]): A11yNode[] {
  const result: A11yNode[] = [];
  const queue: A11yNode[] = [...roots];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    if (node.children) {
      queue.push(...node.children);
    }
  }

  return result;
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
