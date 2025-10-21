"""High level collection orchestration."""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List

from .configuration import FETCHER_FACTORY, CollectorConfig, load_config
from .fetchers.base import Fetcher
from .fetchers.mock import MockFetcher
from .models import Post
from .storage import Storage


def _build_fetcher(config: CollectorConfig, platform: str) -> Fetcher:
    for entry in config.platforms:
        if entry.platform == platform:
            builder = FETCHER_FACTORY.get(entry.fetcher)
            if not builder:
                raise ValueError(f"Unsupported fetcher type: {entry.fetcher}")
            options = builder(entry.options)
            if entry.fetcher == "mock":
                return MockFetcher(platform=platform, config=options)
            raise ValueError(f"No fetcher implemented for type {entry.fetcher}")
    raise KeyError(f"Platform '{platform}' not found in configuration")


def collect_once(config_path: Path, storage_path: Path) -> List[Post]:
    """Collect data for all configured platforms and store them."""

    config = load_config(config_path)
    storage = Storage(storage_path)
    posts: List[Post] = []

    for entry in config.platforms:
        fetcher = _build_fetcher(config, entry.platform)
        platform_posts = list(fetcher.fetch())
        storage.save_posts(platform_posts)
        posts.extend(platform_posts)
    return posts


def collect_from_config(config_path: Path, storage_path: Path) -> Dict[str, List[Post]]:
    """Collect data and return posts grouped by platform."""

    posts = collect_once(config_path=config_path, storage_path=storage_path)
    grouped: Dict[str, List[Post]] = {}
    for post in posts:
        grouped.setdefault(post.platform, []).append(post)
    return grouped
