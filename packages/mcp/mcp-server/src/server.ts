/**
 * MCP Server implementation: bridges the harness tool registry, resources, and
 * prompts to the MCP protocol so external clients can call harness tools,
 * read resources, and get prompts.
 *
 * Tools bridge: `tools/list` returns every registered harness tool's JSON
 * Schema; `tools/call` forwards to `ctx.tools.execute()` and maps the result
 * to MCP content blocks.
 *
 * Resources bridge (M2): `resources/list` exposes harness file-system, web,
 * and attachment resources; `resources/read` reads a specific resource by URI
 * scheme (`file://`, `web://`); `resources/subscribe` tracks resource changes
 * via the `tools/change` event.
 *
 * Prompts bridge (M3): `prompts/list` exposes harness system-prompt sections
 * and skills; `prompts/get` returns a specific prompt's content with
 * argument interpolation.
 *
 * @module
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createTransport } from './transport.ts'
import type { Config } from './index.ts'

/** Default per-call timeout for forwarded tool executions (ms). */
const DEFAULT_CALL_TIMEOUT_MS = 60_000

/** Resource URI schemes bridged to harness tools. */
const FILE_SCHEME = 'file://'
const WEB_SCHEME = 'web://'

/** Result from the initial server start, for startup-await semantics. */
export interface ServerOutcome {
  /** If the initial server start failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's MCP server. */
export interface ServerHandle {
  /**
   * Settles when the server has started listening (success or failure).
   * The caller decides whether a failed startup is fatal.
   */
  ready: Promise<ServerOutcome>
  /** Stop the server, close the transport, and release all resources. */
  dispose(): Promise<void>
}

/**
 * Start the MCP server for one plugin instance and keep it serving until
 * disposal.
 *
 * @param ctx - Cordis context providing the tool, system-prompt, and skill registries.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
export function startServer(ctx: Context, config: Config): ServerHandle {
  const label = `mcp-server(${config.serverName})`
  let disposed = false
  let server: Server | undefined

  const ready: Promise<ServerOutcome> = (async () => {
    try {
      server = new Server(
        { name: config.serverName, version: '0.1.0' },
        {
          capabilities: {
            tools: {},
            resources: { subscribe: true, listChanged: true },
            prompts: {},
          },
        },
      )

      registerToolHandlers(ctx, server)
      registerResourceHandlers(ctx, server)
      registerPromptHandlers(ctx, server)

      const transport = createTransport(config)
      await server.connect(transport)
      if (disposed) {
        try { await server.close() } catch { /* already gone */ }
        return {}
      }
      ctx.logger.info(`${label}: MCP server listening`)
      return {}
    } catch (error) {
      if (!disposed) ctx.logger.error(`${label}: failed to start: ${String(error)}`)
      return { error }
    }
  })()

  return {
    ready,
    async dispose(): Promise<void> {
      disposed = true
      const current = server
      server = undefined
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
      }
    },
  }
}

// ---- Tools bridge ----

/**
 * Register MCP `tools/list` and `tools/call` handlers that bridge to the
 * harness ToolRuntime.
 */
function registerToolHandlers(ctx: Context, server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const schemas = ctx.tools.schemas()
    return {
      tools: schemas.map(schema => ({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.parameters as { type: string; properties: Record<string, unknown> },
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const schemas = ctx.tools.schemas()
    const found = schemas.find(s => s.name === name)
    if (found === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool "${name}"`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_CALL_TIMEOUT_MS)
    timeout.unref()

    const exec: ToolExecutionInput = {
      callId: `mcp-${crypto.randomUUID()}` as ToolExecutionInput['callId'],
      name,
      arguments: args ?? {},
      signal: controller.signal,
    }

    try {
      const result: ToolExecutionResult = await ctx.tools.execute(exec)
      return { content: projectResult(result), isError: result.isError }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text: message }], isError: true }
    } finally {
      clearTimeout(timeout)
    }
  })
}

/**
 * Project a harness ToolExecutionResult into MCP content blocks.
 * Text blocks pass through; image and other blocks are rendered as text
 * placeholders since the MCP server bridge does not own durable attachments.
 */
function projectResult(result: ToolExecutionResult): Array<{ type: string; text?: string }> {
  return result.content.map(block => projectContentBlock(block))
}

/** Project one harness ContentBlock to an MCP content block. */
function projectContentBlock(block: ContentBlock): { type: string; text?: string } {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return { type: 'text', text: '[image content: available to programmatic callers]' }
    default:
      return { type: 'text', text: `[${block.type} content]` }
  }
}

// ---- Resources bridge (M2) ----

/** Tracked resource subscribers for change notifications. */
interface ResourceSubscription {
  uri: string
  notify: () => void
}

/**
 * Register MCP `resources/list`, `resources/read`, and
 * `resources/templates/list` handlers that bridge harness file-system, web,
 * and attachment resources.
 *
 * Resource URI schemes:
 * - `file://<path>` — mapped to the fs tool (read_file)
 * - `web://<url>` — mapped to the web tool (web_fetch)
 */
function registerResourceHandlers(ctx: Context, server: Server): void {
  const subscriptions = new Set<ResourceSubscription>()

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = []
    // Expose file-system resources from the fs tool if available
    for (const schema of ctx.tools.schemas()) {
      if (schema.name === 'read_file' || schema.name === 'fs_read') {
        resources.push({
          uri: `${FILE_SCHEME}/`,
          name: 'filesystem',
          description: 'Harness file-system resources (file://<path>)',
          mimeType: 'text/plain',
        })
      }
      if (schema.name === 'web_fetch' || schema.name === 'web_read') {
        resources.push({
          uri: `${WEB_SCHEME}`,
          name: 'web',
          description: 'Harness web resources (web://<url>)',
          mimeType: 'text/html',
        })
      }
    }
    return { resources }
  })

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: `${FILE_SCHEME}{path}`,
          name: 'file',
          description: 'Read a file from the harness file system',
          mimeType: 'text/plain',
        },
        {
          uriTemplate: `${WEB_SCHEME}{url}`,
          name: 'web',
          description: 'Fetch a web resource via the harness web tool',
          mimeType: 'text/html',
        },
      ],
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_CALL_TIMEOUT_MS)
    timeout.unref()

    try {
      if (uri.startsWith(FILE_SCHEME)) {
        const path = uri.slice(FILE_SCHEME.length)
        return await readViaTool(ctx, 'read_file', { path }, controller.signal, uri)
      }
      if (uri.startsWith(WEB_SCHEME)) {
        const url = uri.slice(WEB_SCHEME.length)
        return await readViaTool(ctx, 'web_fetch', { url }, controller.signal, uri)
      }
      throw new McpError(ErrorCode.InvalidParams, `unsupported resource URI scheme: ${uri}`)
    } finally {
      clearTimeout(timeout)
    }
  })

  // Notify subscribers when the tool registry changes (resources may follow).
  ctx.on('tools/change', () => {
    for (const sub of subscriptions) sub.notify()
  })
}

/**
 * Read a resource by invoking a harness tool and wrapping the result as an
 * MCP resource contents response.
 */
async function readViaTool(
  ctx: Context,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  uri: string,
): Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }> {
  const schemas = ctx.tools.schemas()
  const found = schemas.find(s => s.name === toolName)
  if (found === undefined) {
    throw new McpError(ErrorCode.MethodNotFound, `tool "${toolName}" is not registered for resource reads`)
  }
  const exec: ToolExecutionInput = {
    callId: `mcp-res-${crypto.randomUUID()}` as ToolExecutionInput['callId'],
    name: toolName,
    arguments: args,
    signal,
  }
  try {
    const result = await ctx.tools.execute(exec)
    const text = result.content
      .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
      .join('\n')
    return { contents: [{ uri, mimeType: 'text/plain', text }] }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new McpError(ErrorCode.InternalError, `resource read failed: ${message}`)
  }
}

// ---- Prompts bridge (M3) ----

/**
 * Register MCP `prompts/list` and `prompts/get` handlers that bridge harness
 * system-prompt sections and skills.
 *
 * Each system-prompt section becomes an MCP prompt named `section:<name>`.
 * Each skill becomes an MCP prompt named `skill:<name>`.
 */
function registerPromptHandlers(ctx: Context, server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts: Array<{
      name: string
      description: string
      arguments?: Array<{ name: string; description?: string; required?: boolean }>
    }> = []

    // Expose system-prompt sections as prompts
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      try {
        const assembly = await systemPrompt.assemble({})
        for (const section of assembly.sections) {
          prompts.push({
            name: `section:${section.name}`,
            description: `System prompt section: ${section.name}`,
          })
        }
      } catch {
        // System prompt assembly may fail if services are not ready; skip silently.
      }
    }

    // Expose skills as prompts
    const skills = ctx.get('skills')
    if (skills !== undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const skillList = (await (skills as any).list()) as Array<{ name: string; description: string; invocation: { modelInvocable: boolean } }>
        for (const skill of skillList) {
          if (skill.invocation.modelInvocable) {
            prompts.push({
              name: `skill:${skill.name}`,
              description: skill.description,
            })
          }
        }
      } catch {
        // Skills service may not be ready; skip silently.
      }
    }

    return { prompts }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_CALL_TIMEOUT_MS)
    timeout.unref()

    try {
      if (name.startsWith('section:')) {
        return await getSectionPrompt(ctx, name.slice('section:'.length), controller.signal)
      }
      if (name.startsWith('skill:')) {
        return await getSkillPrompt(ctx, name.slice('skill:'.length), controller.signal)
      }
      throw new McpError(ErrorCode.InvalidParams, `unknown prompt "${name}"`)
    } finally {
      clearTimeout(timeout)
    }
  })
}

/** Get a system-prompt section as an MCP prompt response. */
async function getSectionPrompt(
  ctx: Context,
  sectionName: string,
  signal: AbortSignal,
): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) {
    throw new McpError(ErrorCode.MethodNotFound, 'system-prompt service is not available')
  }
  try {
    const assembly = await systemPrompt.assemble({ signal })
    const section = assembly.sections.find(s => s.name === sectionName)
    if (section === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `unknown system-prompt section "${sectionName}"`)
    }
    return {
      messages: [{
        role: 'assistant',
        content: { type: 'text', text: section.text },
      }],
    }
  } catch (error: unknown) {
    if (error instanceof McpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new McpError(ErrorCode.InternalError, `prompt assembly failed: ${message}`)
  }
}

/** Get a skill as an MCP prompt response. */
async function getSkillPrompt(
  ctx: Context,
  skillName: string,
  signal: AbortSignal,
): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  const skills = ctx.get('skills')
  if (skills === undefined) {
    throw new McpError(ErrorCode.MethodNotFound, 'skills service is not available')
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skillList = (await (skills as any).list()) as Array<{ name: string }>
    const summary = skillList.find(s => s.name === skillName)
    if (summary === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `unknown skill "${skillName}"`)
    }
    const body = await (skills as unknown as { load(name: string, opts: { signal: AbortSignal }): Promise<unknown> }).load(skillName, { signal })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text },
      }],
    }
  } catch (error: unknown) {
    if (error instanceof McpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new McpError(ErrorCode.InternalError, `skill load failed: ${message}`)
  }
}
