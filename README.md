# 内容看板数据采集系统

该项目提供一个可扩展的数据抓取与聚合框架，帮助自媒体团队把抖音、快手等平台的内容数据集中到统一的内容看板中。默认实现了基于静态 JSON 文件的模拟抓取器，方便本地演示与后续扩展真实平台接口。

## 功能特点

- **插件化采集器**：通过 `Fetcher` 抽象轻松扩展更多平台。
- **配置驱动**：使用 YAML 文件配置账号、抓取方式及数据源。
- **SQLite 存储**：将抓取结果保存到本地数据库，便于留档和二次分析。
- **汇总报表**：生成每个平台的总览指标与最近内容列表，可直接用于内容看板展示。

## 快速开始

1. 创建 Python 虚拟环境并安装依赖：

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -e .[dev]
   ```

2. 修改 `config/example.yaml`，将 `account`、`path` 等信息替换为自己的数据源。配置文件采用简易 YAML 语法，环境受限时内置解析器即可完成读取。

3. 执行采集并输出汇总信息：

   ```bash
   python scripts/collect.py config/example.yaml --storage data/metrics.sqlite
   ```

   命令将读取配置中的各个平台，抓取内容后写入 `data/metrics.sqlite`，并在终端打印汇总表。

## 项目结构

```
├── dashboard/
│   ├── collector.py        # 采集流程 orchestration
│   ├── configuration.py    # YAML 配置解析
│   ├── fetchers/           # 各类平台抓取器
│   ├── models.py           # 数据模型定义
│   ├── reporting.py        # 汇总报表工具
│   └── storage.py          # SQLite 存储实现
├── config/example.yaml     # 示例配置
├── data/                   # 示例数据
├── scripts/collect.py      # 命令行入口
└── tests/                  # Pytest 单元测试
```

## 扩展真实平台

1. 实现新的抓取器（例如 `dashboard/fetchers/douyin.py`），继承自 `Fetcher`。
2. 在 `dashboard/configuration.py` 的 `FETCHER_FACTORY` 中注册新的配置构建函数。
3. 在 YAML 配置里引用新抓取器，并补充所需鉴权信息。

通过以上步骤，即可逐步将真实平台的接口或网页抓取逻辑接入，打造属于自己的跨平台内容看板。
