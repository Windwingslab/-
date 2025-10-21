"""Core data models for the dashboard collector."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterable, List


@dataclass(slots=True)
class Post:
    """Represents a single social media post and its metrics."""

    platform: str
    account: str
    post_id: str
    published_at: datetime
    title: str
    url: str
    metrics: Dict[str, int]

    def with_platform(self, platform: str) -> "Post":
        """Return a copy with the platform field overridden."""
        return Post(
            platform=platform,
            account=self.account,
            post_id=self.post_id,
            published_at=self.published_at,
            title=self.title,
            url=self.url,
            metrics=self.metrics,
        )


def merge_metrics(posts: Iterable[Post]) -> Dict[str, int]:
    """Aggregate numeric metrics across posts.

    Parameters
    ----------
    posts:
        Iterable of :class:`Post` objects.

    Returns
    -------
    Dict[str, int]
        Mapping from metric name to aggregated value.
    """

    aggregate: Dict[str, int] = {}
    for post in posts:
        for key, value in post.metrics.items():
            aggregate[key] = aggregate.get(key, 0) + int(value)
    return aggregate


def sort_posts(posts: Iterable[Post]) -> List[Post]:
    """Return posts sorted by publish time descending."""

    return sorted(posts, key=lambda post: post.published_at, reverse=True)
