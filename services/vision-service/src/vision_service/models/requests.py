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
# VisionLocateRequest  —  POST /locate
# ---------------------------------------------------------------------------
# Sent by the TypeScript VisionStrategy when DOM and A11y have both failed.
# The strategy captures a full-page screenshot, base64-encodes it, and sends
# it here together with the natural-language description of the target.
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
