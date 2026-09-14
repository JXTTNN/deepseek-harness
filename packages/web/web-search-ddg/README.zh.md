# @deepseek-ai/dsh-web-search-ddg

[English](README.md) | 中文

网页搜索能力无缝桥层的免密钥 DuckDuckGo HTML 搜索 provider（`ctx.web`）。

## 定位

以 `ddg` 的 id 注册一个 `WebSearchProvider`：请求 DuckDuckGo 公共 HTML 端点（`https://html.duckduckgo.com/html/?q=…`），解析 `result__a` 结果锚点（解码 `/l/?uddg=` 跳转包装）及其对应的 `result__snippet` 摘要，按统一的 `WebSearchResult` 契约返回。

**不需要 API key，也不需要自建实例** —— 因此它是与 `deepseek`/`responses`（需要密钥）和 `searxng`（自建）并列的零配置兜底。基础 bundle 默认仍用 `responses`；一行配置即可切到 `ddg`。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseURL` | `$DDG_BASE_URL`，否则 `https://html.duckduckgo.com/html/` | 端点地址；自动追加 `?q=…`。 |
| `numResults` | `10` | 结果上限；DDG 本身不支持数量参数，provider 本地截断。 |

## 模型体验

模型看到的是同一个 `web_search` 工具；provider 切换只影响结果质量与限频。DDG 在自动化场景下会激进限流，查询应保持稀疏。

## 已知限制与后续工作

- DDG 公共 HTML 端点限流凶猛、可能封 IP；provider 会如实抛出 HTTP 错误而不会静默兜底。高频部署请继续配置 SearXNG。
- 非结果类面板（知识框等）按设计不解析。
- 抓取正文抽取（Defuddle/readability）升级在 `tool-web` 下单独跟踪。
