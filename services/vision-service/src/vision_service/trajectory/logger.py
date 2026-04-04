"""
TrajectoryLogger — appends TrajectoryRecord instances to JSONL files.

File Layout:
    services/vision-service/trajectories/{session_id}.jsonl

One file per session. Each line is a complete, independently parseable JSON
object. JSONL (newline-delimited JSON) is the standard format for ML training
data because:
  - Partial writes are safe (each line is atomic)
  - Files can be streamed without loading the full dataset into memory
  - HuggingFace datasets.load_dataset("json", ...) reads JSONL natively

Thread Safety:
  FastAPI runs on a single async event loop (asyncio). All write operations
  are awaited, so they run sequentially on the event loop — no lock needed.
  If multi-process deployment is used (Gunicorn workers), each worker gets
  its own file because session_ids are UUIDs and unlikely to collide.

Data Flow:
  POST /trajectory
    → TrajectoryLogRequest (Pydantic)
    → TrajectoryRecord (schema)
    → asyncio file write → {session_id}.jsonl
    → TrajectoryLogResponse { ok: True, entry_id: "uuid" }
"""

from __future__ import annotations

import json
from pathlib import Path

import aiofiles

from vision_service.models.requests import TrajectoryLogRequest
from vision_service.trajectory.schema import StrategyAttemptRecord, TrajectoryRecord

# Trajectories are written relative to the project root (where uvicorn runs)
TRAJECTORIES_DIR = Path("trajectories")


class TrajectoryLogger:
    """Async JSONL writer for trajectory records."""

    def __init__(self, trajectories_dir: Path = TRAJECTORIES_DIR) -> None:
        self._dir = trajectories_dir

    async def log(self, request: TrajectoryLogRequest) -> TrajectoryRecord:
        """
        Convert a TrajectoryLogRequest into a TrajectoryRecord and append it
        to the session's JSONL file. Returns the record (with entry_id).
        """
        record = TrajectoryRecord(
            session_id=request.session_id,
            step_index=request.step_index,
            task_description=request.task_description,
            target=request.step.target,
            page_url=request.step.page_url,
            attempts=[
                StrategyAttemptRecord(**attempt.model_dump())
                for attempt in request.step.attempts
            ],
            winner=request.step.winner,
            resolved_selector=request.step.resolved_selector,
            total_duration_ms=request.step.total_duration_ms,
        )

        await self._append(record)
        return record

    async def _append(self, record: TrajectoryRecord) -> None:
        """Append one JSON line to the session's .jsonl file."""
        self._dir.mkdir(parents=True, exist_ok=True)
        file_path = self._dir / f"{record.session_id}.jsonl"

        # model_dump() serializes to a Python dict; json.dumps() converts to
        # a JSON string. We write one line per record with a trailing newline.
        line = json.dumps(record.model_dump()) + "\n"

        # aiofiles provides async file I/O so we don't block the event loop
        # during the disk write (important for high-throughput agent sessions).
        async with aiofiles.open(file_path, mode="a", encoding="utf-8") as f:
            await f.write(line)
