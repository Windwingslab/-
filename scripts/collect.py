"""CLI entry point to collect data and print a summary dashboard."""
from __future__ import annotations

import argparse
from pathlib import Path

from dashboard.collector import collect_once
from dashboard.reporting import build_summary_table


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect social media metrics and summarise them")
    parser.add_argument("config", type=Path, help="Path to the YAML configuration file")
    parser.add_argument(
        "--storage",
        type=Path,
        default=Path("data/metrics.sqlite"),
        help="Path to the SQLite database file",
    )
    args = parser.parse_args()

    posts = collect_once(config_path=args.config, storage_path=args.storage)
    summary = build_summary_table(posts)

    for row in summary:
        print(f"平台: {row['platform']}")
        print(f"  账号: {', '.join(row['accounts'])}")
        print(f"  内容数量: {row['post_count']}")
        print("  指标:")
        for key, value in row["metrics"].items():
            print(f"    - {key}: {value}")
        print("  最新内容:")
        for post in row["latest_posts"]:
            print(
                "    - {title} ({published_at}) → {url}".format(
                    title=post["title"],
                    published_at=post["published_at"],
                    url=post["url"],
                )
            )
        print()


if __name__ == "__main__":  # pragma: no cover
    main()
