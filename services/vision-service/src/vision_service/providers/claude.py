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

_SYSTEM_PROMPT = f"""You are a precise UI element locator for browser automation. Your job is to find a specific element in a screenshot of a web page.

You will be given:
1. A screenshot of a web page
2. A natural-language description of the element to find
3. (Optional) An accessibility tree listing all interactive elements with their roles, names, and positions
4. (Optional) Information about what other detection strategies already tried and failed

You must respond with ONLY a valid JSON object matching this exact schema (no markdown, no prose):
{_RESPONSE_SCHEMA}

DISAMBIGUATION RULES (critical for accuracy):
- When an accessibility tree is provided, use it as a structural map. Each node tells you what interactive elements exist and their accessible names. Cross-reference the visual position of elements with their node names.
- When multiple visually similar elements exist (e.g., two "+" buttons, multiple "submit" links), use SPATIAL CONTEXT to disambiguate: identify what text label, heading, or section is NEAR the target element. Describe this spatial relationship in your reasoning.
- When the description mentions a container or region (e.g., "in the navigation bar", "in the Adults row"), FIRST locate that container visually, THEN find the target element WITHIN it.
- For unlabeled form controls (dropdowns, inputs without visible labels), look for a nearby text label — typically above or to the left of the control.
- If previous strategies failed, note what they tried. If the A11y strategy failed because the best fuzzy match score was too low, the element likely has no accessible label that matches the description — focus on visual and positional identification instead of label matching.

BOUNDING BOX RULES:
- Coordinates are in pixels relative to the top-left corner of the screenshot
- Draw a TIGHT bounding box around the element itself, not the surrounding container
- For small elements (buttons, links, dropdowns), ensure width and height are realistic: typically 20-200px for buttons, 60-200px for dropdowns
- CRITICAL: The centroid of your bounding box (x + width/2, y + height/2) will be used to click the element via document.elementFromPoint(). The CENTER of your box MUST land on the target element, not on whitespace or an adjacent element.

CONFIDENCE CALIBRATION:
- 0.9-1.0: Element is unambiguous — clearly visible, matches the description perfectly, no similar elements nearby
- 0.7-0.9: Element is likely correct — matches well but some ambiguity exists (e.g., similar elements nearby that you ruled out)
- 0.5-0.7: Uncertain — multiple candidates exist, you are picking the most likely one
- Below 0.5: Do not claim found. Set found=false, bounding_box=null
"""

# Maximum number of a11y nodes to include in the prompt to limit token usage.
_MAX_A11Y_NODES = 30

# ---------------------------------------------------------------------------
# Category-specific disambiguation guidance
# ---------------------------------------------------------------------------
# Instead of dumping all disambiguation rules into every prompt, we classify
# the scenario and inject only the relevant guidance. This focuses Claude's
# attention on the specific challenge rather than diluting it with irrelevant
# rules about problems that don't apply.
# ---------------------------------------------------------------------------

_GUIDANCE_STALE_SELECTOR = """
DISAMBIGUATION CONTEXT — Stale Selector:
A CSS selector was tried and returned zero matches. The page may have been restructured since the selector was written. Focus on finding the element by its visual appearance and surrounding context rather than any structural assumptions. The selectors that failed are listed in the previous strategies section — use them to understand what element was expected.
""".strip()

_GUIDANCE_TERSE_LABEL = """
DISAMBIGUATION CONTEXT — Short/Terse Label:
The accessibility strategy found a near-miss but the label was too short to match confidently. The target element likely has a very brief label (1-2 words). Look for exact text matches on the page. Small text links and single-word buttons are common — scan navigation bars, footers, and sidebars carefully.
""".strip()

_GUIDANCE_DUPLICATE = """
DISAMBIGUATION CONTEXT — Duplicate Elements:
Multiple visually similar elements exist on this page (e.g., several buttons with the same icon or text). Use SPATIAL CONTEXT to disambiguate: identify what text label, heading, or section is NEAR the target element. The description likely mentions a container or context (e.g., "in the Adults row", "in the header") — locate that region FIRST, then find the target element WITHIN it.
""".strip()

_GUIDANCE_UNLABELED = """
DISAMBIGUATION CONTEXT — Unlabeled Control:
No interactive element on this page has an accessible name that matches the description. The target is likely a form control without a visible label (e.g., a dropdown, toggle, or icon-only button). Look for nearby text labels — typically above or to the left of the control. Also check for placeholder text inside inputs.
""".strip()


class ClaudeProvider(AbstractVisionProvider):
    """Vision provider using the Anthropic Messages API with vision input."""

    MODEL = "claude-sonnet-4-6"
    MAX_TOKENS = 768  # Allow room for longer reasoning with disambiguation context

    def __init__(self, api_key: str) -> None:
        # anthropic.AsyncAnthropic is the async client — required because
        # FastAPI handlers are async and we must not block the event loop.
        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    @property
    def provider_name(self) -> str:
        return "claude"

    async def locate(self, request: VisionLocateRequest) -> VisionLocateResponse:
        start = time.perf_counter()

        user_prompt = self._build_user_prompt(request)

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

        result = self._parse_response(raw_text, latency_ms)
        return self._postprocess(result, request)

    # -----------------------------------------------------------------------
    # _build_user_prompt — Dynamically construct the user prompt
    # -----------------------------------------------------------------------
    # Includes disambiguation context when available: a11y tree, failed
    # attempts, viewport size, and target role hint. All sections are
    # conditional so the prompt stays lean when context is absent.
    # -----------------------------------------------------------------------
    def _build_user_prompt(self, request: VisionLocateRequest) -> str:
        parts: list[str] = [
            f'Find this element on the page: "{request.description}"',
            f"Page URL: {request.page_url}",
        ]

        if request.viewport:
            parts.append(
                f"Viewport: {request.viewport['width']}x{request.viewport['height']}px"
            )

        if request.target_role_hint:
            parts.append(f"Expected element type: {request.target_role_hint}")

        # Inject category-specific disambiguation guidance based on what
        # prior strategies reported. This focuses Claude on the specific
        # challenge rather than dumping all generic rules every time.
        category = self._classify_disambiguation(request)
        guidance = {
            "stale_selector": _GUIDANCE_STALE_SELECTOR,
            "terse_label": _GUIDANCE_TERSE_LABEL,
            "duplicate": _GUIDANCE_DUPLICATE,
            "unlabeled": _GUIDANCE_UNLABELED,
        }.get(category)
        if guidance:
            parts.append(f"\n{guidance}")

        if request.a11y_tree:
            tree_text = self._format_a11y_tree(
                request.a11y_tree, request.description
            )
            parts.append(
                f"\nAccessibility tree (interactive elements on this page):\n{tree_text}"
            )

        if request.failed_attempts:
            failures_text = self._format_failed_attempts(request.failed_attempts)
            parts.append(
                f"\nPrevious strategies that failed:\n{failures_text}"
            )

        return "\n".join(parts)

    @staticmethod
    def _format_a11y_tree(nodes: list, description: str) -> str:
        """Format a11y nodes, prioritizing those most relevant to the description.

        Sorts nodes by keyword overlap with the description so Claude sees
        the most likely candidates first. Caps at _MAX_A11Y_NODES to limit
        token usage.
        """
        desc_words = set(description.lower().split())

        def relevance(node) -> int:
            name_words = set((node.name or "").lower().split())
            return len(desc_words & name_words)

        sorted_nodes = sorted(nodes, key=relevance, reverse=True)
        top_nodes = sorted_nodes[:_MAX_A11Y_NODES]

        lines: list[str] = []
        for i, node in enumerate(top_nodes):
            name = node.name or "(no name)"
            bbox = ""
            if node.bounding_box:
                b = node.bounding_box
                bbox = f" @ ({b['x']:.0f},{b['y']:.0f},{b['width']:.0f}x{b['height']:.0f})"
            lines.append(f"  [{i}] role={node.role}, name=\"{name}\"{bbox}")
        if len(nodes) > _MAX_A11Y_NODES:
            lines.append(f"  ... and {len(nodes) - _MAX_A11Y_NODES} more elements")
        return "\n".join(lines)

    @staticmethod
    def _format_failed_attempts(attempts: list) -> str:
        """Format failed strategy attempts as explanatory bullets."""
        lines: list[str] = []
        for a in attempts:
            detail = f"  - {a.strategy} strategy: "
            if a.error:
                detail += f"error: {a.error}"
            elif a.best_candidate_name:
                role_info = f" (role={a.best_candidate_role})" if a.best_candidate_role else ""
                detail += (
                    f'best match was "{a.best_candidate_name}"{role_info} '
                    f"(score={a.best_candidate_score:.2f}), "
                    f"rejected — below 0.80 threshold"
                )
            elif a.selectors_tried:
                detail += (
                    f"tried {len(a.selectors_tried)} selectors, none matched: "
                    + ", ".join(f'"{s}"' for s in a.selectors_tried[:5])
                )
            elif a.candidates_considered is not None:
                detail += f"evaluated {a.candidates_considered} candidates, none matched"
            else:
                detail += "no candidates found"
            lines.append(detail)
        return "\n".join(lines)

    # -----------------------------------------------------------------------
    # _classify_disambiguation — Infer why Vision was invoked
    # -----------------------------------------------------------------------
    # Examines failed attempt metadata to determine which disambiguation
    # category applies. Returns one of: "stale_selector", "terse_label",
    # "duplicate", "unlabeled", or "unknown". The category selects which
    # guidance block is injected into Claude's prompt.
    # -----------------------------------------------------------------------
    @staticmethod
    def _classify_disambiguation(request: VisionLocateRequest) -> str:
        if not request.failed_attempts:
            return "unknown"

        dom_attempt = next(
            (a for a in request.failed_attempts if a.strategy == "dom"), None
        )
        a11y_attempt = next(
            (a for a in request.failed_attempts if a.strategy == "a11y"), None
        )

        # Stale selector: DOM tried specific selectors, all returned 0 matches
        if dom_attempt and dom_attempt.selectors_tried:
            return "stale_selector"

        # Terse label: A11y found a near-miss but score was low
        if (
            a11y_attempt
            and a11y_attempt.best_candidate_score is not None
            and a11y_attempt.best_candidate_score < 0.60
        ):
            return "terse_label"

        # Duplicate: A11y considered many candidates, best score is moderate
        # (multiple similar elements competing for the match)
        if (
            a11y_attempt
            and (a11y_attempt.candidates_considered or 0) > 10
            and a11y_attempt.best_candidate_score is not None
            and a11y_attempt.best_candidate_score >= 0.60
        ):
            return "duplicate"

        # Unlabeled: A11y found zero candidates with accessible names
        if a11y_attempt and (a11y_attempt.candidates_considered or 0) == 0:
            return "unlabeled"

        return "unknown"

    # -----------------------------------------------------------------------
    # _postprocess — Cross-reference Claude's bbox with a11y nodes
    # -----------------------------------------------------------------------
    # If the bbox centroid lands on a known interactive element from the a11y
    # tree, boost confidence. This handles edge cases where Claude is "almost
    # sure" (0.65) but the centroid lands exactly on a known element — we can
    # safely push it above the 0.70 threshold used by VisionStrategy.
    # -----------------------------------------------------------------------
    @staticmethod
    def _postprocess(
        response: VisionLocateResponse,
        request: VisionLocateRequest,
    ) -> VisionLocateResponse:
        if (
            not response.found
            or not response.bounding_box
            or not request.a11y_tree
        ):
            return response

        bb = response.bounding_box
        cx = bb.x + bb.width / 2
        cy = bb.y + bb.height / 2

        for node in request.a11y_tree:
            if not node.bounding_box:
                continue
            nb = node.bounding_box
            if (
                nb["x"] <= cx <= nb["x"] + nb["width"]
                and nb["y"] <= cy <= nb["y"] + nb["height"]
            ):
                # Centroid confirmed on a known interactive element
                if response.confidence is not None and response.confidence < 0.85:
                    response.confidence = min(response.confidence + 0.1, 0.95)
                node_name = node.name or "(unnamed)"
                response.reasoning = (
                    f"{response.reasoning or ''} "
                    f"[Post-process: centroid confirmed on a11y node "
                    f'role={node.role}, name="{node_name}"]'
                ).strip()
                break

        return response

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
