import type {
  VisionLocateResponse,
} from "../types/vision-api.types.js";

// ---------------------------------------------------------------------------
// VisionClient — HTTP Adapter to the Python FastAPI vision service
// ---------------------------------------------------------------------------
//
// Design Pattern: Adapter
// ------------------------
// The Python service speaks HTTP/JSON. The TypeScript VisionStrategy wants to
// call a typed async function. VisionClient adapts between the two:
//   VisionStrategy calls → client.locate(screenshot, description, pageUrl)
//   Client sends         → POST http://localhost:8765/locate { ... }
//   Python responds      → { found, bounding_box, confidence, reasoning, latency_ms }
//   Client returns       → typed VisionLocateResponse
//
// VisionStrategy never touches fetch() or JSON.parse() — it only sees the
// typed interface. If the transport layer changes (REST → gRPC, HTTP → IPC),
// only this file changes.
//
// Why fetch() over axios/got?
//   Node 18+ ships fetch() natively. Zero dependencies for HTTP is a strong
//   preference for an SDK that will be consumed by other projects.
// ---------------------------------------------------------------------------

// A11y node info sent as disambiguation context for the Vision provider.
export interface VisionA11yNodeInfo {
  role: string;
  name?: string;
  description?: string;
  bounding_box?: { x: number; y: number; width: number; height: number };
}

// What a previous strategy tried and why it failed.
export interface VisionFailedAttempt {
  strategy: "dom" | "a11y";
  error?: string;
  candidates_considered?: number;
  best_candidate_name?: string;
  best_candidate_score?: number;
  best_candidate_role?: string;
  selectors_tried?: string[];
}

export interface VisionLocateRequest {
  screenshot_base64: string;
  description: string;
  page_url: string;
  provider?: "claude" | "openai";
  max_candidates?: number;
  // Disambiguation context (all optional, backward compatible)
  a11y_tree?: VisionA11yNodeInfo[];
  failed_attempts?: VisionFailedAttempt[];
  viewport?: { width: number; height: number };
  target_role_hint?: string;
}

export class VisionClient {
  private readonly baseUrl: string;
  private readonly anthropicApiKey: string | undefined;

  /**
   * @param baseUrl        URL of the Python vision service (default: http://localhost:8765)
   * @param anthropicApiKey  BYOK — forwarded as X-Anthropic-Key header so the Python service
   *                         constructs a per-request ClaudeProvider with the caller's key.
   *                         When omitted, the service uses whichever key it was started with.
   */
  constructor(baseUrl: string = "http://localhost:8765", anthropicApiKey?: string) {
    // Strip trailing slash so URL construction is predictable
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.anthropicApiKey = anthropicApiKey;

    // Security guard: if a real API key is being used, the connection must be
    // HTTPS. An http:// URL means the key travels in plaintext over the network.
    // localhost/127.0.0.1 are exempt — local dev traffic never leaves the machine.
    if (anthropicApiKey && this.isInsecureRemote(this.baseUrl)) {
      console.warn(
        "[locator-sdk] WARNING: anthropicApiKey is set but visionServiceUrl uses http:// " +
        "on a non-localhost host. Your Anthropic API key will be sent in plaintext. " +
        "Use https:// in production."
      );
    }
  }

  private isInsecureRemote(url: string): boolean {
    if (!url.startsWith("http://")) return false;
    // Allow localhost and loopback addresses — they never leave the machine
    return !url.includes("localhost") && !url.includes("127.0.0.1");
  }

  // ---------------------------------------------------------------------------
  // locate() — POST /locate
  // ---------------------------------------------------------------------------
  // Sends a screenshot + description to the Python service and returns the
  // bounding box of the element found by Claude/GPT-4V.
  //
  // Throws VisionServiceError on:
  //   - Network failure (service not running)
  //   - Non-2xx HTTP status (503 = provider unavailable)
  //   - Malformed JSON response
  //
  // Returns VisionLocateResponse on success (found may be false).
  // ---------------------------------------------------------------------------
  async locate(req: VisionLocateRequest): Promise<VisionLocateResponse> {
    const url = `${this.baseUrl}/locate`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.anthropicApiKey) {
      headers["X-Anthropic-Key"] = this.anthropicApiKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      });
    } catch (cause) {
      throw new VisionServiceError(
        `Cannot reach vision service at ${url}. Is it running?`,
        cause
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      throw new VisionServiceError(
        `Vision service responded with ${response.status}: ${body}`
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      throw new VisionServiceError("Vision service returned invalid JSON", cause);
    }

    // Runtime shape validation — we trust the Python service's Pydantic
    // models but defend against version skew or misconfiguration.
    return assertVisionLocateResponse(data);
  }

  // ---------------------------------------------------------------------------
  // healthCheck() — GET /health
  // ---------------------------------------------------------------------------
  // Returns true if the service is up and responding. Used by the
  // VisionStrategy to fail fast instead of waiting for a locate() timeout.
  // ---------------------------------------------------------------------------
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// VisionServiceError
// ---------------------------------------------------------------------------
// Distinct error class so callers can differentiate vision service failures
// from other errors (e.g. Playwright crash, timeout).
// ---------------------------------------------------------------------------
export class VisionServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "VisionServiceError";
  }
}

// ---------------------------------------------------------------------------
// assertVisionLocateResponse — runtime type guard
// ---------------------------------------------------------------------------
// Validates that an unknown JSON value has the expected shape.
// Throws if required fields are missing — this surfaces version skew early.
// ---------------------------------------------------------------------------
function assertVisionLocateResponse(data: unknown): VisionLocateResponse {
  if (typeof data !== "object" || data === null) {
    throw new VisionServiceError("Response is not an object");
  }

  const d = data as Record<string, unknown>;

  if (typeof d["found"] !== "boolean") {
    throw new VisionServiceError('Response missing required field "found"');
  }

  if (typeof d["latency_ms"] !== "number") {
    throw new VisionServiceError('Response missing required field "latency_ms"');
  }

  return d as unknown as VisionLocateResponse;
}
