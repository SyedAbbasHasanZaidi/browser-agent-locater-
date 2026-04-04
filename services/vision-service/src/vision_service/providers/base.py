"""
AbstractVisionProvider — the Provider pattern contract.

Design Pattern: Provider (variant of Strategy)
-----------------------------------------------
Every vision backend (Claude, GPT-4V, future models) implements this one
abstract interface. The router handler receives an AbstractVisionProvider
injected via FastAPI dependency injection — it never imports ClaudeProvider
or OpenAIProvider directly.

This means:
  - Swapping providers = changing one dependency registration, zero router edits
  - Unit-testing the router = inject a MockProvider, no real API calls
  - Adding a new provider = subclass this, register it — no existing code changes

Data Flow:
  VisionRouter → AbstractVisionProvider.locate(request) → VisionLocateResponse
  The router is the consumer; the provider is the implementation detail.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from vision_service.models.requests import VisionLocateRequest
from vision_service.models.responses import VisionLocateResponse


class AbstractVisionProvider(ABC):
    """Base class for all vision model providers."""

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Short name used in health checks and trajectory logs, e.g. 'claude'."""
        ...

    @abstractmethod
    async def locate(self, request: VisionLocateRequest) -> VisionLocateResponse:
        """
        Given a screenshot + description, return the bounding box of the element.

        Implementations must:
          - Call the upstream vision API asynchronously
          - Parse the model's response into a VisionLocateResponse
          - Set found=False (not raise) when the model cannot find the element
          - Raise ProviderError for unrecoverable API failures (auth, rate limit)
          - Measure and populate latency_ms from their own wall-clock timing
        """
        ...


class ProviderError(Exception):
    """Raised when a vision provider encounters an unrecoverable error."""

    def __init__(self, provider: str, message: str) -> None:
        super().__init__(f"[{provider}] {message}")
        self.provider = provider
