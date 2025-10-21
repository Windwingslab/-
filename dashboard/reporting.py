"""Utilities to produce aggregated reports for dashboards."""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, Iterable, List

from .models import Post, merge_metrics, sort_posts


def build_summary_table(posts: Iterable[Post]) -> List[Dict[str, object]]:
    """Create a per-platform summary table suitable for dashboards."""

    grouped: Dict[str, List[Post]] = defaultdict(list)
    for post in posts:
        grouped[post.platform].append(post)

    summary: List[Dict[str, object]] = []
    for platform, platform_posts in grouped.items():
        metrics = merge_metrics(platform_posts)
        summary.append(
            {
                "platform": platform,
                "accounts": sorted({post.account for post in platform_posts}),
                "post_count": len(platform_posts),
                "metrics": metrics,
                "latest_posts": [
                    {
                        "post_id": post.post_id,
                        "title": post.title,
                        "url": post.url,
                        "published_at": post.published_at.isoformat(),
                        "metrics": post.metrics,
                    }
                    for post in sort_posts(platform_posts)[:5]
                ],
            }
        )
    return sorted(summary, key=lambda row: row["platform"])
