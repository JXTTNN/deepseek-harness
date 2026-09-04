/**
 * `SearxngSearchProvider`: a keyless `WebSearchProvider` backed by a SearXNG
 * metasearch instance's JSON API (`GET {baseURL}/search?q=…&format=json`). It
 * maps each result's `content` to `snippet` and `publishedDate` to
 * `publishedAt`, omitting `content` because SearXNG returns no generated
 * answer. Because SearXNG needs no API key, this provider is the free,
 * self-hostable replacement for keyed providers (Perplexity, Exa).
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngError, SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Default endpoint: a SearXNG instance's public root. No key is required, but
 * instances are self-hosted and rate-limited, so deployments should set
 * `baseURL` to their own instance.
 */
export const SEARXNG_DEFAULT_BASE_URL = 'https://searx.be'

/** Default number of results requested when a request carries no `maxResults`. */
export const SEARXNG_DEFAULT_NUM_RESULTS = 10

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface SearxngSearchProviderOptions {
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  numResults: number
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it carries
 * no portable URL or snippet (the seam has no other field to derive a snippet
 * from, and inventing one would lie).
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry is not portable.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  const snippet = result.content?.trim()
  if (result.url == null || result.url.length === 0 || snippet === undefined || snippet.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result.
 *
 * @param response - the parsed JSON search response body.
 * @returns the normalized result; non-portable entries are dropped
 *   ({@link mapSearxngResult}).
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // SearXNG returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL) && isPositiveInteger(this.options.numResults)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const numResults = request.maxResults ?? this.options.numResults
    // SearXNG's JSON format uses GET query parameters; encode the query and the
    // result count. `format=json` selects the machine-readable envelope.
    const url = new URL(`${this.options.baseURL}/search`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('pageno', '1')
    if (isPositiveInteger(numResults)) url.searchParams.set('count', String(numResults))

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG API error (HTTP ${status})`
      try {
        const parsed = await response.json() as SearxngError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a positive whole number. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
