"""
Tests for TrajectoryLogger — the async JSONL writer.

What we test:
  - A .jsonl file is created under trajectories/{session_id}.jsonl
  - Each call appends exactly one valid JSON line
  - Multiple calls append multiple lines (not overwrite)
  - The returned TrajectoryRecord has a non-empty entry_id (UUID)
  - The record fields match the input request

Tests use a temporary directory (tmp_path fixture) so they never touch
the real trajectories/ folder and never interfere with each other.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from vision_service.models.requests import (
    StrategyAttemptLog,
    TrajectoryLogRequest,
    TrajectoryStepLog,
)
from vision_service.trajectory.logger import TrajectoryLogger


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_request(
    session_id: str = "test-session-abc",
    step_index: int = 0,
    winner: str | None = "dom",
) -> TrajectoryLogRequest:
    return TrajectoryLogRequest(
        session_id=session_id,
        step_index=step_index,
        task_description="Click the login button",
        step=TrajectoryStepLog(
            attempts=[
                StrategyAttemptLog(
                    strategy="dom",
                    succeeded=True,
                    duration_ms=45.2,
                    resolved_selector='[data-testid="login-btn"]',
                    confidence=1.0,
                ),
            ],
            winner=winner,  # type: ignore[arg-type]
            resolved_selector='[data-testid="login-btn"]',
            total_duration_ms=48.0,
            page_url="http://localhost/login",
            target={"testId": "login-btn"},
        ),
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTrajectoryLogger:
    async def test_creates_jsonl_file_named_after_session_id(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)
        request = make_request(session_id="session-xyz")

        await logger.log(request)

        expected_file = tmp_path / "session-xyz.jsonl"
        assert expected_file.exists(), "JSONL file should be created"

    async def test_written_line_is_valid_json(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)
        await logger.log(make_request(session_id="session-json-check"))

        lines = (tmp_path / "session-json-check.jsonl").read_text().strip().splitlines()
        assert len(lines) == 1
        data = json.loads(lines[0])  # Must not raise
        assert isinstance(data, dict)

    async def test_returns_record_with_non_empty_entry_id(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)
        record = await logger.log(make_request())

        assert record.entry_id
        assert len(record.entry_id) > 0

    async def test_record_fields_match_request(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)
        request = make_request(session_id="session-fields", step_index=3)
        record = await logger.log(request)

        assert record.session_id == "session-fields"
        assert record.step_index == 3
        assert record.task_description == "Click the login button"
        assert record.winner == "dom"
        assert record.page_url == "http://localhost/login"

    async def test_multiple_logs_append_multiple_lines(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)
        session = "session-multi"

        await logger.log(make_request(session_id=session, step_index=0))
        await logger.log(make_request(session_id=session, step_index=1))
        await logger.log(make_request(session_id=session, step_index=2))

        lines = (tmp_path / f"{session}.jsonl").read_text().strip().splitlines()
        assert len(lines) == 3

    async def test_different_sessions_write_to_different_files(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)

        await logger.log(make_request(session_id="session-a"))
        await logger.log(make_request(session_id="session-b"))

        assert (tmp_path / "session-a.jsonl").exists()
        assert (tmp_path / "session-b.jsonl").exists()

        # Ensure the files are separate (cross-contamination check)
        lines_a = (tmp_path / "session-a.jsonl").read_text().strip().splitlines()
        lines_b = (tmp_path / "session-b.jsonl").read_text().strip().splitlines()
        assert len(lines_a) == 1
        assert len(lines_b) == 1

    async def test_attempts_are_stored_in_written_record(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)
        await logger.log(make_request(session_id="session-attempts"))

        lines = (tmp_path / "session-attempts.jsonl").read_text().strip().splitlines()
        data = json.loads(lines[0])

        assert "attempts" in data
        assert len(data["attempts"]) == 1
        assert data["attempts"][0]["strategy"] == "dom"
        assert data["attempts"][0]["succeeded"] is True

    async def test_creates_trajectories_directory_if_missing(self, tmp_path: Path) -> None:
        nested_dir = tmp_path / "deep" / "nested" / "trajectories"
        logger = TrajectoryLogger(trajectories_dir=nested_dir)

        await logger.log(make_request(session_id="session-mkdir"))

        assert nested_dir.exists()
        assert (nested_dir / "session-mkdir.jsonl").exists()

    async def test_entry_id_is_different_for_each_record(self, tmp_path: Path) -> None:
        logger = TrajectoryLogger(trajectories_dir=tmp_path)

        r1 = await logger.log(make_request(session_id="session-uid", step_index=0))
        r2 = await logger.log(make_request(session_id="session-uid", step_index=1))

        assert r1.entry_id != r2.entry_id
