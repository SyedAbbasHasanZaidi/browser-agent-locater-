// ---------------------------------------------------------------------------
// Public API barrel — everything a consumer needs is re-exported from here
// ---------------------------------------------------------------------------
// Consumers import from "locator-sdk", not from deep internal paths:
//   import { ElementLocator, ElementNotFoundError } from "locator-sdk"
//
// Only types and classes that are part of the public contract are exported.
// Internal helpers (jaroWinkler, bfsNodes, assertVisionLocateResponse, etc.)
// stay private to their files and are not accessible to consumers.
// ---------------------------------------------------------------------------

// Primary class — the only thing most callers ever need
export { ElementLocator } from "./locator.js";
export type { ElementLocatorOptions } from "./locator.js";

// Domain types — needed by callers to type their own variables
export type {
  LocatorTarget,
  LocatedElement,
  LocatorContext,
  BoundingBox,
  A11yNode,
  StrategyResult,
} from "./types/strategy.types.js";

// Error class — callers catch this to handle "element not found"
export { ElementNotFoundError } from "./types/strategy.types.js";

// Trajectory types — needed by callers who want to inspect logged data
export type {
  TrajectoryRecord,
  TrajectoryLogRequest,
  StrategyAttempt,
} from "./types/trajectory.types.js";

// Advanced: individual strategies, for callers who want to build
// a custom chain with a subset of strategies or a custom order
export { DomStrategy } from "./strategies/dom.strategy.js";
export { A11yStrategy } from "./strategies/a11y.strategy.js";
export { VisionStrategy } from "./strategies/vision.strategy.js";
export { FallbackChain } from "./fallback/chain.js";
export { VisionClient, VisionServiceError } from "./transport/vision-client.js";
export { TrajectoryLogger } from "./trajectory/logger.js";
