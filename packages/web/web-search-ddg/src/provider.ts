/**
 * `DdgSearchProvider`: a keyless `WebSearchProvider` backed by DuckDuckGo's
 * public HTML endpoint. It GETs `{baseURL}?q=…`, extracts `result__a`
 * anchors (decoding the `uddg` redirect wrapper), and reads the sibling
 * `result__snippet` text. Because DDG needs no API key this provider is the
 * zero-config fallback: mounted last in the base bundle so a deployment can
 * point `searchProvider: 'ddg'` at it with no credentials at all.
 * @module @deepseek-ai/dsh-web-search-ddg/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { DdgHtmlEntry } from './types.ts'

/** Stable id this provider registers under. */
export const DDG_PROVIDER_ID = 'ddg'

/**
 * Default endpoint: DuckDuckGo's HTML form. Public, keyless, rate-limited —
 * heavy deployments should still prefer their own SearXNG instance;
 * DDG is the safety net, not the fast path.
 */
export const DDG_DEFAULT_BASE_URL = 'https://html.duckduckgo.com/html/'

/** Default number of results requested when a request carries no `maxResults`. */
export const DDG_DEFAULT_NUM_RESULTS = 10

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeepSeekHarness/0.1 (+https://github.com/JXTTNN/deepseek-harness)'

/** Resolved provider options (the plugin's `apply` fills env-var and constant defaults). */
export interface DdgSearchProviderOptions {
  /** Endpoint base; `?q=…` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  numResults: number
}

/**
 * Decode one DDG result href. DDG wraps outbound links as
 * `//duckduckgo.com/l/?uddg=<percent-encoded url>&rut=…`; anything else
 * (look, I'm feeling Ducky links, direct HTTPS) passes through unchanged.
 *
 * @param href - the raw `href` attribute of a `result__a` anchor.
 * @returns the decoded outbound URL, or `undefined` when the wrapper's
 *   `uddg` parameter decodes to a non-HTTP(S) URL (never a silently
 *   wrong target).
 */
export function decodeDdgUrl(href: string): string | undefined {
  let target = href.trim()
  if (target.startsWith('//')) target = `https:${target}`
  if (target.includes('duckduckgo.com/l/')) {
    try {
      const uddg = new URL(target).searchParams.get('uddg')
      if (uddg === null) return undefined
      target = uddg
    } catch {
      return undefined
    }
  }
  if (!/^https?:\/\//.test(target)) return undefined
  return target
}

/** Strip HTML tags and collapse whitespace from a DDG snippet cell. */
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
}

/** Strip HTML tags from a title and decode the entities DDG puts there. */
function stripTitle(text: string): string {
  return stripHtml(text)
}

/**
 * Parse DDG's HTML body into raw entries. Splits on `result__a` anchors and
 * picks the next `result__snippet` after each; entries without those anchors
 * (ads, knowledge panels) are ignored.
 *
 * @param html - the endpoint's response body.
 * @returns the raw entries, in document order.
 */
export function parseDdgHtml(html: string): DdgHtmlEntry[] {
  const entries: DdgHtmlEntry[] = []
  const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
  let match: RegExpExecArray | null
  while ((match = anchorRe.exec(html)) !== null) {
    const title = stripTitle(match[2] ?? '')
    if (title.length === 0) continue
    const rest = html.slice(match.index + match[0].length, match.index + match[0].length + 4000)
    const snippetMatch = snippetRe.exec(rest)
    const snippetText = snippetMatch?.[1]
    const entry: DdgHtmlEntry = {
      href: match[1] ?? '',
      title,
      ...snippetText !== undefined ? { snippet: stripHtml(snippetText) } : {},
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Map one parsed entry to a normalized source, or `undefined` when the
 * target URL cannot be trusted (a search result without a URL is noise).
 *
 * @param entry - one {@link parseDdgHtml} entry.
 * @returns the normalized source, or `undefined` when the entry is unusable.
 */
export function mapDdgEntry(entry: DdgHtmlEntry): WebSearchSource | undefined {
  const url = decodeDdgUrl(entry.href)
  if (url === undefined) return undefined
  return {
    url,
    title: entry.title,
    ...entry.snippet !== undefined && entry.snippet.length > 0 ? { snippet: entry.snippet } : {},
  }
}

/**
 * Map a parsed entry list to a normalized search result.
 *
 * @param entries - the {@link parseDdgHtml} output.
 * @param numResults - the configured result cap, applied because DDG does not
 *   honor a count parameter on the HTML endpoint.
 * @returns the normalized result; DDG returns no generated answer, so
 *   `content` is omitted.
 */
export function mapDdgEntries(entries: DdgHtmlEntry[], numResults: number): WebSearchResult {
  const sources = entries
    .map(mapDdgEntry)
    .filter((source): source is WebSearchSource => source !== undefined)
    .slice(0, numResults)
  return { sources, truncated: sources.length === entries.length && entries.length > numResults }
}

/** The DuckDuckGo-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class DdgSearchProvider implements WebSearchProvider {
  readonly id = DDG_PROVIDER_ID

  constructor(private readonly options: DdgSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL) && isPositiveInteger(this.options.numResults)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const numResults = request.maxResults ?? this.options.numResults
    const url = new URL(this.options.baseURL)
    url.searchParams.set('q', request.query)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(`DuckDuckGo API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }

    try {
      const html = await response.text()
      return mapDdgEntries(parseDdgHtml(html), isPositiveInteger(numResults) ? numResults : this.options.numResults)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DuckDuckGo returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
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
