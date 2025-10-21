from pathlib import Path

from dashboard.fetchers.mock import MockFetcher, MockFetcherConfig


def test_mock_fetcher_reads_fixture(tmp_path: Path) -> None:
    fixture = tmp_path / "data.json"
    fixture.write_text(
        """
        [
          {
            \"post_id\": \"1\",
            \"published_at\": \"2024-05-01T00:00:00\",
            \"title\": \"Hello\",
            \"url\": \"https://example.com/1\",
            \"metrics\": {\"views\": 10, \"likes\": 2, \"comments\": 1, \"shares\": 0}
          }
        ]
        """
    )

    fetcher = MockFetcher("test", MockFetcherConfig(path=fixture, account="账号"))
    posts = list(fetcher.fetch())

    assert len(posts) == 1
    assert posts[0].platform == "test"
    assert posts[0].metrics["views"] == 10
