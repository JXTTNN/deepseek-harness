/**
 * MCP server bridge plugin: exposes the harness tool registry, resources, and
 * prompts as an MCP server so external MCP clients (Claude Desktop, Cursor,
 * etc.) can call deepseek-harness tools. Each plugin instance starts one MCP
 * server over the configured transport; load multiple instances in `cordis.yml`
 * for multiple transports or ports.
 *
 * Supports tool allow/deny lists (M7) and idempotent tool result caching (M9)
 * via optional config fields shared across transports.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal stops the server and releases the transport.
 * HMR hot-swaps by disposing the old instance and creating a new one.
 *
 * @module @deepseek-ai/dsh-mcp-server
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startServer } from './server.ts'

// Side-effect type imports: declaration-merge services onto Context.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'

export type { ServerHandle } from './server.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-server'

/** Services required by this plugin. */
export const inject = ['tools', 'systemPrompt']

// ---- Config ----

/** Common options shared across transport configs (M7 + M9). */
interface CommonConfigOptions {
  /** Tool allow-list: only these tools are exposed over MCP. */
  allowTools?: string[]
  /** Tool deny-list: these tools are not exposed over MCP. */
  denyTools?: string[]
  /** TTL in ms for idempotent tool result cache (default 60000). Set to 0 to disable caching. */
  cacheTtl?: number
  /** Maximum entries in the tool result cache (default 100). */
  cacheMax?: number
}

/** Config for running an MCP server over stdio. */
export interface StdioConfig extends CommonConfigOptions {
  /** Selects stdio transport (standard input/output). */
  transport: 'stdio'
  /** Server name advertised in the MCP initialize handshake. */
  serverName: string
}

/** Config for running an MCP server over Streamable HTTP. */
export interface StreamableHttpConfig extends CommonConfigOptions {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /** Server name advertised in the MCP initialize handshake. */
  serverName: string
  /** TCP port to listen on. */
  port: number
  /** Bind address; defaults to localhost. */
  host: string
}

/** Configuration for one MCP server transport. */
export type Config = StdioConfig | StreamableHttpConfig

const DEFAULT_HOST = '127.0.0.1'

/** Schema for the common tool filtering and caching options (M7 + M9). */
const commonOptionsSchema = {
  allowTools: z.array(z.string()).optional().description('Tool allow-list: only expose these tools over MCP'),
  denyTools: z.array(z.string()).optional().description('Tool deny-list: do not expose these tools over MCP'),
  cacheTtl: z.number().min(0).optional().description('TTL in ms for idempotent tool result cache (default 60000, 0 to disable)'),
  cacheMax: z.number().step(1).min(1).optional().description('Maximum entries in the tool result cache (default 100)'),
}

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required(),
    ...commonOptionsSchema,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required(),
    port: z.number().step(1).min(1).max(65535).required(),
    host: z.string().default(DEFAULT_HOST),
    ...commonOptionsSchema,
  }),
]) as unknown as z<Config>

// ---- Plugin apply ----

/**
 * Start one MCP server that exposes the harness tool registry, resources, and
 * prompts to external MCP clients. The server runs for the lifetime of the
 * plugin instance; disposal stops it and releases the transport.
 *
 * @param ctx - plugin context carrying the tool, system-prompt, and skill registries.
 * @param config - resolved transport and server identity configuration.
 * @returns startup readiness after the server begins listening.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const server = startServer(ctx, config)

  ctx.effect(() => {
    return () => server.dispose()
  }, 'mcp-server.connection')

  // Block plugin activation on the server starting to listen so Cordis
  // consumers observe the server immediately after the fiber activates.
  await server.ready
}