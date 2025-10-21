"""Dashboard package exposing collectors and fetchers."""

from .collector import collect_once
from .reporting import build_summary_table

__all__ = ["collect_once", "build_summary_table"]
