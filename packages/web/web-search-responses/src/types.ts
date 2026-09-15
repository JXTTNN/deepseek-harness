/**
 * Wire types for the OpenAI Responses API (`POST {baseURL}/responses`) with the
 * server-side `web_search` tool. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-web-search-responses/types
 */

/** One `web_search_call` item of the response `output[]`. */
export interface ResponsesWebSearchCall {
  type: 'web_search_call'
  id?: string
  status?: string
  action?: {
    type?: 'search' | 'open_page'
    /** Present on `search` actions: the queries the model issued. */
    queries?: string[]
    /** Present on `open_page` actions: the URL opened (may carry a `#ws_call_id=` fragment). */
    url?: string
  }
}

/** One `message` item of the response `output[]`. */
export interface ResponsesMessage {
  type: 'message'
  id?: string
  status?: string
  role?: string
  content?: {
    type?: string
    text?: string
    annotations?: unknown[]
  }[]
}

/** Any item of the response `output[]`. */
export type ResponsesOutputItem = ResponsesWebSearchCall | ResponsesMessage | { type: string }

/** The Responses API envelope (only the fields this provider reads). */
export interface ResponsesSearchResponse {
  output?: ResponsesOutputItem[]
  error?: { message?: string } | string
}

/** The Responses API error body. */
export interface ResponsesError {
  error?: { message?: string; type?: string } | string
  message?: string
}
