import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { ResponsesSearchProvider, RESPONSES_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-responses'
import * as responsesPlugin from '@deepseek-ai/dsh-web-search-responses'
import { mapResponsesResponse, sourcesFromOutput, contentFromOutput } from '../src/provider.ts'

const options = { apiKey: 'resp-key', baseURL: 'https://gateway.test/v1', model: 'm', maxTokens: 4096 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Responses output mapping', () => {
  it('extracts visited open_page URLs as deduped, fragment-stripped sources', () => {
    const output = [
      { type: 'reasoning' },
      { type: 'web_search_call', action: { type: 'search', queries: ['q1'] } },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.test/x#ws_call_id=call_1' } },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.test/x#ws_call_id=call_2' } },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://b.test/y' } },
      { type: 'web_search_call', action: { type: 'open_page', url: '' } },
    ]
    expect(sourcesFromOutput(output)).toEqual([
      { url: 'https://a.test/x' },
      { url: 'https://b.test/y' },
    ])
  })

  it('joins message texts into content and skips empty blocks', () => {
    const output = [
      { type: 'message', content: [{ type: 'output_text', text: 'part one' }] },
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.test' } },
      { type: 'message', content: [{ type: 'output_text', text: '  ' }, { type: 'output_text', text: 'part two' }] },
    ]
    expect(contentFromOutput(output)).toBe('part one\n\npart two')
  })

  it('maps a full response to content + sources', () => {
    const result = mapResponsesResponse({
      output: [
        { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.test#ws_call_id=c' } },
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      ],
    })
    expect(result).toEqual({ sources: [{ url: 'https://a.test' }], truncated: false, content: 'answer' })
  })

  it('throws when neither a page nor an answer came back', () => {
    expect(() => mapResponsesResponse({ output: [{ type: 'reasoning' }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => mapResponsesResponse({}))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('ResponsesSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(new ResponsesSearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key and a parseable base URL', () => {
    expect(new ResponsesSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new ResponsesSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxTokens is not a positive integer', () => {
    expect(new ResponsesSearchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(new ResponsesSearchProvider({ ...options, maxTokens: 1.5 }).available()).toBe(false)
  })
})

describe('ResponsesSearchProvider request mapping', () => {
  it('sends model, input, web_search tool and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      output: [
        { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.test' } },
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await new ResponsesSearchProvider(options).search({ query: 'hello world' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gateway.test/v1/responses')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer resp-key')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm',
      input: 'Perform a web search for the query: hello world',
      tools: [{ type: 'web_search' }],
      max_output_tokens: 4096,
    })
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new ResponsesSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ResponsesSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'bad tool' } }, { status: 400 })))
    await expect(new ResponsesSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad tool' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new ResponsesSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Responses search API error (HTTP 502)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new ResponsesSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new ResponsesSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new ResponsesSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-search-responses plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      output: [
        { type: 'web_search_call', action: { type: 'open_page', url: 'https://a.test' } },
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      ],
    })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: RESPONSES_PROVIDER_ID })
    const fiber = await ctx.plugin(responsesPlugin, { apiKey: 'k', baseURL: 'https://g.test/v1' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in responsesPlugin).toBe(false)
  })
})
