"""
TrajectoryRecord — the canonical JSONL schema written to disk.

This schema is HuggingFace datasets-compatible. Each line in a .jsonl file
is one serialized TrajectoryRecord. Loading in Python:
    from datasets import load_dataset
    ds = load_dataset("json", data_files="trajectories/*.jsonl")

The schema mirrors the TypeScript TrajectoryRecord interface in
packages/locator-sdk/src/types/trajectory.types.ts. Both must stay in sync.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class StrategyAttemptRecord(BaseModel):
    strategy: Literal["dom", "a11y", "vision"]
    succeeded: bool
    duration_ms: float
    resolved_selector: str | None = None
    confidence: float | None = None
    error: str | None = None


class TrajectoryRecord(BaseModel):
    # Unique record ID — generated at write time for deduplication
    entry_id: str = Field(default_factory=lambda: str(uuid4()))

    # Session context
    session_id: str
    step_index: int
    timestamp: str = Field(
        default_factory=lambda: datetime.utcnow().isoformat() + "Z"
    )

    # What was being located
    task_description: str
    target: dict[str, Any]
    page_url: str

    # The full attempt history for this locate() call
    attempts: list[StrategyAttemptRecord]

    # Resolution
    winner: Literal["dom", "a11y", "vision"] | None
    resolved_selector: str | None
    total_duration_ms: float
