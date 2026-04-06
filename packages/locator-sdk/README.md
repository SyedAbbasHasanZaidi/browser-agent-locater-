# agent-element-locator

Multi-strategy browser element locator for AI agent automation. Finds elements using a three-tier fallback chain: **DOM** (5ms) → **A11y** (150ms) → **Vision** (2500ms).

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [User Guide](#user-guide)
  - [How the Fallback Chain Works](#how-the-fallback-chain-works)
  - [Providing Targets](#providing-targets)
  - [Configuration Options](#configuration-options)
  - [Setting Up the Vision Strategy](#setting-up-the-vision-strategy)
  - [Convenience Methods](#convenience-methods)
  - [Custom Chains](#custom-chains)
  - [Trajectory Logging](#trajectory-logging)
  - [Error Handling](#error-handling)
- [API Reference](#api-reference)
- [Help / Troubleshooting](#help--troubleshooting)
- [Requirements](#requirements)
- [License](#license)

## Install

```bash
npm install agent-element-locator playwright
```

## Quick Start

```typescript
import { ElementLocator } from "agent-element-locator";
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://example.com");

// Create a locator instance — wires up all three strategies automatically
const locator = ElementLocator.create({
  page,
  sessionId: "my-session-001",
});

// Find by description — tries DOM selectors, then fuzzy A11y matching,
// then falls back to Claude vision if needed
const result = await locator.locate({
  description: "the login button",
});

await result.handle.click();
await browser.close();
```

That's it. The SDK tries the fastest strategy first and only escalates when needed.

---

## User Guide

### How the Fallback Chain Works

Every `locate()` call runs through up to three strategies in order. The chain stops at the first strategy that finds the element above its confidence threshold.

```
locate({ description: "Submit" })
        |
        v
+-------------------+     +-------------------+     +-------------------+
| 1. DomStrategy    |     | 2. A11yStrategy   |     | 3. VisionStrategy |
|    ~5ms           |     |    ~150ms          |     |    ~2500ms        |
|                   |     |                   |     |                   |
| Tries in order:   |     | Collects all      |     | Takes full-page   |
|  - cssSelector    |     | interactive       |     | screenshot, sends |
|  - xpath          |     | elements, scores  |     | to Claude with    |
|  - testId         |     | each against your |     | your description. |
|  - ariaLabel      |     | description using |     | Claude returns a  |
|  - ariaRole+text  |     | Jaro-Winkler      |     | bounding box,     |
|  - text           |     | fuzzy matching.   |     | resolved back to  |
|                   |     |                   |     | a DOM element via |
| Confidence: 1.0   |     | Threshold: 0.80   |     | elementFromPoint. |
| (exact match)     |     |                   |     | Threshold: 0.70   |
+-------------------+     +-------------------+     +-------------------+
        |                         |                         |
        +-- null? continue -------+-- null? continue -------+-- null? throw
                                                               ElementNotFoundError
```

**Why this order?**

- **DOM** is nearly instant and exact — if you have a CSS selector or test ID, it finds the element in milliseconds with 100% confidence.
- **A11y** survives CSS class renames and DOM restructuring because it matches on semantic labels (aria-label, visible text), not structure. Costs ~150ms.
- **Vision** is the last resort. It captures a screenshot, sends it to Claude (or GPT-4V), and asks the model to find the element visually. Slower and costs money, but works when everything else fails — including post-deploy DOM restructures, dynamically loaded elements, and pages with no accessible labels.

### Providing Targets

A target describes **what** you want to find. All fields are optional — provide as many or as few as you have. More hints = faster and more accurate results.

```typescript
interface LocatorTarget {
  // Structural selectors (DOM strategy — fastest)
  cssSelector?: string;   // "#login-btn", ".nav > a:first-child"
  xpath?: string;         // "//button[@type='submit']"
  testId?: string;        // Value of data-testid attribute

  // Semantic hints (A11y strategy — resilient to DOM changes)
  ariaLabel?: string;     // aria-label attribute value
  ariaRole?: string;      // "button", "textbox", "link"
  text?: string;          // Visible text content

  // Natural language (A11y fuzzy match + Vision strategy)
  description?: string;   // "the blue submit button in the header"
}
```

**Examples by use case:**

```typescript
// You have a stable test ID (best case — instant)
await locator.locate({ testId: "checkout-button" });

// You know the visible text
await locator.locate({ text: "Sign Up", ariaRole: "button" });

// You have a CSS selector that might go stale
await locator.locate({
  cssSelector: "#old-selector",
  description: "the main search input",  // fallback for A11y/Vision
});

// You only have a natural-language description (slowest but most resilient)
await locator.locate({
  description: "the plus button to increase the number of adult guests",
});
```

**Tip:** Always include a `description` alongside structural selectors. If the selector goes stale after a deploy, the A11y and Vision strategies can still find the element using the description as a fallback.

### Configuration Options

```typescript
const locator = ElementLocator.create({
  // Required
  page: playwrightPage,          // The Playwright Page to operate on
  sessionId: "uuid-v4-here",     // Groups trajectory logs for this session

  // Optional — sensible defaults for all of these
  timeout: 5000,                 // Per-locate timeout in ms (default: 5000)
  visionServiceUrl: "https://...", // Override vision service URL
  anthropicApiKey: "sk-ant-...",   // Override Anthropic API key
  logTrajectories: true,           // Enable/disable trajectory logging
});
```

**Environment variable resolution (no code needed):**

| Setting | Env Variable | Default |
|---|---|---|
| Vision service URL | `VISION_SERVICE_URL` | Hosted service on Railway |
| Anthropic API key | `ANTHROPIC_API_KEY` | None (Vision strategy disabled) |

The recommended setup: set `ANTHROPIC_API_KEY` in your environment and let the SDK read it automatically. No need to pass it in code.

### Setting Up the Vision Strategy

The Vision strategy is optional. Without an API key, the SDK uses DOM and A11y only (which handle most cases). To enable Vision:

**Step 1: Set your Anthropic API key**

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
```

**Step 2: Create the locator (key is read automatically)**

```typescript
const locator = ElementLocator.create({
  page,
  sessionId: "my-session",
});
// Vision strategy is now active as the third fallback
```

**How BYOK (Bring Your Own Key) works:**

Your API key is forwarded to the vision service via the `X-Anthropic-Key` HTTP header. The vision service uses your key for the Claude API call and does not store it. The key never touches disk on the service side.

**Self-hosting the vision service:**

The vision service is a Python FastAPI application in `services/vision-service/`. To self-host:

```bash
cd services/vision-service
pip install -r requirements.txt
uvicorn vision_service.main:app --host 0.0.0.0 --port 8765
```

Then point the SDK at it:

```typescript
const locator = ElementLocator.create({
  page,
  sessionId: "my-session",
  visionServiceUrl: "http://localhost:8765",
});
```

### Convenience Methods

The SDK provides shorthand methods for common actions:

```typescript
// locate() — find the element, get back a handle
const result = await locator.locate({ description: "the search button" });
console.log(result.strategy);    // "dom", "a11y", or "vision"
console.log(result.confidence);  // 0.0 to 1.0
await result.handle.click();

// click() — locate + click in one call
await locator.click({ description: "the search button" });

// fill() — locate + type into an input
await locator.fill({ description: "the email input" }, "user@example.com");
```

### Custom Chains

For advanced use cases, build your own strategy chain:

```typescript
import {
  FallbackChain,
  DomStrategy,
  A11yStrategy,
  VisionStrategy,
  VisionClient,
} from "agent-element-locator";

// DOM + A11y only (no Vision cost, no API key needed)
const cheapChain = new FallbackChain([
  new DomStrategy(),
  new A11yStrategy(),
]);

// Vision-only (for canvas UIs, cross-origin iframes, PDF viewers)
const client = new VisionClient("https://your-service.com", "sk-ant-...");
const visionOnly = new FallbackChain([new VisionStrategy(client)]);

// Skip A11y, go straight from DOM to Vision
const domThenVision = new FallbackChain([
  new DomStrategy(),
  new VisionStrategy(client),
]);

// Use a custom chain directly
const { element } = await cheapChain.locate(
  { description: "the login button" },
  { page, timeout: 5000 }
);
```

**When to use Vision-only:**

- **Canvas-rendered UIs** (Figma, Google Sheets cells) — no DOM nodes exist
- **Cross-origin iframes** — Playwright can't query inside them
- **PDF viewers** — clickable regions have no DOM representation
- **External screenshots** — no live Playwright page available

### Trajectory Logging

Every `locate()` call logs a trajectory record (JSONL format) to the vision service. This captures what each strategy tried, how long it took, and which one succeeded — useful for debugging and analyzing agent runs.

```typescript
// Enabled by default. Disable for unit tests:
const locator = ElementLocator.create({
  page,
  sessionId: "test-session",
  logTrajectories: false,
});
```

Trajectory records include:

- Target description and page URL
- Each strategy attempted, duration, and outcome
- The winning strategy, selector used, and confidence score
- Timestamps for the full locate() call

### Error Handling

```typescript
import {
  ElementLocator,
  ElementNotFoundError,
  VisionServiceError,
} from "agent-element-locator";

try {
  const result = await locator.locate({ description: "nonexistent button" });
} catch (error) {
  if (error instanceof ElementNotFoundError) {
    // All three strategies failed to find the element.
    // error.target contains the original LocatorTarget for debugging.
    console.log("Not found:", error.target);
  }

  if (error instanceof VisionServiceError) {
    // Vision service is unreachable or returned an error.
    // DOM and A11y strategies are unaffected.
    console.log("Vision service issue:", error.message);
    console.log("Cause:", error.cause);
  }
}
```

**Common error scenarios:**

| Error | Cause | Fix |
|---|---|---|
| `ElementNotFoundError` | No strategy found the element | Check your target description. Is the element visible on the page? Try adding more hints (testId, ariaLabel). |
| `VisionServiceError: Cannot reach vision service` | Vision service is down or URL is wrong | Check `VISION_SERVICE_URL`. The SDK still works without Vision — DOM and A11y strategies handle most cases. |
| `VisionServiceError: 503` | Vision provider (Claude) is unavailable | Transient issue. Retry or rely on DOM/A11y strategies. |
| Timeout | Strategy took longer than the configured timeout | Increase `timeout` in options. Vision strategy needs 5-10s on cold starts. |

---

## API Reference

### `ElementLocator.create(options): ElementLocator`

Factory method. Creates a fully wired locator with all three strategies.

### `locator.locate(target): Promise<LocateResult>`

Find an element on the page. Returns `{ handle, strategy, confidence }`. Throws `ElementNotFoundError` if all strategies fail.

### `locator.click(target): Promise<LocateResult>`

Locate + click in one call. Returns the same result as `locate()`.

### `locator.fill(target, value): Promise<LocateResult>`

Locate + fill a text input. Returns the same result as `locate()`.

### `FallbackChain`

```typescript
const chain = new FallbackChain([strategy1, strategy2, ...]);
const { element, attempts, totalDurationMs } = await chain.locate(target, context);
```

Low-level chain for custom strategy combinations.

### `VisionClient`

```typescript
const client = new VisionClient(baseUrl, anthropicApiKey?);
const isUp = await client.healthCheck();
const response = await client.locate(request);
```

HTTP adapter to the Python vision service.

### Types

```typescript
// What you pass in
interface LocatorTarget {
  description?: string;
  cssSelector?: string;
  xpath?: string;
  testId?: string;
  ariaLabel?: string;
  ariaRole?: string;
  text?: string;
}

// What you get back
interface LocateResult {
  handle: ElementHandle;
  strategy: "dom" | "a11y" | "vision";
  confidence: number;
}

// Errors
class ElementNotFoundError extends Error {
  target: LocatorTarget;
}

class VisionServiceError extends Error {
  cause?: unknown;
}
```

---

## Help / Troubleshooting

### "Element not found" but I can see it on the page

1. **Check your description.** Be specific about location: "the blue Submit button in the header" beats "submit button."
2. **Add structural hints.** If you have a `data-testid` or `aria-label`, include them — DOM strategy is instant and exact.
3. **Increase timeout.** Vision strategy needs 2-5 seconds. Set `timeout: 10000` or higher.
4. **Check element visibility.** Is the element inside an iframe, behind a modal, or below the fold? `fullPage: true` screenshots capture below-the-fold content, but modals and iframes can block `elementFromPoint()`.

### Vision strategy returns low confidence / wrong element

1. **Be spatially specific** in your description: "the plus button in the Adults row" not "the plus button."
2. **Provide role hints:** `ariaRole: "button"` tells Claude what type of element to look for.
3. **Check for duplicates:** If there are multiple similar elements (e.g., several "+" buttons), mention the nearby label or section in your description.

### Vision service not reachable

1. **Check the URL:** Verify `VISION_SERVICE_URL` is correct. Default is the hosted Railway instance.
2. **Check API key:** Set `ANTHROPIC_API_KEY` in your environment. Without it, Vision strategy is effectively disabled (the service has no key to call Claude with).
3. **Test the health endpoint:**
   ```bash
   curl https://locator-sdk-production.up.railway.app/health
   ```
4. **The SDK still works without Vision.** DOM and A11y strategies handle the majority of cases. Vision is only needed for ambiguous or structurally changed pages.

### Performance tips

| Scenario | Recommendation |
|---|---|
| You have stable test IDs | Use `testId` — DOM strategy finds it in ~5ms |
| Test IDs might go stale | Add `description` as a fallback for A11y/Vision |
| Speed matters, accuracy is fine | Use a DOM+A11y-only chain (skip Vision) |
| Canvas or iframe targets | Use a Vision-only chain |
| Running in CI | Set `timeout: 15000` to handle cold starts |

### Getting help

- **Issues:** [github.com/SyedAbbasHasanZaidi/browser-agent-locater-/issues](https://github.com/SyedAbbasHasanZaidi/browser-agent-locater-/issues)
- **Source:** [github.com/SyedAbbasHasanZaidi/browser-agent-locater-](https://github.com/SyedAbbasHasanZaidi/browser-agent-locater-)

---

## Requirements

- Node.js >= 18
- Playwright >= 1.44
- (Optional) Anthropic API key for Vision strategy

## License

MIT
