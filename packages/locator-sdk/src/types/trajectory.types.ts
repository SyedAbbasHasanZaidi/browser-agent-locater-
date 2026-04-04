// ---------------------------------------------------------------------------
// Trajectory Types
// ---------------------------------------------------------------------------
// These types define the shape of data logged after every locate() attempt.
// The format is designed to be HuggingFace datasets-compatible: each record
// is a self-contained JSON object that can be streamed as JSONL and loaded
// directly with `datasets.load_dataset("json", data_files="*.jsonl")`.
//
// Every TrajectoryRecord captures the FULL story of one locate() call:
//   - what was asked for
//   - every strategy that was tried and what it found
//   - which strategy ultimately won (or that all failed)
//   - timing data for ML feature engineering (strategy latency as a feature)
// ---------------------------------------------------------------------------

// One attempt by a single strategy
export interface StrategyAttempt {
  /** Which strategy ran */
  strategy: "dom" | "a11y" | "vision";
  /** Did this strategy return a non-null result? */
  succeeded: boolean;
  /** How long this strategy took in milliseconds */
  duration_ms: number;
  /** The resolved selector if succeeded, otherwise null */
  resolved_selector: string | null;
  /** Confidence score if succeeded, otherwise null */
  confidence: number | null;
  /** Error message if the strategy threw (not just returned null) */
  error?: string;
}

// The full record for one locate() call — this is what gets written to JSONL
export interface TrajectoryRecord {
  /** Unique identifier for a continuous agent session (UUID v4) */
  session_id: string;
  /** Monotonically increasing index within the session */
  step_index: number;
  /** ISO 8601 timestamp of when locate() was called */
  timestamp: string;
  /** The target that was searched for */
  target_description: string;
  /** The raw LocatorTarget object */
  target: Record<string, unknown>;
  /** URL of the page at the time of the locate() call */
  page_url: string;
  /** All strategy attempts in the order they ran */
  attempts: StrategyAttempt[];
  /** Which strategy won, or null if all failed */
  winner: "dom" | "a11y" | "vision" | null;
  /** The final resolved selector (same as the winning attempt's selector) */
  resolved_selector: string | null;
  /** Total wall-clock time for the entire locate() call */
  total_duration_ms: number;
}

// The request body sent from TypeScript → Python POST /trajectory
export interface TrajectoryLogRequest {
  session_id: string;
  step_index: number;
  task_description: string;
  step: {
    attempts: StrategyAttempt[];
    winner: "dom" | "a11y" | "vision" | null;
    resolved_selector: string | null;
    total_duration_ms: number;
    page_url: string;
    target: Record<string, unknown>;
  };
}

// The response from POST /trajectory
export interface TrajectoryLogResponse {
  ok: true;
  entry_id: string;
}
