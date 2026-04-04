"""
ClaudeProvider — Vision provider backed by claude-sonnet-4-6.

Design Pattern: Provider (implements AbstractVisionProvider)
-------------------------------------------------------------
This class is the Adapter between our VisionLocateRequest/Response types
and the raw Anthropic Messages API. It encapsulates all prompt engineering
so the rest of the codebase never sees raw API shapes.

Prompt Engineering Strategy:
  - We send the screenshot as a base64 image block (vision input)
  - We ask Claude to return ONLY a JSON object — no prose, no markdown
  - The JSON schema is embedded in the system prompt so Claude knows exactly
    what fields to populate
  - We ask for `reasoning` (chain-of-thought) to make trajectories interpretable
  - We ask Claude to rate `confidence` 0.0–1.0 so the TypeScript side can
    apply its own threshold (currently 0.7 in VisionStrategy)

Why claude-sonnet-4-6?
  Best vision accuracy/cost ratio for UI screenshots. Opus is more capable
  but 5x more expensive for marginal gain on structured UI tasks. Haiku lacks
  the visual reasoning quality needed for ambiguous elements.

Data Flow:
  ClaudeProvider.locate(request)
    → build messages (system prompt + image + user prompt)
    → anthropic.messages.create(model=..., messages=...)
    → parse JSON from response.content[0].text
    → return VisionLocateResponse
"""

from __future__ import annotations

import json
import time

import anthropic

from vision_service.models.requests import VisionLocateRequest
from vision_service.models.responses import BoundingBox, VisionLocateResponse
from vision_service.providers.base import AbstractVisionProvider, ProviderError

# The JSON schema Claude must return. Embedded in the system prompt.
_RESPONSE_SCHEMA = """
{
  "found": boolean,
  "bounding_box": { "x": number, "y": number, "width": number, "height": number } | null,
  "confidence": number (0.0 to 1.0),
  "reasoning": string
}
""".strip()

_SYSTEM_PROMPT = f"""You are a precise UI element locator. Your job is to find a specific element in a screenshot of a web page.

You will be given:
1. A screenshot of a web page
2. A natural-language description of the element to find

You must respond with ONLY a valid JSON object matching this exact schema (no markdown, no prose):
{_RESPONSE_SCHEMA}

Rules:
- Set "found" to true only if you are confident you can see the element
- "bounding_box" must be in pixels relative to the top-left of the screenshot
- "confidence" must reflect your genuine certainty (be conservative — prefer 0.6 over 0.9 when unsure)
- "reasoning" should briefly explain which element you identified and why
- If you cannot find the element, set found=false, bounding_box=null, confidence=0.0
"""


class ClaudeProvider(AbstractVisionProvider):
    """Vision provider using the Anthropic Messages API with vision input."""

    MODEL = "claude-sonnet-4-6"
    MAX_TOKENS = 512  # JSON response is short; 512 is generous

    def __init__(self, api_key: str) -> None:
        # anthropic.AsyncAnthropic is the async client — required because
        # FastAPI handlers are async and we must not block the event loop.
        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    @property
    def provider_name(self) -> str:
        return "claude"

    async def locate(self, request: VisionLocateRequest) -> VisionLocateResponse:
        start = time.perf_counter()

        user_prompt = (
            f'Find this element on the page: "{request.description}"\n'
            f"Page URL: {request.page_url}"
        )

        try:
            response = await self._client.messages.create(
                model=self.MODEL,
                max_tokens=self.MAX_TOKENS,
                system=_SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            # Vision block — the full-page screenshot
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": request.screenshot_base64,
                                },
                            },
                            # Text prompt after the image so Claude sees the
                            # image first then reads the instruction
                            {
                                "type": "text",
                                "text": user_prompt,
                            },
                        ],
                    }
                ],
            )
        except anthropic.AuthenticationError as e:
            raise ProviderError("claude", f"Authentication failed: {e}") from e
        except anthropic.RateLimitError as e:
            raise ProviderError("claude", f"Rate limited: {e}") from e
        except anthropic.APIError as e:
            raise ProviderError("claude", f"API error: {e}") from e

        latency_ms = (time.perf_counter() - start) * 1000

        # Extract the text content from the first content block
        raw_text = response.content[0].text if response.content else ""

        return self._parse_response(raw_text, latency_ms)

    def _parse_response(self, raw_text: str, latency_ms: float) -> VisionLocateResponse:
        """Parse Claude's JSON response into a typed VisionLocateResponse."""
        try:
            data = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            # Claude returned something that isn't valid JSON — treat as not found.
            # This can happen if the model prefixes with "Here is the JSON:" etc.
            # The system prompt says no markdown but we defend against it anyway.
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
                # Malformed bounding box — mark as not found
                found = False

        return VisionLocateResponse(
            found=found,
            bounding_box=bounding_box,
            confidence=confidence,
            reasoning=reasoning,
            latency_ms=latency_ms,
        )
