import { afterEach, describe, expect, it, vi } from 'vitest'
import { DdgSearchProvider } from '@deepseek-ai/dsh-web-search-ddg'
import { decodeDdgUrl, mapDdgEntries, mapDdgEntry, parseDdgHtml } from '../src/provider.ts'

const options = { baseURL: 'https://ddg.test/', numResults: 10 }

const HTML_FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2Fpage&rut=deadbeef">Alpha — the first result</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2Fpage">First &amp; best snippet text.</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://beta.example/direct">Beta direct link</a>
  </h2>
  <a class="result__snippet" href="https://beta.example/direct">Second snippet.</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=not-a-url&rut=x">Ugly wrapped link</a>
  </h2>
</div>
`

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decodeDdgUrl', () => {
  it('unwraps the /l/?uddg redirect wrapper', () => {
    expect(decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2Fpage&rut=deadbeef'))
      .toBe('https://alpha.example/page')
  })

  it('passes direct https links through', () => {
    expect(decodeDdgUrl('https://beta.example/direct')).toBe('https://beta.example/direct')
    expect(decodeDdgUrl('//beta.example/direct')).toBe('https://beta.example/direct')
  })

  it('rejects non-http schemes and unparseable wrappers', () => {
    expect(decodeDdgUrl('javascript:alert(1)')).toBeUndefined()
    expect(decodeDdgUrl('//duckduckgo.com/l/?uddg=not-a-url')).toBeUndefined()
    expect(decodeDdgUrl('//duckduckgo.com/l/?other=x')).toBeUndefined()
  })
})

describe('parseDdgHtml', () => {
  it('extracts anchors and sibling snippets in document order', () => {
    const entries = parseDdgHtml(HTML_FIXTURE)
    const first = entries[0]
    const second = entries[1]
    if (first === undefined || second === undefined || entries.length !== 3) {
      throw new Error('fixture must parse exactly three entries')
    }
    expect(first.title).toBe('Alpha — the first result')
    expect(first.snippet).toBe('First & best snippet text.')
    expect(second.title).toBe('Beta direct link')
    expect(second.snippet).toBe('Second snippet.')
  })

  it('returns an empty list on a no-results body', () => {
    expect(parseDdgHtml('<html><body>No results.</body></html>')).toEqual([])
  })
})

describe('mapDdgEntry / mapDdgEntries', () => {
  it('maps a wrapped entry to its decoded source', () => {
    const first = parseDdgHtml(HTML_FIXTURE)[0]
    if (first === undefined) throw new Error('fixture must parse at least one entry')
    expect(mapDdgEntry(first)).toEqual({
      url: 'https://alpha.example/page',
      title: 'Alpha — the first result',
      snippet: 'First & best snippet text.',
    })
  })

  it('drops entries whose target cannot be trusted', () => {
    expect(mapDdgEntry({ href: '//duckduckgo.com/l/?uddg=not-a-url', title: 'x' })).toBeUndefined()
    const result = mapDdgEntries(parseDdgHtml(HTML_FIXTURE), 10)
    expect(result.sources.map(s => s.url)).toEqual(['https://alpha.example/page', 'https://beta.example/direct'])
    expect(result.content).toBeUndefined()
  })

  it('caps sources at numResults', () => {
    const result = mapDdgEntries(parseDdgHtml(HTML_FIXTURE), 1)
    expect(result.sources).toHaveLength(1)
  })
})

describe('DdgSearchProvider', () => {
  it('is available with the keyless default', () => {
    expect(new DdgSearchProvider(options).available()).toBe(true)
    expect(new DdgSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('GETs the endpoint with q and maps the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(HTML_FIXTURE))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new DdgSearchProvider(options)
    const result = await provider.search({ query: 'alpha test' })
    const firstCall = fetchMock.mock.calls[0]
    if (firstCall === undefined) throw new Error('fetch must be called once')
    const called = firstCall[0] as URL
    expect(String(called)).toContain('q=alpha+test')
    expect(result.sources.map(s => s.url)).toEqual(['https://alpha.example/page', 'https://beta.example/direct'])
  })

  it('fails with WEB_PROVIDER_ERROR on a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse('boom', 502)))
    await expect(new DdgSearchProvider(options).search({ query: 'x' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('surfaces aborts as WEB_ABORTED', async () => {
    const abortErr = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr))
    await expect(new DdgSearchProvider(options).search({ query: 'x' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
