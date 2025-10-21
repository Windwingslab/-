"""Persistence layer for collected posts."""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Iterable, List

from .models import Post


SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    platform TEXT NOT NULL,
    account TEXT NOT NULL,
    post_id TEXT NOT NULL,
    published_at TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    metrics TEXT NOT NULL,
    PRIMARY KEY (platform, post_id)
);
"""


class Storage:
    """Simple SQLite-based storage for posts."""

    def __init__(self, path: Path) -> None:
        self.path = path
        if self.path.parent and not self.path.parent.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute(SCHEMA)

    def save_posts(self, posts: Iterable[Post]) -> None:
        with sqlite3.connect(self.path) as conn:
            for post in posts:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO posts (
                        platform, account, post_id, published_at, title, url, metrics
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        post.platform,
                        post.account,
                        post.post_id,
                        post.published_at.isoformat(),
                        post.title,
                        post.url,
                        json_dumps(post.metrics),
                    ),
                )
            conn.commit()

    def load_posts(self) -> List[Post]:
        with sqlite3.connect(self.path) as conn:
            cursor = conn.execute(
                "SELECT platform, account, post_id, published_at, title, url, metrics FROM posts"
            )
            rows = cursor.fetchall()

        posts: List[Post] = []
        for platform, account, post_id, published_at, title, url, metrics in rows:
            posts.append(
                Post(
                    platform=platform,
                    account=account,
                    post_id=post_id,
                    published_at=datetime.fromisoformat(published_at),
                    title=title,
                    url=url,
                    metrics=json_loads(metrics),
                )
            )
        return posts


def json_dumps(payload: dict) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False)


def json_loads(data: str) -> dict:
    import json

    return json.loads(data)
