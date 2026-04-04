"""
Vision router — POST /locate

Handles requests from the TypeScript VisionStrategy. Supports two modes:

1. BYOK (Bring Your Own Key):
   When the caller sends X-Anthropic-Key: <key> in the request header,
   the router constructs a per-request ClaudeProvider with that key.
   This is the recommended mode for shared/hosted deployments — each caller
   uses their own Anthropic quota and the service never holds a shared key.

2. Singleton provider (server-side key):
   When no X-Anthropic-Key header is present, the router delegates to the
   AbstractVisionProvider singleton registered by main.py (sourced from env
   vars ANTHROPIC_API_KEY / OPENAI_API_KEY). If no singleton is configured,
   returns 503.

Control Flow:
  POST /locate
    → FastAPI validates body (Pydantic)
    → if X-Anthropic-Key header present → per-request ClaudeProvider(api_key=key)
    → else → Depends(get_provider) → singleton from main.py
    → provider.locate(request) → VisionLocateResponse
    → 503 if ProviderError is raised
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from vision_service.models.requests import VisionLocateRequest
from vision_service.models.responses import VisionLocateResponse
from vision_service.providers.base import AbstractVisionProvider, ProviderError
from vision_service.providers.claude import ClaudeProvider

router = APIRouter()


def get_provider() -> AbstractVisionProvider | None:
    """
    Dependency injector — overridden in main.py via app.dependency_overrides.
    Returns None by default so BYOK requests can proceed without a singleton.
    main.py overrides this to return the env-var-configured provider (or None
    if neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set).
    """
    return None


@router.post("/locate", response_model=VisionLocateResponse)
async def locate_element(
    raw_request: Request,
    request: VisionLocateRequest,
    singleton_provider: AbstractVisionProvider | None = Depends(get_provider),
) -> VisionLocateResponse:
    """
    Find an element in a screenshot using the configured vision provider.

    BYOK: reads X-Anthropic-Key from request.state.byok_key (set by the
    redact_sensitive_headers middleware in main.py, which extracts the real
    value before replacing it with [REDACTED] in the ASGI scope).
    Falls back to the singleton provider from main.py if no key is present.
    Returns 503 if no key is available by either path.
    """
    # Read from request.state — the middleware stored the real key here before
    # redacting the ASGI scope. This ensures the key never appears in logs while
    # still being accessible to the handler.
    x_anthropic_key: str | None = getattr(raw_request.state, "byok_key", None)

    provider: AbstractVisionProvider
    if x_anthropic_key:
        provider = ClaudeProvider(api_key=x_anthropic_key)
    elif singleton_provider is not None:
        provider = singleton_provider
    else:
        raise HTTPException(
            status_code=503,
            detail="No vision provider configured. Pass X-Anthropic-Key header or set ANTHROPIC_API_KEY on the service.",
        )

    try:
        return await provider.locate(request)
    except ProviderError as e:
        # Provider is broken (auth failed, rate limited, etc.)
        # 503 tells the TypeScript client that the service is up but the
        # upstream AI provider is unavailable — client can log and give up.
        raise HTTPException(status_code=503, detail=str(e)) from e
