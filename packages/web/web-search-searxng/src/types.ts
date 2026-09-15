/**
 * Wire types for the SearXNG search API (`GET {baseURL}/search?q=…&format=json`).
 * Types only — no runtime code. SearXNG is a free, self-hostable metasearch
 * engine; the JSON format returns a flat `results[]` where each entry carries a
 * URL, title, and a `content` snippet (plus engine metadata). No API key is
 * required, which makes this the free replacement for keyed providers.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's flat `results[]`. */
export interface SearxngResult {
  url: string
  title?: string
  content?: string
  engine?: string
  publishedDate?: string | null
}

/** SearXNG's JSON search response envelope. */
export interface SearxngSearchResponse {
  results?: SearxngResult[]
  /** Count of results the engine would return without pagination. */
  number_of_results?: number
  query?: string
}

/** SearXNG's error response envelope (best-effort; fields vary by instance). */
export interface SearxngError {
  error?: string
  message?: string
}
