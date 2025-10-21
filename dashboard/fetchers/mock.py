"""Mock fetcher that reads data from JSON fixtures.

Useful for local development and unit tests."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Iterator, List

from .base import Fetcher
from ..models import Post


@dataclass
class MockFetcherConfig:
    """Configuration for :class:`MockFetcher`."""

    path: Path
    account: str


class MockFetcher(Fetcher):
    """Fetch posts using static JSON fixtures."""

    def __init__(self, platform: str, config: MockFetcherConfig) -> None:
        super().__init__(platform)
        self.config = config

    def fetch(self) -> Iterable[Post]:
        return list(self._iter_posts())

    def _iter_posts(self) -> Iterator[Post]:
        if not self.config.path.exists():
            raise FileNotFoundError(f"Mock data file not found: {self.config.path}")

        with self.config.path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)

        posts: List[Post] = []
        for row in payload:
            posts.append(
                Post(
                    platform=self.platform,
                    account=self.config.account,
                    post_id=row["post_id"],
                    published_at=datetime.fromisoformat(row["published_at"]),
                    title=row["title"],
                    url=row["url"],
                    metrics=row["metrics"],
                )
            )
        return iter(posts)
