# @deepseek-ai/dsh-web-fetch-md

English | [中文](README.zh.md)

Registers a Markdown-converting [`WebFetchProvider`](../web) with `ctx.web`
under the id `md`. HTML responses run through Mozilla Readability
(`@mozilla/readability` on `linkedom`) and Turndown so the model receives the
article's title, byline, and body as compact Markdown instead of raw page
markup. Transport safety is entirely delegated to the wrapped
`HttpFetchProvider` (URL validation, same-origin redirects, byte caps,
timeouts); this package only changes representation.

## Model Experience

No browsing how-to or implicit prompt changes: the same `web_fetch` tool now
returns article text instead of page boilerplate. Pro: drastically fewer
wasted context tokens on news/docs pages and much higher fact signal density.
Con: pages whose information lives outside the article region (site chrome,
full-page scripts, cards) lose that content — the provider then *falls back*
to the raw body. KV-cache: identical repeat fetches stay cacheable; the
conversion is deterministic per body.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `maxMarkdownChars` | `50_000` | Cap on emitted Markdown (0 disables) |
| `includeByline` | `true` | Emit article author/date line |
| | | all transport limits of `dsh-web-fetch-http` are configurable here too |

## Prior art / upstreams

- Mozilla [readability](https://github.com/mozilla/readability) — the article extractor Firefox Reader Mode uses.
- [turndown](https://github.com/mixmark-io/turndown) — HTML→Markdown rendering.
- [linkedom](https://github.com/WebReflection/linkedom) — dependency-light DOM for Readability.

## Known Limitations and Deferred Work

- Anti-bot/JS-driven pages still cannot be extracted (same as `web-fetch-http`): use a browser-backed fetcher (e.g. the Playwright conductor subagent's runtime path) for those.
- Readability's quality heuristics are tuned for English article layout; table-centric pages (financials, schedules) may degrade to the raw body. Feeding extracted tables through SheetJS-style structuring is deferred.
