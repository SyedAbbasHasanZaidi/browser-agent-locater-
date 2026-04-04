"""
Tests for ClaudeProvider and OpenAIProvider.

What we test here:
  - ClaudeProvider._parse_response() with valid JSON → VisionLocateResponse
  - ClaudeProvider._parse_response() with invalid JSON → found=False (graceful)
  - ClaudeProvider._parse_response() with malformed bounding_box → found=False
  - ClaudeProvider.locate() raises ProviderError on AuthenticationError
  - ClaudeProvider.locate() raises ProviderError on RateLimitError
  - ClaudeProvider.locate() raises ProviderError on generic APIError
  - OpenAIProvider: similar contract (mocked openai client)

We mock the Anthropic and OpenAI clients so no real API calls are made.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import anthropic
import pytest

from vision_service.models.requests import VisionLocateRequest
from vision_service.providers.base import ProviderError
from vision_service.providers.claude import ClaudeProvider
from vision_service.providers.openai_gpt4v import OpenAIProvider


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_REQUEST = VisionLocateRequest(
    screenshot_base64="aGVsbG8=",
    description="the login button",
    page_url="http://localhost/test",
)

VALID_JSON_RESPONSE = """{
  "found": true,
  "bounding_box": {"x": 100, "y": 200, "width": 80, "height": 40},
  "confidence": 0.92,
  "reasoning": "Found the blue Submit button in the top-right corner"
}"""

NOT_FOUND_JSON_RESPONSE = """{
  "found": false,
  "bounding_box": null,
  "confidence": 0.0,
  "reasoning": "No matching element visible in the screenshot"
}"""


def make_anthropic_message(text: str) -> MagicMock:
    """Builds a mock Anthropic Messages response with the given text."""
    content_block = MagicMock()
    content_block.text = text

    message = MagicMock()
    message.content = [content_block]
    return message


# ---------------------------------------------------------------------------
# ClaudeProvider — _parse_response (unit, no network)
# ---------------------------------------------------------------------------

class TestClaudeProviderParseResponse:
    """
    _parse_response is a pure function. We test it directly to keep tests fast
    and to cover all JSON shapes without making API calls.
    """

    def setup_method(self) -> None:
        # Construct with a dummy key — _parse_response doesn't call the API
        self.provider = ClaudeProvider(api_key="sk-ant-dummy")

    def test_parses_valid_found_response(self) -> None:
        result = self.provider._parse_response(VALID_JSON_RESPONSE, latency_ms=1200.0)

        assert result.found is True
        assert result.confidence == pytest.approx(0.92)
        assert result.bounding_box is not None
        assert result.bounding_box.x == 100
        assert result.bounding_box.y == 200
        assert result.bounding_box.width == 80
        assert result.bounding_box.height == 40
        assert result.latency_ms == pytest.approx(1200.0)

    def test_parses_not_found_response(self) -> None:
        result = self.provider._parse_response(NOT_FOUND_JSON_RESPONSE, latency_ms=900.0)

        assert result.found is False
        assert result.bounding_box is None
        assert result.confidence == pytest.approx(0.0)

    def test_returns_not_found_on_invalid_json(self) -> None:
        """Claude occasionally prefixes JSON with prose — must not crash."""
        result = self.provider._parse_response(
            "Here is the JSON:\n```json\n{invalid}", latency_ms=500.0
        )

        assert result.found is False
        assert result.bounding_box is None

    def test_returns_not_found_on_empty_response(self) -> None:
        result = self.provider._parse_response("", latency_ms=100.0)

        assert result.found is False

    def test_marks_not_found_when_bounding_box_is_malformed(self) -> None:
        """If found=true but bounding_box has wrong keys, treat as not found."""
        malformed = '{"found": true, "bounding_box": {"left": 10}, "confidence": 0.9, "reasoning": "x"}'
        result = self.provider._parse_response(malformed, latency_ms=800.0)

        assert result.found is False

    def test_preserves_reasoning_string(self) -> None:
        result = self.provider._parse_response(VALID_JSON_RESPONSE, latency_ms=0.0)
        assert "Submit" in (result.reasoning or "")

    def test_handles_confidence_zero(self) -> None:
        json_str = '{"found": false, "bounding_box": null, "confidence": 0.0, "reasoning": ""}'
        result = self.provider._parse_response(json_str, latency_ms=0.0)
        assert result.confidence == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# ClaudeProvider — locate() (mocked Anthropic client)
# ---------------------------------------------------------------------------

class TestClaudeProviderLocate:
    def setup_method(self) -> None:
        self.provider = ClaudeProvider(api_key="sk-ant-dummy")

    async def test_returns_vision_locate_response_on_success(self) -> None:
        mock_message = make_anthropic_message(VALID_JSON_RESPONSE)

        with patch.object(
            self.provider._client.messages, "create", new=AsyncMock(return_value=mock_message)
        ):
            result = await self.provider.locate(SAMPLE_REQUEST)

        assert result.found is True
        assert result.confidence == pytest.approx(0.92)

    async def test_raises_provider_error_on_authentication_error(self) -> None:
        with patch.object(
            self.provider._client.messages,
            "create",
            new=AsyncMock(side_effect=anthropic.AuthenticationError(
                message="Invalid API key",
                response=MagicMock(status_code=401),
                body={},
            )),
        ):
            with pytest.raises(ProviderError, match="Authentication failed"):
                await self.provider.locate(SAMPLE_REQUEST)

    async def test_raises_provider_error_on_rate_limit(self) -> None:
        with patch.object(
            self.provider._client.messages,
            "create",
            new=AsyncMock(side_effect=anthropic.RateLimitError(
                message="Rate limited",
                response=MagicMock(status_code=429),
                body={},
            )),
        ):
            with pytest.raises(ProviderError, match="Rate limited"):
                await self.provider.locate(SAMPLE_REQUEST)

    async def test_raises_provider_error_on_generic_api_error(self) -> None:
        with patch.object(
            self.provider._client.messages,
            "create",
            new=AsyncMock(side_effect=anthropic.APIError(
                message="Internal server error",
                request=MagicMock(),
                body={},
            )),
        ):
            with pytest.raises(ProviderError):
                await self.provider.locate(SAMPLE_REQUEST)

    async def test_sends_screenshot_in_image_block(self) -> None:
        mock_message = make_anthropic_message(VALID_JSON_RESPONSE)
        mock_create = AsyncMock(return_value=mock_message)

        with patch.object(self.provider._client.messages, "create", new=mock_create):
            await self.provider.locate(SAMPLE_REQUEST)

        call_kwargs = mock_create.call_args.kwargs
        messages = call_kwargs["messages"]
        user_content = messages[0]["content"]

        # First content block should be the image
        image_block = user_content[0]
        assert image_block["type"] == "image"
        assert image_block["source"]["data"] == SAMPLE_REQUEST.screenshot_base64

    async def test_includes_description_in_user_prompt(self) -> None:
        mock_message = make_anthropic_message(VALID_JSON_RESPONSE)
        mock_create = AsyncMock(return_value=mock_message)

        with patch.object(self.provider._client.messages, "create", new=mock_create):
            await self.provider.locate(SAMPLE_REQUEST)

        call_kwargs = mock_create.call_args.kwargs
        messages = call_kwargs["messages"]
        user_content = messages[0]["content"]

        # Second content block should be the text prompt
        text_block = user_content[1]
        assert text_block["type"] == "text"
        assert SAMPLE_REQUEST.description in text_block["text"]


# ---------------------------------------------------------------------------
# OpenAIProvider — basic contract (mocked openai client)
# ---------------------------------------------------------------------------

class TestOpenAIProvider:
    def setup_method(self) -> None:
        self.provider = OpenAIProvider(api_key="sk-openai-dummy")

    def test_provider_name_is_openai(self) -> None:
        assert self.provider.provider_name == "openai"

    async def test_returns_vision_locate_response_on_success(self) -> None:
        """OpenAI provider should return a VisionLocateResponse with the same contract."""
        mock_response_json = VALID_JSON_RESPONSE

        # Build mock OpenAI response structure
        mock_choice = MagicMock()
        mock_choice.message.content = mock_response_json
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]

        with patch.object(
            self.provider._client.chat.completions,
            "create",
            new=AsyncMock(return_value=mock_completion),
        ):
            result = await self.provider.locate(SAMPLE_REQUEST)

        assert result.found is True
        assert result.confidence == pytest.approx(0.92)
        assert result.bounding_box is not None
