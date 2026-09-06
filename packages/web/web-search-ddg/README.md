# @deepseek-ai/dsh-web-search-ddg

English | [中文](README.zh.md)

Keyless DuckDuckGo HTML search provider for the web search seam (`ctx.web`).

## What it is

Mounts one `WebSearchProvider` under the id `ddg` that queries DuckDuckGo's public HTML endpoint (`https://html.duckduckgo.com/html/?q=…`), parses `result__a` anchors (decoding the `/l/?uddg=` redirect wrapper) and sibling `result__snippet` cells, and returns them through the same `WebSearchResult` contract every other provider serves.

The provider needs **no API key and no self-hosted instance**, which makes it the zero-configuration fallback next to the keyed `deepseek`/`responses` providers and the self-hosted `searxng` provider. In the shipped base bundle the default `searchProvider` stays `responses`; switch it with a one-line config override.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `$DDG_BASE_URL`, else `https://html.duckduckgo.com/html/` | Endpoint base; `?q=…` is appended. |
| `numResults` | `10` | Result cap; DDG's HTML endpoint honors no count, so the provider truncates locally. |

## Model experience

The model sees the same `web_search` tool regardless of provider; only result quality and rate limits differ. DDG rate-limits aggressively under automation, so query bursts should be short.

## Known Limitations and Deferred Work

- Public DDG HTML is rate-limited and block-prone; the provider surfaces HTTP errors instead of masking them. High-volume setups should keep a SearXNG instance configured.
- Non-key info boxes (knowledge panels) are deliberately not parsed — only organic results.
- Fetch-side extraction upgrades (Defuddle/readability) are tracked separately under `tool-web`.
