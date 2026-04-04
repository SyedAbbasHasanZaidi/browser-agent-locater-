"""
FastAPI application entry point.

Startup sequence:
  1. Read environment variables (API keys, config)
  2. Instantiate ClaudeProvider (with OpenAIProvider as fallback)
  3. Instantiate TrajectoryLogger
  4. Register both as FastAPI dependencies
  5. Mount routers at /locate, /trajectory, /health
  6. Serve via uvicorn

Design: Application-level dependency wiring
-------------------------------------------
All provider instantiation happens HERE, not in the routers. Routers stay
thin and testable — they declare what they need (AbstractVisionProvider) and
main.py supplies the concrete instance. This is the Composition Root pattern:
one place in the application where all concrete types are wired together.
"""

from __future__ import annotations

import os
from typing import Callable

from fastapi import FastAPI, Request, Response

from vision_service.models.responses import HealthResponse
from vision_service.providers.base import AbstractVisionProvider
from vision_service.providers.claude import ClaudeProvider
from vision_service.providers.openai_gpt4v import OpenAIProvider
from vision_service.routers import trajectory as trajectory_router
from vision_service.routers import vision as vision_router
from vision_service.trajectory.logger import TrajectoryLogger

VERSION = "0.1.0"

app = FastAPI(
    title="Vision Element Locator Service",
    description="Locates UI elements in screenshots using Claude or GPT-4V",
    version=VERSION,
)

# ---------------------------------------------------------------------------
# Security middleware — redact X-Anthropic-Key from the request scope
# ---------------------------------------------------------------------------
# FastAPI/uvicorn do not log request headers by default, but any future
# observability tool (Sentry, Datadog, OpenTelemetry) may capture the raw
# ASGI scope which includes all headers. This middleware:
#   1. Extracts the real X-Anthropic-Key value and stores it in request.state
#      so the router can still read it (FastAPI's Header() reads from scope).
#   2. Replaces the scope header value with b"[REDACTED]" so any downstream
#      logging, error reporters, or debug tools never see the real key.
#
# The router reads request.state.byok_key instead of Header(default=None).
# ---------------------------------------------------------------------------
_BYOK_HEADER = b"x-anthropic-key"


@app.middleware("http")
async def redact_sensitive_headers(request: Request, call_next: Callable) -> Response:
    # Extract the real key before redacting so the router can still use it.
    byok_key: str | None = None
    redacted_headers = []
    for name, value in request.scope["headers"]:
        if name.lower() == _BYOK_HEADER:
            byok_key = value.decode()
            redacted_headers.append((name, b"[REDACTED]"))
        else:
            redacted_headers.append((name, value))
    request.scope["headers"] = redacted_headers
    # Safe channel: router reads from state, never from the (now-redacted) scope.
    request.state.byok_key = byok_key
    return await call_next(request)

# ---------------------------------------------------------------------------
# Provider wiring — Composition Root
# ---------------------------------------------------------------------------
# Try Claude first (primary). Fall back to OpenAI if Claude key is absent.
# If neither key is present, the app starts but /locate will return 503.
# ---------------------------------------------------------------------------
_provider: AbstractVisionProvider | None = None

anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
openai_key = os.environ.get("OPENAI_API_KEY")

if anthropic_key:
    _provider = ClaudeProvider(api_key=anthropic_key)
elif openai_key:
    _provider = OpenAIProvider(api_key=openai_key)

_trajectory_logger = TrajectoryLogger()


# Override the router's dependency placeholder with the real instances.
# Returns None when no env-var key is configured — the router handles the
# None case and returns 503 if no BYOK header is present either.
def _get_provider() -> AbstractVisionProvider | None:
    return _provider


app.dependency_overrides[vision_router.get_provider] = _get_provider
app.dependency_overrides[trajectory_router.get_trajectory_logger] = (
    lambda: _trajectory_logger
)

# ---------------------------------------------------------------------------
# Mount routers
# ---------------------------------------------------------------------------
app.include_router(vision_router.router)
app.include_router(trajectory_router.router)


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    provider_name = _provider.provider_name if _provider else "none"
    return HealthResponse(status="ok", provider=provider_name, version=VERSION)
