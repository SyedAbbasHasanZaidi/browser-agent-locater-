"""
Response models for the Vision Service REST API.

These Pydantic models define the JSON shapes returned by each endpoint.
FastAPI serializes handler return values using these models automatically —
extra fields on the internal model are stripped before sending to the client,
and field aliases or validators are applied on the way out.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# BoundingBox  —  pixel coordinates of the located element
# ---------------------------------------------------------------------------
# x, y is the top-left corner. width and height are in pixels.
# The TypeScript VisionStrategy uses cx = x + width/2, cy = y + height/2
# to call document.elementFromPoint(cx, cy) and resolve the live DOM handle.
# ---------------------------------------------------------------------------
class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


# ---------------------------------------------------------------------------
# VisionLocateResponse  —  200 from POST /locate
# ---------------------------------------------------------------------------
class VisionLocateResponse(BaseModel):
    # True if the vision model found a plausible element matching the description.
    # False if the model explicitly said it could not find it.
    found: bool

    # Pixel bounding box of the located element. Only present when found=True.
    bounding_box: BoundingBox | None = None

    # 0.0–1.0 confidence that this is the right element.
    # Derived from the model's own reasoning (Claude is asked to rate certainty).
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    # The model's chain-of-thought for why it identified this element.
    # Stored in the trajectory for ML interpretability.
    reasoning: str | None = None

    # How long the vision provider took to respond (ms). Measured inside the
    # Python service so it reflects pure inference latency, not network.
    latency_ms: float


# ---------------------------------------------------------------------------
# TrajectoryLogResponse  —  200 from POST /trajectory
# ---------------------------------------------------------------------------
class TrajectoryLogResponse(BaseModel):
    ok: bool = True
    # UUID v4 assigned to this specific JSONL entry for deduplication.
    entry_id: str


# ---------------------------------------------------------------------------
# HealthResponse  —  200 from GET /health
# ---------------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: str = "ok"
    # Which vision provider is currently active
    provider: str
    version: str
