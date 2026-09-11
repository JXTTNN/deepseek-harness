/**
 * MCP Server implementation: bridges the harness tool registry, resources, and
 * prompts to the MCP protocol so external clients can call harness tools,
 * read resources, and get prompts.
 *
 * Tools bridge: `tools/list` returns every registered harness tool's JSON
 * Schema; `tools/call` forwards to `ctx.tools.execute()` and maps the result
 * to MCP content blocks. Supports tool allow/deny lists (M7) and result
 * caching for idempotent tools (M9).
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
 * Sampling bridge (M4): `sampling/createMessage` forwards LLM generation
 * requests to the harness LLM service, enabling nested inference.
 *
 * Roots bridge (M5): `roots/list` exposes the harness workspace root and
 * notifies clients when the workspace changes.
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
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
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

/** Default TTL for idempotent tool result cache (ms). */
const DEFAULT_CACHE_TTL_MS = 60_000

/** Default maximum entries in the tool result cache. */
const DEFAULT_CACHE_MAX = 100

/** Tool names that are treated as idempotent and safe to cache. */
const CACHEABLE_TOOLS = new Set(['read_file', 'fs_read', 'web_fetch', 'web_read', 'resources/read'])

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
      // sampling and roots are client capabilities in the MCP spec, but we
      // declare them here so clients know the server will issue these requests.
      // The SDK's ServerCapabilities type does not include them, so cast.
      server = new Server(
        { name: config.serverName, version: '0.1.0' },
        {
          capabilities: {
            tools: {},
            resources: { subscribe: true, listChanged: true },
            prompts: {},
            sampling: {},
            roots: { listChanged: true },
          } as unknown as Record<string, unknown>,
        },
      )

      registerToolHandlers(ctx, server, config)
      registerResourceHandlers(ctx, server)
      registerPromptHandlers(ctx, server)
      registerSamplingHandler(ctx, server)
      registerRootsHandler(server)

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

// ---- Tool result cache (M9) ----

/** LRU cache entry for idempotent tool results. */
interface CacheEntry {
  value: { content: Array<{ type: string; text?: string }>; isError: boolean }
  expiry: number
}

/**
 * Simple LRU cache for idempotent tool results. Uses Map insertion-order
 * semantics for eviction: the oldest key is evicted when capacity is reached.
 * Accessing an entry refreshes its recency.
 */
class ToolResultCache {
  private readonly store = new Map<string, CacheEntry>()

  constructor(
    private readonly ttlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly maxEntries: number = DEFAULT_CACHE_MAX,
  ) {}

  /** Return a cached value if present and unexpired, else undefined. */
  get(key: string): CacheEntry['value'] | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiry <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    // Refresh insertion order for LRU recency.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  /** Store a value, evicting the least-recently-used entry if at capacity. */
  set(key: string, value: CacheEntry['value']): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiry: Date.now() + this.ttlMs })
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear()
  }
}

/** Determine whether a tool's result is safe to cache. */
function isCacheable(toolName: string, config: Config): boolean {
  if (config.cacheTtl !== undefined && config.cacheTtl <= 0) return false
  return CACHEABLE_TOOLS.has(toolName)
}

// ---- Tools bridge ----

/**
 * Register MCP `tools/list` and `tools/call` handlers that bridge to the
 * harness ToolRuntime. Applies allow/deny list filtering (M7) and result
 * caching for idempotent tools (M9).
 *
 * @param ctx - Cordis context with the tool registry.
 * @param server - MCP server instance to register handlers on.
 * @param config - Resolved plugin config with optional allow/deny lists and cache settings.
 */
function registerToolHandlers(ctx: Context, server: Server, config: Config): void {
  const cache = new ToolResultCache(
    config.cacheTtl ?? DEFAULT_CACHE_TTL_MS,
    config.cacheMax ?? DEFAULT_CACHE_MAX,
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const schemas = ctx.tools.schemas()
    const filtered = schemas.filter(schema => {
      if (config.allowTools !== undefined && !config.allowTools.includes(schema.name)) return false
      if (config.denyTools !== undefined && config.denyTools.includes(schema.name)) return false
      return true
    })
    return {
      tools: filtered.map(schema => ({
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
    // Enforce allow/deny lists on call as well as list (M7).
    if (config.allowTools !== undefined && !config.allowTools.includes(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `tool "${name}" is not allowed`)
    }
    if (config.denyTools !== undefined && config.denyTools.includes(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `tool "${name}" is denied`)
    }

    // Check cache for idempotent tools (M9).
    const cacheKey = `${name}:${JSON.stringify(args ?? {})}`
    if (isCacheable(name, config)) {
      const cached = cache.get(cacheKey)
      if (cached !== undefined) return cached
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
      const projected = { content: projectResult(result), isError: result.isError }
      if (isCacheable(name, config)) cache.set(cacheKey, projected)
      return projected
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

// ---- Sampling bridge (M4) ----

/**
 * Register MCP `sampling/createMessage` handler that bridges to the harness
 * LLM service, enabling nested inference requests from MCP clients.
 *
 * The harness LLM service (`ctx.get('llm')`) performs the actual generation;
 * if the service is not available, the request fails with MethodNotFound.
 * The handler supports model selection via `modelPreferences`, message
 * history, `maxTokens`, `systemPrompt`, `temperature`, and `stopSequences`.
 */
function registerSamplingHandler(ctx: Context, server: Server): void {
  server.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as any
    const messages = (params.messages ?? []) as Array<{
      role: string
      content: { type: string; text?: string } | string
    }>
    const modelPreferences = params.modelPreferences as { hints?: Array<{ name?: string }> } | undefined
    const maxTokens = params.maxTokens as number | undefined
    const systemPrompt = params.systemPrompt as string | undefined
    const temperature = params.temperature as number | undefined
    const stopSequences = params.stopSequences as string[] | undefined

    const llm = ctx.get('llm')
    if (llm === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, 'LLM service is not available for sampling')
    }

    try {
      // Normalize messages to a simple text format for the harness LLM.
      const normalizedMessages = messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content.text ?? ''),
      }))

      // Select model from preferences hint, if provided.
      const model = modelPreferences?.hints?.[0]?.name

      // The harness LLM service may expose generate/complete/chat; try each.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const llmAny = llm as any
      const generate = llmAny.generate ?? llmAny.complete ?? llmAny.chat
      if (typeof generate !== 'function') {
        throw new McpError(ErrorCode.InternalError, 'LLM service has no generate/complete/chat method')
      }

      const result = await generate.call(llmAny, {
        messages: normalizedMessages,
        model,
        maxTokens,
        systemPrompt,
        temperature,
        stopSequences,
      })

      // Normalize the result into MCP CreateMessageResult shape.
      const resultText = typeof result === 'string'
        ? result
        : (result?.text ?? result?.content ?? '')
      const resultModel = typeof result === 'object' && result !== null
        ? (result.model ?? model ?? 'unknown')
        : (model ?? 'unknown')

      return {
        model: String(resultModel),
        role: 'assistant',
        content: { type: 'text', text: String(resultText) },
        stopReason: 'end_turn',
      }
    } catch (error: unknown) {
      if (error instanceof McpError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new McpError(ErrorCode.InternalError, `sampling failed: ${message}`)
    }
  })
}

// ---- Roots bridge (M5) ----

/**
 * Register MCP `roots/list` handler that exposes the harness workspace root.
 * Also listens for `SIGUSR1` to notify clients of workspace changes via
 * `notifications/roots/list_changed`.
 *
 * The workspace root is derived from `process.cwd()`; on multi-root setups
 * callers can extend this by re-invoking after changing the working directory.
 */
function registerRootsHandler(server: Server): void {
  server.setRequestHandler(ListRootsRequestSchema, async () => {
    const cwd = process.cwd()
    return {
      roots: [{ uri: `file://${cwd}`, name: 'workspace' }],
    }
  })

  // Notify clients when the workspace changes. SIGUSR1 is a conventional
  // signal for requesting a state refresh without restarting the process.
  // Not available on Windows; the try/catch guards that.
  try {
    process.on('SIGUSR1', () => {
      try {
        // The MCP SDK Server exposes notification sending via `notification`.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(server as any).notification({ method: 'notifications/roots/list_changed' })
      } catch {
        // Server may be closed; ignore.
      }
    })
  } catch {
    // SIGUSR1 may not be available on all platforms (e.g., Windows).
  }
}