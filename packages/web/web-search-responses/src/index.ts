/**
 * `@deepseek-ai/dsh-web-search-responses`: registers a `WebSearchProvider`
 * backed by an OpenAI-compatible Responses API (`POST /responses`) with the
 * server-side `web_search` tool. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * This is what lets a CUSTOM model gateway (any OpenAI-compatible relay that
 * supports the Responses format with the `web_search` tool) power the harness's
 * `web_search` tool with real internet access — no official DeepSearch key
 * required, no self-hosted SearXNG either.
 *
 * @module @deepseek-ai/dsh-web-search-responses
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ResponsesSearchProvider,
  RESPONSES_DEFAULT_BASE_URL,
  RESPONSES_DEFAULT_MAX_TOKENS,
  RESPONSES_DEFAULT_MODEL,
} from './provider.ts'

export {
  RESPONSES_DEFAULT_BASE_URL,
  RESPONSES_DEFAULT_MAX_TOKENS,
  RESPONSES_DEFAULT_MODEL,
  RESPONSES_PROVIDER_ID,
  ResponsesSearchProvider,
} from './provider.ts'
export type { ResponsesSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-responses'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** API key. Falls back to `$RESPONSES_API_KEY` then `$DEEPSEEK_API_KEY`. Empty → unavailable. */
  apiKey?: string
  /** Endpoint base; `/responses` is appended. Falls back to `$RESPONSES_BASE_URL` then `$DEEPSEEK_BASE_URL`. */
  baseURL?: string
  /** Model name sent on the Responses request. Falls back to `$RESPONSES_MODEL` then `deepseek-v4-flash`. */
  model?: string
  /** Upper bound on generated tokens. Must be a positive integer. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
})

/** Environment variable naming this provider's endpoint. */
const RESPONSES_BASE_URL_ENV = 'RESPONSES_BASE_URL'

/** Environment variable naming this provider's API key. */
const RESPONSES_API_KEY_ENV = 'RESPONSES_API_KEY'

/** Environment variable naming this provider's model. */
const RESPONSES_MODEL_ENV = 'RESPONSES_MODEL'

/** Register the Responses search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const env = launchEnvironmentOf(ctx)
  ctx.web.registerSearchProvider(new ResponsesSearchProvider({
    apiKey: config.apiKey
      ?? env.get(RESPONSES_API_KEY_ENV)?.value
      ?? env.get('DEEPSEEK_API_KEY')?.value
      ?? '',
    baseURL: config.baseURL
      ?? env.get(RESPONSES_BASE_URL_ENV)?.value
      ?? env.get('DEEPSEEK_BASE_URL')?.value
      ?? RESPONSES_DEFAULT_BASE_URL,
    model: config.model
      ?? env.get(RESPONSES_MODEL_ENV)?.value
      ?? RESPONSES_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? RESPONSES_DEFAULT_MAX_TOKENS,
  }))
}
