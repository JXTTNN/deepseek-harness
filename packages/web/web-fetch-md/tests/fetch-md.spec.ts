import type { WebFetchProvider, WebFetchResult } from '@deepseek-ai/dsh-web'
import {
  htmlToMarkdown,
  MarkdownFetchProvider,
  MD_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-fetch-md'
import type { MarkdownFetchOptions } from '@deepseek-ai/dsh-web-fetch-md'
import { describe, expect, it } from 'vitest'
import TurndownService from 'turndown'

/** A richer-than-Readability floor page whose article body is identifiable. */
const PAGE_HTML = `<!doctype html><html><head><title>Cable News</title></head><body>
<nav>Home Section Foo Bar fo bazz</nav>
<header><h1>Flood monitors revived</h1><div class="byline">By River Bureau</div></header>
<article><p>The catchment office restarted two hundred river gauges after seven silent years, restoring the public alert feed that township dashboards read overnight.</p>
<p>Each gauge now posts height and flow every ten minutes; the legacy hourly roll-up remains available under the archive path while users migrate.</p>
<p>Residents downstream asked aloud whether alerts would reach handsets faster, and the office pointed at the RSS mirror during the migration window.</p>
<p>Historians welcomed the restored series because the missing years would have broken flood-frequency curves that crews use to size culverts and canals.</p></article>
<footer>Copyright Fixtures Daily</footer></body></html>`

const LINES = 'Line of narrative text repeated so the page body bulk matters. '.repeat(20)

/** `options` packed with a varying maxMarkdownChars only. */
function opts(over: Partial<MarkdownFetchOptions> = {}): MarkdownFetchOptions {
  return {
    http: {
      maxUrlLength: 2048,
      maxResponseBytes: 5_000_000,
      maxBodyChars: 500_000,
      timeoutMs: 30_000,
      maxRedirects: 5,
      userAgent: 'fixture-marker/0',
    },
    maxMarkdownChars: 50_000,
    includeByline: true,
    ...over,
  }
}

/** Fresh Turndown instance in the same configuration the provider builds. */
function turns(): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  service.remove(['script', 'style', 'noscript'])
  return service
}

/** Fake inner fetcher returning a canned result. */
function fakeInner(result: WebFetchResult): WebFetchProvider {
  return {
    id: 'fake-i',
    available: () => true,
    fetch: () => Promise.resolve(result),
  }
}

describe('htmlToMarkdown conversion', () => {
  it('extracts the article and formats title, byline, and body', () => {
    const out = htmlToMarkdown(PAGE_HTML, 'https://fixture.test/opinion', turns(), opts())
    expect(out).toBeDefined()
    expect(out).toContain('river gauges')
    // Readability picks <title> or <h1> as its heading depending on page
    // structure; either way the page's chrome must not survive.
    expect(/Cable News|Flood monitors revived/.test(out!)).toBe(true)
    expect(out).toContain('By River Bureau')
    expect(out).not.toContain('Copyright Fixtures Daily')
  })

  it('returns undefined when no article can be extracted', () => {
    const out = htmlToMarkdown('<html><body></body></html>', 'https://fixture.test/empty', turns(), opts())
    expect(out).toBeUndefined()
  })

  it('applies the Markdown character cap with an explicit marker', () => {
    const big = `<html><head><title>Bulk</title></head><body><div><p>${LINES.repeat(8)}</p></div></body></html>`
    const out = htmlToMarkdown(big, 'https://fixture.test/bulk', turns(), opts({ maxMarkdownChars: 200 }))
    expect(out).toBeDefined()
    expect(out!.includes('[truncated at 200 chars]')).toBe(true)
  })

  it('omits the byline line when includeByline is false', () => {
    const out = htmlToMarkdown(PAGE_HTML, 'https://fixture.test/opinion', turns(), opts({ includeByline: false }))
    expect(out).toBeDefined()
    expect(out).not.toContain('By River Bureau')
  })
})

describe('MarkdownFetchProvider', () => {
  it('exposes the stable provider id and is always available', () => {
    const p = new MarkdownFetchProvider(opts())
    expect(p.id).toBe(MD_PROVIDER_ID)
    expect(MD_PROVIDER_ID).toBe('md')
    expect(p.available()).toBe(true)
  })

  it('converts an HTML body into Markdown while keeping the result envelope', async () => {
    const raw: WebFetchResult = {
      url: 'https://fixture.test/final',
      statusCode: 200,
      body: { kind: 'html', content: PAGE_HTML },
      truncated: false,
    }
    const p = new MarkdownFetchProvider(opts(), fakeInner(raw))
    const out = await p.fetch({ url: 'https://fixture.test/original' })
    expect(out.url).toBe('https://fixture.test/final')
    expect(out.body.kind).toBe('text')
    if (out.body.kind === 'text') {
      expect(out.body.content).toContain('river gauges')
    }
    expect(out.truncated).toBe(false)
  })

  it('passes non-HTML bodies through untouched', async () => {
    const raw: WebFetchResult = {
      url: 'https://fixture.test/data.json',
      statusCode: 200,
      body: { kind: 'text', content: '{"ok":true}' },
      truncated: false,
    }
    const p = new MarkdownFetchProvider(opts(), fakeInner(raw))
    const out = await p.fetch({ url: 'https://fixture.test/data.json' })
    expect(out).toEqual(raw)
  })

  it('falls back to the raw body when article extraction finds nothing', async () => {
    const raw: WebFetchResult = {
      url: 'https://fixture.test/empty',
      statusCode: 200,
      body: { kind: 'html', content: '<html></html>' },
      truncated: false,
    }
    const p = new MarkdownFetchProvider(opts(), fakeInner(raw))
    const out = await p.fetch({ url: 'https://fixture.test/empty' })
    expect(out.body.kind).toBe('html')
  })

  it('propagates inner errors unchanged', async () => {
    const boom = new Error('nope')
    const inner: WebFetchProvider = {
      id: 'thunder',
      available: () => true,
      fetch: () => Promise.reject(boom),
    }
    const p = new MarkdownFetchProvider(opts(), inner)
    await expect(p.fetch({ url: 'https://fixture.test/x' })).rejects.toBe(boom)
  })
})
