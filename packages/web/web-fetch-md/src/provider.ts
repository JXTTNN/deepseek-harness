/**
 * `MarkdownFetchProvider`: a `WebFetchProvider` that wraps the plain HTTP
 * fetcher and converts HTML pages into article Markdown — the model reads
 * title plus body without nav, trackers, or ad chrome. Non-HTML bodies and
 * pages where extraction finds no article delegate to the raw representation
 * unchanged, so the provider never destroys information the plain fetcher
 * would have shown.
 * @module @deepseek-ai/dsh-web-fetch-md/provider
 */

import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, type HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

/** Stable id this provider registers under. */
export const MD_PROVIDER_ID = 'md'

/**
 * Limit bundle handed to the wrapped HTTP fetcher plus extraction settings of
 * the Markdown converter itself.
 */
export interface MarkdownFetchOptions {
  /** Transport and size limits for the wrapped HttpFetchProvider. */
  readonly http: HttpFetchLimits
  /** Character cap for the emitted Markdown body (0 disables the cap). */
  readonly maxMarkdownChars: number
  /** Fold `byline`/publ-date metadata into the emitted header block. */
  readonly includeByline: boolean
}

/** The extracted article succeeded; render it with the site title. */
function formatArticle(title: string, markdown: string, byline: string | undefined, includeByline: boolean): string {
  const head = title.length > 0 ? `# ${title}\n\n` : ''
  const by = includeByline && byline !== undefined && byline.length > 0 ? `${byline}\n\n` : ''
  return `${head}${by}${markdown.trim()}\n`
}

/**
 * Convert an HTML document into Markdown using Readability's article
 * extraction. Returns `undefined` when Readability finds no article (search
 * result pages, thin stubs) so the caller can fall back to the raw body
 * instead of emitting an empty document.
 *
 * @param html - the decoded HTML body.
 * @param url - the final URL, so relative article links resolve absolutely.
 * @param turns - the configured Turndown service instance (shared: it is stateless after construction).
 * @param options - rendered-content limits and header policy.
 * @returns the Markdown conversion, or `undefined` when no article extracted.
 */
export function htmlToMarkdown(
  html: string,
  url: string,
  turns: TurndownService,
  options: Pick<MarkdownFetchOptions, 'maxMarkdownChars' | 'includeByline'>,
): string | undefined {
  const { document } = parseHTML(html)
  try {
    document.head.appendChild(parseHTML(`<base href="${url.replace(/"/g, '&quot;')}">`).document.head.firstElementChild as Element)
  } catch {
    // A base tag that linkedom cannot attach only breaks link resolution; the
    // body extraction below still stands, so continue without it.
  }
  const article = new Readability(document).parse()
  const content = article?.content ?? ''
  if (article === null || content.trim().length === 0) return undefined
  const markdown = turns.turndown(content)
  const body = formatArticle((article.title ?? '').trim(), markdown, article.byline ?? undefined, options.includeByline)
  if (options.maxMarkdownChars > 0 && body.length > options.maxMarkdownChars) {
    return `${body.slice(0, options.maxMarkdownChars)}\n\n…[truncated at ${options.maxMarkdownChars} chars]\n`
  }
  return body
}

/**
 * Fetch provider emitting article Markdown for HTML responses. All transport
 * safety properties (URL validation, same-origin redirects, byte caps,
 * timeouts) come from the wrapped HttpFetchProvider; conversion adds nothing
 * to the wire surface.
 */
export class MarkdownFetchProvider implements WebFetchProvider {
  readonly id = MD_PROVIDER_ID
  private readonly inner: WebFetchProvider
  private readonly turndown: TurndownService

  constructor(private readonly options: MarkdownFetchOptions, inner?: WebFetchProvider) {
    // The default raw transport is the plain HTTP fetcher; deployments may
    // inject any other provider (e.g. one backed by a rendering proxy).
    this.inner = inner ?? new HttpFetchProvider(options.http)
    this.turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    this.turndown.remove(['script', 'style', 'noscript'])
  }

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const raw = await this.inner.fetch(request, signal)
    const markdown = maybeConvert(raw, request.url, this.turndown, this.options)
    return markdown ?? raw
  }
}

/**
 * Try converting one raw fetch result. Returns `undefined` for non-HTML
 * bodies, failed article extraction, or conversion errors — anything so the
 * caller serves the original body instead of failing a read that succeeded.
 */
function maybeConvert(
  raw: WebFetchResult,
  requestUrl: string,
  turns: TurndownService,
  options: MarkdownFetchOptions,
): WebFetchResult | undefined {
  const body: WebFetchBody = raw.body
  if (body.kind !== 'html') return undefined
  try {
    const markdown = htmlToMarkdown(body.content, raw.url || requestUrl, turns, options)
    if (markdown === undefined) return undefined
    return { ...raw, body: { kind: 'text', content: markdown } }
  } catch {
    // A pathological document that breaks the DOM/Readability pipeline falls
    // back to the raw HTML body rather than failing the whole fetch.
    return undefined
  }
}
