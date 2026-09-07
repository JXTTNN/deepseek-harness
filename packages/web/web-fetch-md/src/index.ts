/**
 * `@deepseek-ai/dsh-web-fetch-md`: registers a Markdown-converting
 * `WebFetchProvider` with `ctx.web`. A function/namespace plugin (not a
 * default-export service): it registers INTO the seam's fetch registry, like
 * every other search/fetch provider of this package group.
 *
 * @module @deepseek-ai/dsh-web-fetch-md
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http'
import { MarkdownFetchProvider } from './provider.ts'

export { MD_PROVIDER_ID, MarkdownFetchProvider, htmlToMarkdown } from './provider.ts'
export type { MarkdownFetchOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-md'

/** Plugin config: the wrapped HTTP limits plus Markdown-specific settings. */
export interface Config {
  /** Maximum accepted request URL length. */
  maxUrlLength?: number
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters before extraction. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /** Character cap for the emitted Markdown (0 disables the cap). */
  maxMarkdownChars?: number
  /** Include the article byline (author/date) in the emitted header. */
  includeByline?: boolean
}

export const Config: z<Config> = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(500_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  maxMarkdownChars: z.number().default(50_000),
  includeByline: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Register the Markdown fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  ctx.web.registerFetchProvider(new MarkdownFetchProvider({
    http: {
      maxUrlLength: resolved.maxUrlLength,
      maxResponseBytes: resolved.maxResponseBytes,
      maxBodyChars: resolved.maxBodyChars,
      timeoutMs: resolved.timeoutMs,
      maxRedirects: resolved.maxRedirects,
      userAgent: resolved.userAgent,
    },
    maxMarkdownChars: resolved.maxMarkdownChars,
    includeByline: resolved.includeByline,
  }))
}
