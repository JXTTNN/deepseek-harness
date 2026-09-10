/**
 * MCP server bridge plugin: exposes the harness tool registry, resources, and
 * prompts as an MCP server so external MCP clients (Claude Desktop, Cursor,
 * etc.) can call deepseek-harness tools. Each plugin instance starts one MCP
 * server over the configured transport; load multiple instances in `cordis.yml`
 * for multiple transports or ports.
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

/** Config for running an MCP server over stdio. */
export interface StdioConfig {
  /** Selects stdio transport (standard input/output). */
  transport: 'stdio'
  /** Server name advertised in the MCP initialize handshake. */
  serverName: string
}

/** Config for running an MCP server over Streamable HTTP. */
export interface StreamableHttpConfig {
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

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required(),
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required(),
    port: z.number().step(1).min(1).max(65535).required(),
    host: z.string().default(DEFAULT_HOST),
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
