"""Base fetcher definitions."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable

from ..models import Post


class Fetcher(ABC):
    """Abstract base class for platform-specific fetchers."""

    platform: str

    def __init__(self, platform: str) -> None:
        self.platform = platform

    @abstractmethod
    def fetch(self) -> Iterable[Post]:
        """Yield posts for the configured platform."""

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"{self.__class__.__name__}(platform={self.platform!r})"
