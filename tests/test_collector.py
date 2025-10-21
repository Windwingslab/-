from pathlib import Path

from dashboard.collector import collect_from_config


def test_collect_from_config(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    config_path = tmp_path / "config.yaml"

    (data_dir / "douyin.json").write_text(
        """
        [
          {
            \"post_id\": \"1\",
            \"published_at\": \"2024-05-01T10:00:00\",
            \"title\": \"A\",
            \"url\": \"https://douyin.test/1\",
            \"metrics\": {\"views\": 100, \"likes\": 10, \"comments\": 5, \"shares\": 1}
          }
        ]
        """
    )
    (data_dir / "kuaishou.json").write_text(
        """
        [
          {
            \"post_id\": \"2\",
            \"published_at\": \"2024-05-02T10:00:00\",
            \"title\": \"B\",
            \"url\": \"https://kuaishou.test/2\",
            \"metrics\": {\"views\": 50, \"likes\": 5, \"comments\": 2, \"shares\": 0}
          }
        ]
        """
    )

    config_path.write_text(
        f"""
        platforms:
          - name: douyin
            fetcher: mock
            options:
              account: '账号1'
              path: '{(data_dir / "douyin.json").as_posix()}'
          - name: kuaishou
            fetcher: mock
            options:
              account: '账号2'
              path: '{(data_dir / "kuaishou.json").as_posix()}'
        """
    )

    storage_path = tmp_path / "storage.sqlite"
    grouped = collect_from_config(config_path=config_path, storage_path=storage_path)

    assert set(grouped.keys()) == {"douyin", "kuaishou"}
    assert grouped["douyin"][0].metrics["views"] == 100
    assert storage_path.exists()
