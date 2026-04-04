"""
OpenAIProvider — Vision provider backed by gpt-4o (fallback).

Used when:
  - ClaudeProvider raises ProviderError (API key missing, rate-limited)
  - A request explicitly sets provider="openai"

The prompt engineering strategy mirrors ClaudeProvider but uses the
OpenAI Chat Completions API with vision content blocks.
"""

from __future__ import annotations

import json
import time

import openai

from vision_service.models.requests import VisionLocateRequest
from vision_service.models.responses import BoundingBox, VisionLocateResponse
from vision_service.providers.base import AbstractVisionProvider, ProviderError

_SYSTEM_PROMPT = """You are a precise UI element locator. Find the specified element in the screenshot.

Respond with ONLY valid JSON (no markdown, no prose):
{
  "found": boolean,
  "bounding_box": {"x": number, "y": number, "width": number, "height": number} | null,
  "confidence": number,
  "reasoning": string
}

If you cannot find the element, set found=false and bounding_box=null."""


class OpenAIProvider(AbstractVisionProvider):
    MODEL = "gpt-4o"

    def __init__(self, api_key: str) -> None:
        self._client = openai.AsyncOpenAI(api_key=api_key)

    @property
    def provider_name(self) -> str:
        return "openai"

    async def locate(self, request: VisionLocateRequest) -> VisionLocateResponse:
        start = time.perf_counter()

        user_content = [
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{request.screenshot_base64}",
                    "detail": "high",
                },
            },
            {
                "type": "text",
                "text": (
                    f'Find this element: "{request.description}"\n'
                    f"Page URL: {request.page_url}"
                ),
            },
        ]

        try:
            response = await self._client.chat.completions.create(
                model=self.MODEL,
                max_tokens=512,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
            )
        except openai.AuthenticationError as e:
            raise ProviderError("openai", f"Authentication failed: {e}") from e
        except openai.RateLimitError as e:
            raise ProviderError("openai", f"Rate limited: {e}") from e
        except openai.APIError as e:
            raise ProviderError("openai", f"API error: {e}") from e

        latency_ms = (time.perf_counter() - start) * 1000
        raw_text = response.choices[0].message.content or ""

        return self._parse_response(raw_text, latency_ms)

    def _parse_response(self, raw_text: str, latency_ms: float) -> VisionLocateResponse:
        try:
            data = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            return VisionLocateResponse(found=False, latency_ms=latency_ms)

        found = bool(data.get("found", False))
        confidence = float(data.get("confidence", 0.0))
        reasoning = data.get("reasoning")
        bounding_box: BoundingBox | None = None

        if found and isinstance(data.get("bounding_box"), dict):
            bb = data["bounding_box"]
            try:
                bounding_box = BoundingBox(
                    x=float(bb["x"]),
                    y=float(bb["y"]),
                    width=float(bb["width"]),
                    height=float(bb["height"]),
                )
            except (KeyError, TypeError, ValueError):
                found = False

        return VisionLocateResponse(
            found=found,
            bounding_box=bounding_box,
            confidence=confidence,
            reasoning=reasoning,
            latency_ms=latency_ms,
        )
