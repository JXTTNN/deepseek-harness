/**
 * `@deepseek-ai/dsh-web-search-ddg`: registers a keyless DuckDuckGo-HTML
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-web-search-searxng` does. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * DuckDuckGo's HTML endpoint needs no API key and no self-hosted instance, so
 * this provider is the zero-config safety net: mount it everywhere, let the
 * deployment stay free even when every keyed gateway is down.
 *
 * @module @deepseek-ai/dsh-web-search-ddg
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DdgSearchProvider,
  DDG_DEFAULT_BASE_URL,
  DDG_DEFAULT_NUM_RESULTS,
} from './provider.ts'

export {
  DDG_DEFAULT_BASE_URL,
  DDG_DEFAULT_NUM_RESULTS,
  DDG_PROVIDER_ID,
  DdgSearchProvider,
  decodeDdgUrl,
  mapDdgEntries,
  mapDdgEntry,
  parseDdgHtml,
} from './provider.ts'
export type { DdgSearchProviderOptions } from './provider.ts'
export type { DdgHtmlEntry } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-ddg'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Endpoint base; `?q=…` is appended. */
  baseURL?: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  numResults: z.number().step(1).min(1),
})

/** Environment variable naming this provider's endpoint. */
const DDG_BASE_URL_ENV = 'DDG_BASE_URL'

/** Register the DuckDuckGo search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DdgSearchProvider({
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(DDG_BASE_URL_ENV)?.value
      ?? DDG_DEFAULT_BASE_URL,
    numResults: config.numResults ?? DDG_DEFAULT_NUM_RESULTS,
  }))
}
