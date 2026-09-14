/**
 * `ResponsesSearchProvider`: a `WebSearchProvider` backed by an OpenAI-compatible
 * Responses API (`POST {baseURL}/responses`) with the server-side `web_search`
 * tool. The gateway (any OpenAI-compatible relay that supports the Responses
 * format — e.g. a custom model gateway) performs the live web search and returns
 * a generated answer plus the pages it opened, which map to `content` and
 * `sources`. This is what lets a custom (non-DeepSeek-official) model endpoint
 * still power the harness's `web_search` tool with real internet access.
 * @module @deepseek-ai/dsh-web-search-responses/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  ResponsesError,
  ResponsesMessage,
  ResponsesOutputItem,
  ResponsesSearchResponse,
  ResponsesWebSearchCall,
} from './types.ts'

/** Stable id this provider registers under. */
export const RESPONSES_PROVIDER_ID = 'responses'

/** Default endpoint base: the same gateway the LLM chat route uses, `/responses` appended. */
export const RESPONSES_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/** Default model name sent on the Responses request. */
export const RESPONSES_DEFAULT_MODEL = 'deepseek-v4-flash'

/** Default upper bound on generated tokens for the Responses request. */
export const RESPONSES_DEFAULT_MAX_TOKENS = 4096

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ResponsesSearchProviderOptions {
  /** API key for the gateway. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/responses` is appended. */
  baseURL: string
  /** Model name sent on the Responses request. */
  model: string
  /** Upper bound on generated tokens. */
  maxTokens: number
}

/**
 * Extract citeable sources from the response: every `open_page` URL the search
 * actually visited, in visit order, deduped, with the gateway's `#ws_call_id=`
 * tracking fragment stripped. Queries alone carry no URL and are skipped.
 *
 * @param output - the response `output[]` items.
 * @returns the deduped, fragment-stripped sources.
 */
export function sourcesFromOutput(output: readonly ResponsesOutputItem[]): WebSearchSource[] {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of output) {
    if (item.type !== 'web_search_call') continue
    const call = item as ResponsesWebSearchCall
    const url = call.action?.url
    if (typeof url !== 'string' || url.length === 0) continue
    const clean = stripTrackingFragment(url)
    if (clean.length === 0 || seen.has(clean)) continue
    seen.add(clean)
    sources.push({ url: clean })
  }
  return sources
}

/**
 * Concatenate the final `message` items' text into the generated answer.
 * Commentary messages (the model narrating its search) are included: the
 * harness `content` field is advisory context, and a coherent answer beats a
 * fragment.
 *
 * @param output - the response `output[]` items.
 * @returns the joined answer text, or `undefined` when no message item carried text.
 */
export function contentFromOutput(output: readonly ResponsesOutputItem[]): string | undefined {
  const parts: string[] = []
  for (const item of output) {
    if (item.type !== 'message') continue
    for (const block of (item as ResponsesMessage).content ?? []) {
      if (typeof block.text === 'string' && block.text.trim().length > 0) parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/**
 * Map a Responses search response to a normalized search result.
 *
 * @param response - the parsed `POST /responses` response body.
 * @returns the normalized result with visited-page sources and the generated
 *   answer as `content`.
 * @throws {@link WebError} when the search produced no visited page and no answer.
 */
export function mapResponsesResponse(response: ResponsesSearchResponse): WebSearchResult {
  const output = response.output ?? []
  const sources = sourcesFromOutput(output)
  const content = contentFromOutput(output)
  if (sources.length === 0 && content === undefined) {
    throw new WebError(
      'Responses search returned no web_search_call pages and no answer text; the endpoint may not support the web_search tool',
      'WEB_PROVIDER_ERROR',
    )
  }
  // The web service owns the final `maxResults` truncation, so this provider
  // reports `truncated: false`.
  return { sources, truncated: false, ...content !== undefined ? { content } : {} }
}

/** Strip a `#ws_call_id=...` tracking fragment from a gateway URL. */
function stripTrackingFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash >= 0 ? url.slice(0, hash) : url
}

/** The Responses-API-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ResponsesSearchProvider implements WebSearchProvider {
  readonly id = RESPONSES_PROVIDER_ID

  constructor(private readonly options: ResponsesSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && URL.canParse(this.options.baseURL)
      && isPositiveInteger(this.options.maxTokens)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const body = {
      model: this.options.model,
      input: `Perform a web search for the query: ${request.query}`,
      tools: [{ type: 'web_search' }],
      max_output_tokens: this.options.maxTokens,
    }
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/responses`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Responses search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Responses search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Responses search API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ResponsesError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('Responses search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as ResponsesSearchResponse
      return mapResponsesResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Responses search aborted', 'WEB_ABORTED', { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError(`Responses search returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True for a positive whole number. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
