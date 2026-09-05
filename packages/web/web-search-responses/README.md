# @deepseek-ai/dsh-web-search-responses

English | [中文](README.zh.md)

A `WebSearchProvider` backed by an OpenAI-compatible **Responses API** (`POST /responses`) with the server-side `web_search` tool. The gateway performs the live web search server-side and returns a generated answer plus the pages it visited, which map to the seam's normalized `WebSearchResult` (`content` + `sources`).

This is what lets a **custom model gateway** (any OpenAI-compatible relay that supports the Responses format with the `web_search` tool — e.g. `https://your-gateway/v1`) power the harness `web_search` tool with real internet access: no official DeepSeek key, no self-hosted SearXNG, no paid Perplexity/Exa subscription.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). It is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$RESPONSES_API_KEY` then `$DEEPSEEK_API_KEY` | Gateway API key. Empty/absent makes the provider unavailable. |
| `baseURL` | `$RESPONSES_BASE_URL` then `$DEEPSEEK_BASE_URL` then `https://api.deepseek.com/v1` | Endpoint base; `/responses` is appended. An unparseable value makes the provider unavailable. |
| `model` | `$RESPONSES_MODEL` then `deepseek-v4-flash` | Model name sent on the Responses request. |
| `maxTokens` | `4096` | Upper bound on generated tokens (`max_output_tokens`). Must be a positive integer. |

```yaml
- id: web-search-responses
  name: '@deepseek-ai/dsh-web-search-responses'
  config:
    baseURL: https://your-gateway/v1
    apiKey: !!js process.env.RESPONSES_API_KEY
```

To make it the active search backend, also set the web seam's `searchProvider: responses`.

## Mapping

The Responses API returns an `output[]` of typed items. Every `web_search_call` item whose action is `open_page` contributes its URL (with the gateway's `#ws_call_id=…` tracking fragment stripped) as a `WebSearchSource`; duplicate URLs are deduped. The `message` items' text blocks are joined into `content` (the generated answer). `search`-only calls carry no URL and are skipped. When the response contains neither a visited page nor answer text, the provider fails as `WEB_PROVIDER_ERROR` (the endpoint likely does not support the `web_search` tool). Provider failures (HTTP errors, network failure, unparseable bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs and generated answer or its exact `Responses search aborted`, `Responses search request failed: <error>`, and `Responses search returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Sources carry URLs only** — the Responses `web_search_call` items do not expose per-page titles or snippets, so `title`/`snippet` stay unset (the tool renders `title ?? hostname(url)`).
- **Only `model`/`maxTokens` are exposed** — the Responses API's other controls (`search_context_size`, `user_location`, reasoning effort) wait on provider-neutral Service Definition fields.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`.
