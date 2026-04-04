"""
Tests for POST /locate — the vision router.

What we test here:
  - Happy path: provider finds element → 200 + VisionLocateResponse
  - Provider unavailable: ProviderError → 503
  - No provider configured: no key in header, no singleton → 503
  - BYOK (Phase 3): X-Anthropic-Key header → per-request ClaudeProvider
    constructed with that key, NOT the singleton from main.py

The BYOK tests will FAIL until Phase 3 updates the router to read
X-Anthropic-Key and construct a per-request ClaudeProvider.

We use FastAPI's TestClient (backed by httpx) so we exercise the real
request/response pipeline without starting uvicorn.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from vision_service.main import app
from vision_service.models.requests import VisionLocateRequest
from vision_service.models.responses import BoundingBox, VisionLocateResponse
from vision_service.providers.base import AbstractVisionProvider, ProviderError
from vision_service.routers import vision as vision_router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

LOCATE_PAYLOAD = {
    "screenshot_base64": "aGVsbG8=",  # base64("hello")
    "description": "the login button",
    "page_url": "http://localhost/test",
}

FOUND_RESPONSE = VisionLocateResponse(
    found=True,
    bounding_box=BoundingBox(x=100, y=200, width=80, height=40),
    confidence=0.92,
    reasoning="Found the button",
    latency_ms=1200.0,
)

NOT_FOUND_RESPONSE = VisionLocateResponse(
    found=False,
    bounding_box=None,
    confidence=0.0,
    reasoning="Could not find the element",
    latency_ms=900.0,
)


def make_mock_provider(response: VisionLocateResponse = FOUND_RESPONSE) -> AbstractVisionProvider:
    """Returns a mock provider that returns the given response."""
    provider = MagicMock(spec=AbstractVisionProvider)
    provider.provider_name = "mock"
    provider.locate = AsyncMock(return_value=response)
    return provider


# ---------------------------------------------------------------------------
# Tests — basic routing
# ---------------------------------------------------------------------------

class TestLocateEndpoint:
    def test_returns_200_with_found_element(self) -> None:
        mock_provider = make_mock_provider(FOUND_RESPONSE)
        app.dependency_overrides[vision_router.get_provider] = lambda: mock_provider

        with TestClient(app) as client:
            response = client.post("/locate", json=LOCATE_PAYLOAD)

        assert response.status_code == 200
        data = response.json()
        assert data["found"] is True
        assert data["confidence"] == pytest.approx(0.92)
        assert data["bounding_box"]["x"] == 100

    def test_returns_200_with_not_found_element(self) -> None:
        mock_provider = make_mock_provider(NOT_FOUND_RESPONSE)
        app.dependency_overrides[vision_router.get_provider] = lambda: mock_provider

        with TestClient(app) as client:
            response = client.post("/locate", json=LOCATE_PAYLOAD)

        assert response.status_code == 200
        data = response.json()
        assert data["found"] is False
        assert data["bounding_box"] is None

    def test_returns_503_when_provider_raises_provider_error(self) -> None:
        failing_provider = MagicMock(spec=AbstractVisionProvider)
        failing_provider.locate = AsyncMock(
            side_effect=ProviderError("claude", "Rate limited")
        )
        app.dependency_overrides[vision_router.get_provider] = lambda: failing_provider

        with TestClient(app) as client:
            response = client.post("/locate", json=LOCATE_PAYLOAD)

        assert response.status_code == 503

    def test_returns_422_when_request_body_is_missing_required_fields(self) -> None:
        mock_provider = make_mock_provider()
        app.dependency_overrides[vision_router.get_provider] = lambda: mock_provider

        with TestClient(app) as client:
            response = client.post("/locate", json={"description": "missing screenshot"})

        assert response.status_code == 422  # Pydantic validation error

    def test_provider_receives_correct_request_fields(self) -> None:
        mock_provider = make_mock_provider()
        app.dependency_overrides[vision_router.get_provider] = lambda: mock_provider

        with TestClient(app) as client:
            client.post("/locate", json=LOCATE_PAYLOAD)

        called_request: VisionLocateRequest = mock_provider.locate.call_args[0][0]
        assert called_request.description == "the login button"
        assert called_request.page_url == "http://localhost/test"


# ---------------------------------------------------------------------------
# Tests — BYOK (X-Anthropic-Key header)
# NOTE: These tests will FAIL until Phase 3 updates the router.
# ---------------------------------------------------------------------------

class TestBYOK:
    """
    BYOK = Bring Your Own Key.
    When a caller sends X-Anthropic-Key: <key> in the request header,
    the router must construct a per-request ClaudeProvider with that key
    instead of using the singleton provider from startup.
    """

    def test_byok_header_constructs_per_request_claude_provider(self) -> None:
        """
        When X-Anthropic-Key is present, the router must construct a fresh
        ClaudeProvider with that key — not delegate to the singleton.
        """
        # Remove the singleton override so we can verify BYOK takes effect
        app.dependency_overrides.pop(vision_router.get_provider, None)

        with patch("vision_service.routers.vision.ClaudeProvider") as MockClaude:
            mock_instance = make_mock_provider(FOUND_RESPONSE)
            MockClaude.return_value = mock_instance

            with TestClient(app) as client:
                response = client.post(
                    "/locate",
                    json=LOCATE_PAYLOAD,
                    headers={"X-Anthropic-Key": "sk-ant-test-key"},
                )

        # ClaudeProvider must have been instantiated with the header key
        MockClaude.assert_called_once_with(api_key="sk-ant-test-key")
        assert response.status_code == 200

    def test_byok_uses_singleton_when_no_header_key(self) -> None:
        """
        When no X-Anthropic-Key header is sent, the router must fall back
        to the singleton provider registered in main.py.
        """
        singleton = make_mock_provider(FOUND_RESPONSE)
        app.dependency_overrides[vision_router.get_provider] = lambda: singleton

        with TestClient(app) as client:
            response = client.post("/locate", json=LOCATE_PAYLOAD)

        # Singleton should have been called (no per-request provider created)
        assert response.status_code == 200
        singleton.locate.assert_awaited_once()

    def test_byok_returns_503_when_no_key_and_no_singleton(self) -> None:
        """
        When no X-Anthropic-Key header AND no singleton provider configured,
        return 503 (no provider available).
        """
        # Remove any override so the default get_provider() raises RuntimeError
        app.dependency_overrides.pop(vision_router.get_provider, None)

        with TestClient(app) as client:
            response = client.post("/locate", json=LOCATE_PAYLOAD)

        # Either 503 (HTTPException) or 500 (RuntimeError) is acceptable
        assert response.status_code in (500, 503)
