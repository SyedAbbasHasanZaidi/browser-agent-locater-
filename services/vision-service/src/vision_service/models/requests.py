"""
Request models for the Vision Service REST API.

These Pydantic models are the single source of truth for the JSON bodies
accepted by the two POST endpoints. FastAPI uses them for:
  1. Automatic request validation (400 if a required field is missing or wrong type)
  2. Auto-generated OpenAPI/Swagger docs at /docs
  3. Editor autocompletion in the router handlers

The shapes here mirror the TypeScript types in:
  packages/locator-sdk/src/types/trajectory.types.ts  (TrajectoryLogRequest)
  packages/locator-sdk/src/transport/vision-client.ts  (VisionLocateRequest)
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# A11yNodeInfo  —  Accessibility tree node sent as disambiguation context
# ---------------------------------------------------------------------------
# Each node represents one interactive element collected by the TypeScript
# A11y strategy. Provides Claude with a structural map of all interactive
# elements on the page — roles, accessible names, and positions.
# ---------------------------------------------------------------------------
class A11yNodeInfo(BaseModel):
    role: str = Field(..., description="ARIA role or HTML tag name")
    name: str | None = Field(default=None, description="Accessible name (aria-label, innerText, etc.)")
    description: str | None = Field(default=None, description="Accessible description")
    bounding_box: dict[str, float] | None = Field(
        default=None,
        description="Element position {x, y, width, height} in pixels",
    )


# ---------------------------------------------------------------------------
# FailedStrategyAttempt  —  What previous strategies tried and why they failed
# ---------------------------------------------------------------------------
class FailedStrategyAttempt(BaseModel):
    strategy: Literal["dom", "a11y"] = Field(..., description="Strategy that failed")
    error: str | None = Field(default=None, description="Error message if strategy threw")
    candidates_considered: int | None = Field(
        default=None, description="Number of candidates the strategy evaluated"
    )
    best_candidate_name: str | None = Field(
        default=None, description="Accessible name of the closest match"
    )
    best_candidate_score: float | None = Field(
        default=None, description="Jaro-Winkler score of the closest match"
    )


# ---------------------------------------------------------------------------
# VisionLocateRequest  —  POST /locate
# ---------------------------------------------------------------------------
# Sent by the TypeScript VisionStrategy when DOM and A11y have both failed.
# The strategy captures a full-page screenshot, base64-encodes it, and sends
# it here together with the natural-language description of the target.
#
# Optional context fields (a11y_tree, failed_attempts, viewport, target_role_hint)
# enrich Claude's prompt for better disambiguation of ambiguous elements.
# All are optional for backward compatibility with older SDK versions.
# ---------------------------------------------------------------------------
class VisionLocateRequest(BaseModel):
    # Base64-encoded PNG of the full page at the time of the locate() call.
    # Using base64 in JSON avoids multipart complexity; PNG is lossless so
    # Claude sees crisp text and UI elements.
    screenshot_base64: str = Field(
        ..., description="Base64-encoded full-page PNG screenshot"
    )

    # The natural-language description from LocatorTarget.description.
    # Sent verbatim to the vision provider as part of the prompt.
    # e.g. "the blue Submit button in the login form"
    description: str = Field(
        ..., description="Natural-language description of the element to locate"
    )

    # The URL of the page — included in the prompt so the model has context
    # about what site it is looking at (helps with ambiguous element names).
    page_url: str = Field(..., description="URL of the page being analyzed")

    # Optional: which provider to use for this request.
    # Defaults to the service's configured primary provider (Claude).
    # Allows per-call override for A/B testing providers.
    provider: Literal["claude", "openai"] | None = Field(
        default=None,
        description="Override the default vision provider for this request",
    )

    # Maximum number of candidate elements to return if the model supports it.
    # Currently unused by Claude (which returns the single best match), but
    # reserved for future multi-candidate ranking.
    max_candidates: int = Field(
        default=1, ge=1, le=10, description="Max number of candidate elements"
    )

    # --- Disambiguation context (all optional, backward compatible) ----------

    # Flattened list of interactive elements from the A11y strategy's DOM scan.
    # Gives Claude a structural map: "these are all the buttons, links, and
    # inputs on the page with their accessible names and positions."
    a11y_tree: list[A11yNodeInfo] | None = Field(
        default=None,
        description="Interactive elements collected by the A11y strategy",
    )

    # What DOM and A11y strategies already tried and why they failed.
    # Helps Claude avoid redundant reasoning and focus on what's different
    # about the visual approach.
    failed_attempts: list[FailedStrategyAttempt] | None = Field(
        default=None,
        description="Strategies that tried and failed before Vision",
    )

    # Browser viewport dimensions — helps Claude scale bounding box coordinates
    # relative to the screenshot dimensions.
    viewport: dict[str, int] | None = Field(
        default=None,
        description="Viewport dimensions {width, height} in pixels",
    )

    # Expected ARIA role of the target element (e.g. "button", "link", "combobox").
    # Narrows Claude's search space when the caller knows the element type.
    target_role_hint: str | None = Field(
        default=None,
        description="Expected ARIA role of the target element",
    )


# ---------------------------------------------------------------------------
# StrategyAttemptLog  —  nested inside TrajectoryStepLog
# ---------------------------------------------------------------------------
# Mirrors the TypeScript StrategyAttempt interface.
# ---------------------------------------------------------------------------
class StrategyAttemptLog(BaseModel):
    strategy: Literal["dom", "a11y", "vision"]
    succeeded: bool
    duration_ms: float
    resolved_selector: str | None = None
    confidence: float | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# TrajectoryStepLog  —  nested inside TrajectoryLogRequest
# ---------------------------------------------------------------------------
class TrajectoryStepLog(BaseModel):
    attempts: list[StrategyAttemptLog]
    winner: Literal["dom", "a11y", "vision"] | None
    resolved_selector: str | None
    total_duration_ms: float
    page_url: str
    # The raw LocatorTarget — kept as Any because it's an arbitrary dict
    # from TypeScript; the Python side only needs to store it verbatim.
    target: dict[str, Any]


# ---------------------------------------------------------------------------
# TrajectoryLogRequest  —  POST /trajectory
# ---------------------------------------------------------------------------
# Sent by the TypeScript TrajectoryLogger after every locate() call.
# Python appends one JSONL line per request to the session's .jsonl file.
# ---------------------------------------------------------------------------
class TrajectoryLogRequest(BaseModel):
    session_id: str = Field(..., description="UUID v4 identifying the agent session")
    step_index: int = Field(..., ge=0, description="Monotonically increasing step counter")
    task_description: str = Field(
        ..., description="Human-readable description of what was being located"
    )
    step: TrajectoryStepLog
