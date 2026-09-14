/**
 * `@deepseek-ai/dsh-web-search-searxng`: registers a keyless SearXNG-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`. The key
 * is owned by `@deepseek-ai/dsh-web`.
 *
 * SearXNG is a free, self-hostable metasearch engine, so this provider needs no
 * API key — the free replacement for keyed providers.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  SearxngSearchProvider,
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_NUM_RESULTS,
} from './provider.ts'

export {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_NUM_RESULTS,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Endpoint base; `/search` is appended. Defaults to a public instance. */
  baseURL?: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  numResults: z.number().step(1).min(1),
})

/** Environment variable naming this provider's endpoint. */
const SEARXNG_BASE_URL_ENV = 'SEARXNG_BASE_URL'

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARXNG_BASE_URL_ENV)?.value
      ?? SEARXNG_DEFAULT_BASE_URL,
    numResults: config.numResults ?? SEARXNG_DEFAULT_NUM_RESULTS,
  }))
}
