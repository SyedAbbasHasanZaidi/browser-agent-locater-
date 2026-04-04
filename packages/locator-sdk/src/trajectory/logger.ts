import type { LocatorTarget } from "../types/strategy.types.js";
import type {
  StrategyAttempt,
  TrajectoryLogRequest,
} from "../types/trajectory.types.js";

// ---------------------------------------------------------------------------
// TrajectoryLogger — fire-and-forget POST to the Python trajectory endpoint
// ---------------------------------------------------------------------------
//
// Design: Non-blocking async logging
// ------------------------------------
// The caller does NOT await trajectory logging. It fires the POST and moves
// on. If the logging request fails, it is silently dropped. Rationale:
//   - The user's agent should not slow down because of observability tooling
//   - Lost trajectory entries are acceptable (this is ML training data, not
//     a billing or audit system)
//   - `void logger.log(...)` makes the fire-and-forget intent explicit in
//     the calling code
//
// Session Management:
// -------------------
// Each TrajectoryLogger instance owns one session_id. A "session" maps to
// one continuous agent run (e.g. one test suite execution, one scraping job).
// All locate() calls within the session share the same JSONL file on the
// Python side, making it easy to reconstruct the full agent trajectory.
//
// Data Flow:
//   ElementLocator.locate()
//     → FallbackChain.locate() returns LocateCallResult
//     → void TrajectoryLogger.log(result) ← not awaited
//         → fetch POST /trajectory
//             → Python appends to {session_id}.jsonl
// ---------------------------------------------------------------------------

export class TrajectoryLogger {
  private readonly sessionId: string;
  private stepIndex: number = 0;
  private readonly trajectoryUrl: string;

  constructor(
    sessionId: string,
    visionServiceUrl: string = "http://localhost:8765"
  ) {
    this.sessionId = sessionId;
    this.trajectoryUrl = `${visionServiceUrl.replace(/\/$/, "")}/trajectory`;
  }

  // ---------------------------------------------------------------------------
  // log() — fire-and-forget trajectory record
  // ---------------------------------------------------------------------------
  // MUST be called as `void logger.log(...)` — never await this.
  // Returns a Promise so the caller can optionally await in tests, but in
  // production the return value is discarded.
  // ---------------------------------------------------------------------------
  async log(params: {
    target: LocatorTarget;
    pageUrl: string;
    attempts: StrategyAttempt[];
    winner: "dom" | "a11y" | "vision" | null;
    resolvedSelector: string | null;
    totalDurationMs: number;
  }): Promise<void> {
    const stepIndex = this.stepIndex++;

    const body: TrajectoryLogRequest = {
      session_id: this.sessionId,
      step_index: stepIndex,
      task_description: params.target.description ?? params.target.text ?? "locate element",
      step: {
        attempts: params.attempts,
        winner: params.winner,
        resolved_selector: params.resolvedSelector,
        total_duration_ms: params.totalDurationMs,
        page_url: params.pageUrl,
        target: params.target as Record<string, unknown>,
      },
    };

    try {
      await fetch(this.trajectoryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Silently drop logging failures — never let observability break the agent
    }
  }
}
