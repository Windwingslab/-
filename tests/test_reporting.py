from datetime import datetime

from dashboard.models import Post
from dashboard.reporting import build_summary_table


def make_post(platform: str, account: str, post_id: str, views: int, published: str) -> Post:
    return Post(
        platform=platform,
        account=account,
        post_id=post_id,
        title=f"Post {post_id}",
        url=f"https://example.com/{post_id}",
        metrics={"views": views, "likes": views // 10, "comments": views // 20, "shares": 0},
        published_at=datetime.fromisoformat(published),
    )


def test_build_summary_table() -> None:
    posts = [
        make_post("douyin", "账号A", "1", 100, "2024-05-01T00:00:00"),
        make_post("douyin", "账号A", "2", 50, "2024-05-02T00:00:00"),
        make_post("kuaishou", "账号B", "3", 70, "2024-05-03T00:00:00"),
    ]

    summary = build_summary_table(posts)

    assert summary[0]["platform"] == "douyin"
    assert summary[0]["metrics"]["views"] == 150
    assert summary[1]["post_count"] == 1
    assert summary[0]["latest_posts"][0]["post_id"] == "2"
