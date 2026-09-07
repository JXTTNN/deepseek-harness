# @deepseek-ai/dsh-web-fetch-md

[English](README.md) | 中文

向 `ctx.web` 注册一个把 HTML 转成 Markdown 的 [`WebFetchProvider`](../web)
（provider id: `md`）。HTML 响应先经 Mozilla Readability（基于 linkedom
DOM）抽取出文章主体，再由 Turndown 渲染成紧凑 Markdown：模型读到的是
正文与署名，而不是导航、跟踪脚本和页脚。传输安全（URL 校验、同源重定向、
字节上限、超时）仍完全委托被包裹的 `HttpFetchProvider`；本包只改表述。

## 模型体验

不改动浏览说明与系统提示：`web_fetch` 工具原样返回来源，只是现在 HTML
页面向模型交付"正文"+标题而不是样板噪声。优点：资讯/文档类的上下文
token 大幅减少、事实密度显著提升。缺点：信息藏在正文区外（站内脚本、卡
片面板）的页面会丢这块内容——此时 provider 会回退到原始 body。KV 缓存
不受影响：同一 URL 的重复抓取保持幂等。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxMarkdownChars` | `50_000` | 输出的 Markdown 字符上限（0 表示不收） |
| `includeByline` | `true` | 是否输出文章署名/日期行 |
| | | `dsh-web-fetch-http` 的所有传输限制在这里同样可配 |

## 上游与本包借鉴

- Mozilla [readability](https://github.com/mozilla/readability) — Firefox 阅读器模式的正文抽取器。
- [turndown](https://github.com/mixmark-io/turndown) — HTML → Markdown 渲染。
- [linkedom](https://github.com/WebReflection/linkedom) — 轻量 DOM，让 Readability 不依赖 jsdom。

## 已知限制与暂缓项

- 反爬/依赖 JS 渲染的页面仍抽不出（与 `web-fetch-http` 相同）；此类页面应交给浏览器型 fetcher（如 conductor 子代理路径）。
- Readability 的启发式偏英文文章版面；表格密集页面（财经表、排程）可能退化为原始 body。把抽出的表格再走 SheetJS 类结构化是后续事项。
