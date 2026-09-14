# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

A keyless [SearXNG](https://docs.searxng.org)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls a SearXNG instance's JSON API (`GET /search?q=…&format=json`) and maps the flat `results[]` into the seam's normalized `WebSearchResult`. SearXNG is a free, self-hostable metasearch engine, so this provider needs **no API key** — the free replacement for keyed providers (Perplexity, Exa).

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `https://searx.be` | Endpoint base; `/search` is appended. Point this at your own SearXNG instance — public instances are rate-limited. Overridable via `$SEARXNG_BASE_URL`. An unparseable value makes the provider unavailable. |
| `numResults` | `10` | Default result count when a request carries no `maxResults`. Must be a positive integer. |

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: https://searx.example.org
```

## Mapping

SearXNG returns a flat `results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← the trimmed `content` field (a result with no non-blank content has no portable snippet and is dropped), `publishedAt` ← `publishedDate`. A request's `maxResults` wins over the configured `numResults` default and is sent as SearXNG's `count` for a cost/latency optimization; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, and `SearXNG returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Public instances are rate-limited and can be slow/unavailable** — deploy your own SearXNG and set `baseURL` for production use.
- **A result with no non-blank `content` is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `numResults` is exposed** — SearXNG's other controls (engines, categories, time range, language, safesearch) wait on provider-neutral Service Definition fields.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason surfaces as `WEB_PROVIDER_ERROR`.
