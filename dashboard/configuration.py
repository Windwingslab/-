"""Configuration loader for the dashboard collector."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Mapping

try:
    import yaml  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - fallback for restricted environments
    from .utils import simple_yaml as yaml

from .fetchers.mock import MockFetcherConfig


@dataclass(slots=True)
class PlatformConfig:
    """Description of how to collect data for a platform."""

    platform: str
    fetcher: str
    options: Mapping[str, object]


@dataclass(slots=True)
class CollectorConfig:
    """Top level collector configuration."""

    platforms: List[PlatformConfig]

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "CollectorConfig":
        raw_platforms = payload.get("platforms", [])
        platforms = [
            PlatformConfig(
                platform=entry["name"],
                fetcher=entry["fetcher"],
                options=entry.get("options", {}),
            )
            for entry in raw_platforms
        ]
        return cls(platforms=platforms)


def load_config(path: Path) -> CollectorConfig:
    """Load the collector configuration from YAML."""

    with path.open("r", encoding="utf-8") as handle:
        payload = yaml.safe_load(handle)
    if not isinstance(payload, dict):  # pragma: no cover - defensive
        raise ValueError("Invalid configuration file")
    return CollectorConfig.from_dict(payload)


def build_mock_config(options: Mapping[str, object]) -> MockFetcherConfig:
    """Create a :class:`MockFetcherConfig` from options."""

    data_path = options.get("path")
    account = options.get("account")
    if not data_path or not account:
        raise ValueError("Mock fetcher requires 'path' and 'account' options")
    return MockFetcherConfig(path=Path(data_path), account=str(account))


FETCHER_FACTORY = {
    "mock": build_mock_config,
}
