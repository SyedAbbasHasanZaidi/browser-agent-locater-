"""
Trajectory router — POST /trajectory

Receives locate() attempt records from the TypeScript TrajectoryLogger and
appends them to a per-session JSONL file.

This endpoint is called fire-and-forget from TypeScript — the client does not
await the response. The endpoint acknowledges immediately and writes
asynchronously. A slow disk write does not block the TypeScript agent.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from vision_service.models.requests import TrajectoryLogRequest
from vision_service.models.responses import TrajectoryLogResponse
from vision_service.trajectory.logger import TrajectoryLogger

router = APIRouter()


def get_trajectory_logger() -> TrajectoryLogger:
    """Dependency injector — overridden in main.py."""
    raise RuntimeError("TrajectoryLogger not configured")


@router.post("/trajectory", response_model=TrajectoryLogResponse)
async def log_trajectory(
    request: TrajectoryLogRequest,
    logger: TrajectoryLogger = Depends(get_trajectory_logger),
) -> TrajectoryLogResponse:
    """Append a trajectory record to the session's JSONL file."""
    record = await logger.log(request)
    return TrajectoryLogResponse(ok=True, entry_id=record.entry_id)
