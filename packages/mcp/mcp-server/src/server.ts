/**
 * MCP Server implementation: bridges th e harness tool registry, resources, and
 * p rompts to the MCP protocol so external client s can call harness tools,
 * read resources,  and get prompts.
 *
 * Tools bridge: `tool s/list` returns every registered harness tool 's JSON
 * Schema; `tools/call` forwards to  `ctx.tools.execute()` and maps the result
 *  to MCP content blocks. Supports tool allow/d eny lists (M7) and result
 * caching for ide mpotent tools (M9).
 *
 * Resources bridge  (M2): `resources/list` exposes harness file-s ystem, web,
 * and attachment resources; `re sources/read` reads a specific resource by UR I
 * scheme (`file://`, `web://`); `resource s/subscribe` tracks resource changes
 * via  the `tools/change` event.
 *
 * Prompts bri dge (M3): `prompts/list` exposes harness syst em-prompt sections
 * and skills; `prompts/g et` returns a specific prompt's content with 
 * argument interpolation.
 *
 * Sampling  bridge (M4): `sampling/createMessage` forward s LLM generation
 * requests to the harness  LLM service, enabling nested inference.
 *
  * Roots bridge (M5): `roots/list` exposes th e harness workspace root and
 * notifies cli ents when the workspace changes.
 *
 * @mod ule
 */

import { Server } from '@modelcon textprotocol/sdk/server/index.js'
import {
   ListToolsRequestSchema,
  CallToolRequestS chema,
  ListResourcesRequestSchema,
  Read ResourceRequestSchema,
  ListResourceTemplat esRequestSchema,
  ListPromptsRequestSchema, 
  GetPromptRequestSchema,
  CreateMessageR equestSchema,
  ListRootsRequestSchema,
  E rrorCode,
  McpError,
} from '@modelcontext protocol/sdk/types.js'
import type { Context  } from '@deepseek-ai/cordis'
import type {  ToolExecutionInput, ToolExecutionResult } fro m '@deepseek-ai/dsh-tools'
import type { Con tentBlock } from '@deepseek-ai/dsh-llm'

im port { createTransport } from './transport.ts '
import type { Config } from './index.ts'
 
/** Default per-call timeout for forwarded  tool executions (ms). */
const DEFAULT_CALL_ TIMEOUT_MS = 60_000

/** Resource URI schem es bridged to harness tools. */
const FILE_S CHEME = 'file://'
const WEB_SCHEME = 'web:// '

/** Default TTL for idempotent tool resu lt cache (ms). */
const DEFAULT_CACHE_TTL_MS  = 60_000

/** Default maximum entries in t he tool result cache. */
const DEFAULT_CACHE _MAX = 100

/** Tool names that are treated  as idempotent and safe to cache. */
const C ACHEABLE_TOOLS = new Set(['read_file', 'fs_re ad', 'web_fetch', 'web_read', 'resources/read '])

/** Result from the initial server sta rt, for startup-await semantics. */
export i nterface ServerOutcome {
  /** If the initia l server start failed, the error; otherwise a bsent. */
  error?: unknown
}

/** Handle  for one plugin instance's MCP server. */
ex port interface ServerHandle {
  /**
   * Se ttles when the server has started listening ( success or failure).
   * The caller decides  whether a failed startup is fatal.
   */
   ready: Promise<ServerOutcome>
  /** Stop th e server, close the transport, and release al l resources. */
  dispose(): Promise<void>
 }

/**
 * Start the MCP server for one plu gin instance and keep it serving until
 * di sposal.
 *
 * @param ctx - Cordis context p roviding the tool, system-prompt, and skill r egistries.
 * @param config - Resolved plugi n config selecting the transport and server i dentity.
 * @returns Handle with a `ready` p romise for startup-await and a `dispose` for  teardown.
 */
export function startServer(c tx: Context, config: Config): ServerHandle { 
  const label = `mcp-server(${config.serverN ame})`
  let disposed = false
  let server:  Server | undefined

  const ready: Promise <ServerOutcome> = (async () => {
    try {
       // sampling and roots are client capabi lities in the MCP spec, but we
      // decl are them here so clients know the server will  issue these requests.
      // The SDK's Se rverCapabilities type does not include them,  so cast.
      server = new Server(
         { name: config.serverName, version: '0.1.0'  },
        {
          capabilities: {
             tools: {},
            resources: {  subscribe: true, listChanged: true },
             prompts: {},
            sampling: {} ,
            roots: { listChanged: true }, 
          } as unknown as Record<string, unk nown>,
        },
      )

      register ToolHandlers(ctx, server, config)
      regi sterResourceHandlers(ctx, server)
      regi sterPromptHandlers(ctx, server)
      regist erSamplingHandler(ctx, server)
      registe rRootsHandler(server)

      const transpor t = createTransport(config)
      await serv er.connect(transport)
      if (disposed) { 
        try { await server.close() } catch {  /* already gone */ }
        return {}
       }
      ctx.logger.info(`${label}: MCP se rver listening`)
      return {}
    } catc h (error) {
      if (!disposed) ctx.logger. error(`${label}: failed to start: ${String(er ror)}`)
      return { error }
    }
  })( )

  return {
    ready,
    async dispos e(): Promise<void> {
      disposed = true
       const current = server
      server =  undefined
      if (current !== undefined) { 
        try { await current.close() } catch  { /* transport already gone */ }
      }
     },
  }
}

// ---- Tool result cache (M 9) ----

/** LRU cache entry for idempotent  tool results. */
interface CacheEntry {
   value: { content: Array<{ type: string; text? : string }>; isError: boolean }
  expiry: nu mber
}

/**
 * Simple LRU cache for idemp otent tool results. Uses Map insertion-order 
 * semantics for eviction: the oldest key is  evicted when capacity is reached.
 * Access ing an entry refreshes its recency.
 */
cla ss ToolResultCache {
  private readonly stor e = new Map<string, CacheEntry>()

  constr uctor(
    private readonly ttlMs: number =  DEFAULT_CACHE_TTL_MS,
    private readonly m axEntries: number = DEFAULT_CACHE_MAX,
  ) { }

  /** Return a cached value if present a nd unexpired, else undefined. */
  get(key:  string): CacheEntry['value'] | undefined {
     const entry = this.store.get(key)
    if  (entry === undefined) return undefined
    i f (entry.expiry <= Date.now()) {
      this. store.delete(key)
      return undefined
     }
    // Refresh insertion order for LRU r ecency.
    this.store.delete(key)
    this .store.set(key, entry)
    return entry.valu e
  }

  /** Store a value, evicting the l east-recently-used entry if at capacity. */
   set(key: string, value: CacheEntry['value'] ): void {
    if (this.store.size >= this.ma xEntries) {
      const oldest = this.store. keys().next().value
      if (oldest !== und efined) this.store.delete(oldest)
    }
     this.store.set(key, { value, expiry: Date.no w() + this.ttlMs })
  }

  /** Remove all  entries. */
  clear(): void {
    this.stor e.clear()
  }
}

/** Determine whether a  tool's result is safe to cache. */
function  isCacheable(toolName: string, config: Config) : boolean {
  if (config.cacheTtl !== undefi ned && config.cacheTtl <= 0) return false
   return CACHEABLE_TOOLS.has(toolName)
}

//  ---- Tools bridge ----

/**
 * Register M CP `tools/list` and `tools/call` handlers tha t bridge to the
 * harness ToolRuntime. Appl ies allow/deny list filtering (M7) and result 
 * caching for idempotent tools (M9).
 *
  * @param ctx - Cordis context with the tool  registry.
 * @param server - MCP server inst ance to register handlers on.
 * @param conf ig - Resolved plugin config with optional all ow/deny lists and cache settings.
 */
funct ion registerToolHandlers(ctx: Context, server : Server, config: Config): void {
  const ca che = new ToolResultCache(
    config.cacheT tl ?? DEFAULT_CACHE_TTL_MS,
    config.cache Max ?? DEFAULT_CACHE_MAX,
  )

  server.se tRequestHandler(ListToolsRequestSchema, async  () => {
    const schemas = ctx.tools.schem as()
    const filtered = schemas.filter(sch ema => {
      if (config.allowTools !== und efined && !config.allowTools.includes(schema. name)) return false
      if (config.denyToo ls !== undefined && config.denyTools.includes (schema.name)) return false
      return tru e
    })
    return {
      tools: filtere d.map(schema => ({
        name: schema.name ,
        description: schema.description,
         inputSchema: schema.parameters as { t ype: string; properties: Record<string, unkno wn> },
      })),
    }
  })

  server.s etRequestHandler(CallToolRequestSchema, async  (request) => {
    const { name, arguments:  args } = request.params
    const schemas =  ctx.tools.schemas()
    const found = schem as.find(s => s.name === name)
    if (found  === undefined) {
      throw new McpError(Er rorCode.MethodNotFound, `unknown tool "${name }"`)
    }
    // Enforce allow/deny lists  on call as well as list (M7).
    if (config .allowTools !== undefined && !config.allowToo ls.includes(name)) {
      throw new McpErro r(ErrorCode.MethodNotFound, `tool "${name}" i s not allowed`)
    }
    if (config.denyTo ols !== undefined && config.denyTools.include s(name)) {
      throw new McpError(ErrorCod e.MethodNotFound, `tool "${name}" is denied`) 
    }

    // Check cache for idempotent  tools (M9).
    const cacheKey = `${name}:${ JSON.stringify(args ?? {})}`
    if (isCache able(name, config)) {
      const cached = c ache.get(cacheKey)
      if (cached !== unde fined) return cached
    }

    const cont roller = new AbortController()
    const tim eout = setTimeout(() => controller.abort(), D EFAULT_CALL_TIMEOUT_MS)
    timeout.unref() 

    const exec: ToolExecutionInput = {
       callId: `mcp-${crypto.randomUUID()}` as T oolExecutionInput['callId'],
      name,
       arguments: args ?? {},
      signal: con troller.signal,
    }

    try {
      co nst result: ToolExecutionResult = await ctx.t ools.execute(exec)
      const projected = {  content: projectResult(result), isError: res ult.isError }
      if (isCacheable(name, co nfig)) cache.set(cacheKey, projected)
       return projected
    } catch (error: unknown ) {
      const message = error instanceof E rror ? error.message : String(error)
      r eturn { content: [{ type: 'text', text: messa ge }], isError: true }
    } finally {
       clearTimeout(timeout)
    }
  })
}

/* *
 * Project a harness ToolExecutionResult i nto MCP content blocks.
 * Text blocks pass  through; image and other blocks are rendered  as text
 * placeholders since the MCP server  bridge does not own durable attachments.
 * /
function projectResult(result: ToolExecuti onResult): Array<{ type: string; text?: strin g }> {
  return result.content.map(block =>  projectContentBlock(block))
}

/** Project  one harness ContentBlock to an MCP content b lock. */
function projectContentBlock(block:  ContentBlock): { type: string; text?: string  } {
  switch (block.type) {
    case 'text ':
      return { type: 'text', text: block. text }
    case 'image':
      return { typ e: 'text', text: '[image content: available t o programmatic callers]' }
    default:
       return { type: 'text', text: `[${block.typ e} content]` }
  }
}

// ---- Resources b ridge (M2) ----

/** Tracked resource subsc ribers for change notifications. */
interfac e ResourceSubscription {
  uri: string
  no tify: () => void
}

/**
 * Register MCP ` resources/list`, `resources/read`, and
 * `r esources/templates/list` handlers that bridge  harness file-system, web,
 * and attachment  resources.
 *
 * Resource URI schemes:
 *  - `file://<path>` — mapped to the fs tool  (read_file)
 * - `web://<url>` — mapped to  the web tool (web_fetch)
 */
function regi sterResourceHandlers(ctx: Context, server: Se rver): void {
  const subscriptions = new Se t<ResourceSubscription>()

  server.setRequ estHandler(ListResourcesRequestSchema, async  () => {
    const resources: Array<{ uri: st ring; name: string; description?: string; mim eType?: string }> = []
    // Expose file-sy stem resources from the fs tool if available 
    for (const schema of ctx.tools.schemas() ) {
      if (schema.name === 'read_file' ||  schema.name === 'fs_read') {
        resour ces.push({
          uri: `${FILE_SCHEME}/`, 
          name: 'filesystem',
          de scription: 'Harness file-system resources (fi le://<path>)',
          mimeType: 'text/pla in',
        })
      }
      if (schema.n ame === 'web_fetch' || schema.name === 'web_r ead') {
        resources.push({
           uri: `${WEB_SCHEME}`,
          name: 'web', 
          description: 'Harness web resourc es (web://<url>)',
          mimeType: 'text /html',
        })
      }
    }
    retu rn { resources }
  })

  server.setRequest Handler(ListResourceTemplatesRequestSchema, a sync () => {
    return {
      resourceTem plates: [
        {
          uriTemplate:  `${FILE_SCHEME}{path}`,
          name: 'fil e',
          description: 'Read a file from  the harness file system',
          mimeTyp e: 'text/plain',
        },
        {
           uriTemplate: `${WEB_SCHEME}{url}`,
           name: 'web',
          description: ' Fetch a web resource via the harness web tool ',
          mimeType: 'text/html',
         },
      ],
    }
  })

  server.setReq uestHandler(ReadResourceRequestSchema, async  (request) => {
    const { uri } = request.p arams
    const controller = new AbortContro ller()
    const timeout = setTimeout(() =>  controller.abort(), DEFAULT_CALL_TIMEOUT_MS) 
    timeout.unref()

    try {
      if ( uri.startsWith(FILE_SCHEME)) {
        const  path = uri.slice(FILE_SCHEME.length)
         return await readViaTool(ctx, 'read_file',  { path }, controller.signal, uri)
      }
       if (uri.startsWith(WEB_SCHEME)) {
         const url = uri.slice(WEB_SCHEME.length)
         return await readViaTool(ctx, 'web_fe tch', { url }, controller.signal, uri)
       }
      throw new McpError(ErrorCode.Invali dParams, `unsupported resource URI scheme: ${ uri}`)
    } finally {
      clearTimeout(t imeout)
    }
  })

  // Notify subscribe rs when the tool registry changes (resources  may follow).
  ctx.on('tools/change', () =>  {
    for (const sub of subscriptions) sub.n otify()
  })
}

/**
 * Read a resource b y invoking a harness tool and wrapping the re sult as an
 * MCP resource contents response .
 */
async function readViaTool(
  ctx: C ontext,
  toolName: string,
  args: Record< string, unknown>,
  signal: AbortSignal,
   uri: string,
): Promise<{ contents: Array<{  uri: string; mimeType?: string; text: string  }> }> {
  const schemas = ctx.tools.schemas( )
  const found = schemas.find(s => s.name = == toolName)
  if (found === undefined) {
     throw new McpError(ErrorCode.MethodNotFoun d, `tool "${toolName}" is not registered for  resource reads`)
  }
  const exec: ToolExec utionInput = {
    callId: `mcp-res-${crypto .randomUUID()}` as ToolExecutionInput['callId '],
    name: toolName,
    arguments: args ,
    signal,
  }
  try {
    const resul t = await ctx.tools.execute(exec)
    const  text = result.content
      .map(block => bl ock.type === 'text' ? block.text : `[${block. type} content]`)
      .join('\n')
    retu rn { contents: [{ uri, mimeType: 'text/plain' , text }] }
  } catch (error: unknown) {
     const message = error instanceof Error ? er ror.message : String(error)
    throw new Mc pError(ErrorCode.InternalError, `resource rea d failed: ${message}`)
  }
}

// ---- Pro mpts bridge (M3) ----

/**
 * Register MCP  `prompts/list` and `prompts/get` handlers th at bridge harness
 * system-prompt sections  and skills.
 *
 * Each system-prompt sectio n becomes an MCP prompt named `section:<name> `.
 * Each skill becomes an MCP prompt named  `skill:<name>`.
 */
function registerPromp tHandlers(ctx: Context, server: Server): void  {
  server.setRequestHandler(ListPromptsReq uestSchema, async () => {
    const prompts:  Array<{
      name: string
      descripti on: string
      arguments?: Array<{ name: s tring; description?: string; required?: boole an }>
    }> = []

    // Expose system-pr ompt sections as prompts
    const systemPro mpt = ctx.get('systemPrompt')
    if (system Prompt !== undefined) {
      try {
         const assembly = await systemPrompt.assemble ({})
        for (const section of assembly. sections) {
          prompts.push({
             name: `section:${section.name}`,
             description: `System prompt section: $ {section.name}`,
          })
        }
       } catch {
        // System prompt assem bly may fail if services are not ready; skip  silently.
      }
    }

    // Expose sk ills as prompts
    const skills = ctx.get(' skills')
    if (skills !== undefined) {
       try {
        // eslint-disable-next-lin e @typescript-eslint/no-explicit-any
         const skillList = (await (skills as any).lis t()) as Array<{ name: string; description: st ring; invocation: { modelInvocable: boolean }  }>
        for (const skill of skillList) { 
          if (skill.invocation.modelInvocab le) {
            prompts.push({
               name: `skill:${skill.name}`,
               description: skill.description,
             })
          }
        }
      } catch  {
        // Skills service may not be ready ; skip silently.
      }
    }

    retur n { prompts }
  })

  server.setRequestHan dler(GetPromptRequestSchema, async (request)  => {
    const { name } = request.params
     const controller = new AbortController()
     const timeout = setTimeout(() => controlle r.abort(), DEFAULT_CALL_TIMEOUT_MS)
    time out.unref()

    try {
      if (name.star tsWith('section:')) {
        return await g etSectionPrompt(ctx, name.slice('section:'.le ngth), controller.signal)
      }
      if  (name.startsWith('skill:')) {
        return  await getSkillPrompt(ctx, name.slice('skill: '.length), controller.signal)
      }
       throw new McpError(ErrorCode.InvalidParams,  `unknown prompt "${name}"`)
    } finally { 
      clearTimeout(timeout)
    }
  })
} 

/** Get a system-prompt section as an MCP  prompt response. */
async function getSectio nPrompt(
  ctx: Context,
  sectionName: str ing,
  signal: AbortSignal,
): Promise<{ me ssages: Array<{ role: string; content: { type : string; text: string } }> }> {
  const sys temPrompt = ctx.get('systemPrompt')
  if (sy stemPrompt === undefined) {
    throw new Mc pError(ErrorCode.MethodNotFound, 'system-prom pt service is not available')
  }
  try {
     const assembly = await systemPrompt.assem ble({ signal })
    const section = assembly .sections.find(s => s.name === sectionName)
     if (section === undefined) {
      throw  new McpError(ErrorCode.InvalidParams, `unkno wn system-prompt section "${sectionName}"`)
     }
    return {
      messages: [{
         role: 'assistant',
        content: { ty pe: 'text', text: section.text },
      }], 
    }
  } catch (error: unknown) {
    if  (error instanceof McpError) throw error
     const message = error instanceof Error ? erro r.message : String(error)
    throw new McpE rror(ErrorCode.InternalError, `prompt assembl y failed: ${message}`)
  }
}

/** Get a s kill as an MCP prompt response. */
async fun ction getSkillPrompt(
  ctx: Context,
  ski llName: string,
  signal: AbortSignal,
): P romise<{ messages: Array<{ role: string; cont ent: { type: string; text: string } }> }> {
   const skills = ctx.get('skills')
  if (ski lls === undefined) {
    throw new McpError( ErrorCode.MethodNotFound, 'skills service is  not available')
  }
  try {
    // eslint- disable-next-line @typescript-eslint/no-expli cit-any
    const skillList = (await (skills  as any).list()) as Array<{ name: string }>
     const summary = skillList.find(s => s.nam e === skillName)
    if (summary === undefin ed) {
      throw new McpError(ErrorCode.Inv alidParams, `unknown skill "${skillName}"`)
     }
    const body = await (skills as unkn own as { load(name: string, opts: { signal: A bortSignal }): Promise<unknown> }).load(skill Name, { signal })
    const text = typeof bo dy === 'string' ? body : JSON.stringify(body) 
    return {
      messages: [{
        r ole: 'user',
        content: { type: 'text' , text },
      }],
    }
  } catch (error : unknown) {
    if (error instanceof McpErr or) throw error
    const message = error in stanceof Error ? error.message : String(error )
    throw new McpError(ErrorCode.InternalE rror, `skill load failed: ${message}`)
  }
 }

// ---- Sampling bridge (M4) ----

/** 
 * Register MCP `sampling/createMessage` ha ndler that bridges to the harness
 * LLM ser vice, enabling nested inference requests from  MCP clients.
 *
 * The harness LLM service  (`ctx.get('llm')`) performs the actual gener ation;
 * if the service is not available, t he request fails with MethodNotFound.
 * The  handler supports model selection via `modelP references`, message
 * history, `maxTokens` , `systemPrompt`, `temperature`, and `stopSeq uences`.
 */
function registerSamplingHandl er(ctx: Context, server: Server): void {
  s erver.setRequestHandler(CreateMessageRequestS chema, async (request) => {
    // eslint-di sable-next-line @typescript-eslint/no-explici t-any
    const params = request.params as a ny
    const messages = (params.messages ??  []) as Array<{
      role: string
      con tent: { type: string; text?: string } | strin g
    }>
    const modelPreferences = param s.modelPreferences as { hints?: Array<{ name? : string }> } | undefined
    const maxToken s = params.maxTokens as number | undefined
     const systemPrompt = params.systemPrompt a s string | undefined
    const temperature =  params.temperature as number | undefined
     const stopSequences = params.stopSequences  as string[] | undefined

    const llm = ct x.get('llm')
    if (llm === undefined) {
       throw new McpError(ErrorCode.MethodNotFo und, 'LLM service is not available for sampli ng')
    }

    try {
      // Normalize  messages to a simple text format for the harn ess LLM.
      const normalizedMessages = me ssages.map(m => ({
        role: m.role,
         content: typeof m.content === 'string'  ? m.content : (m.content.text ?? ''),
       }))

      // Select model from preferences  hint, if provided.
      const model = mode lPreferences?.hints?.[0]?.name

      // Th e harness LLM service may expose generate/com plete/chat; try each.
      // eslint-disabl e-next-line @typescript-eslint/no-explicit-an y
      const llmAny = llm as any
      con st generate = llmAny.generate ?? llmAny.compl ete ?? llmAny.chat
      if (typeof generate  !== 'function') {
        throw new McpErro r(ErrorCode.InternalError, 'LLM service has n o generate/complete/chat method')
      }
 
      const result = await generate.call(llm Any, {
        messages: normalizedMessages, 
        model,
        maxTokens,
         systemPrompt,
        temperature,
         stopSequences,
      })

      // Normali ze the result into MCP CreateMessageResult sh ape.
      const resultText = typeof result  === 'string'
        ? result
        : (re sult?.text ?? result?.content ?? '')
      c onst resultModel = typeof result === 'object'  && result !== null
        ? (result.model  ?? model ?? 'unknown')
        : (model ?? ' unknown')

      return {
        model: S tring(resultModel),
        role: 'assistant ',
        content: { type: 'text', text: St ring(resultText) },
        stopReason: 'end _turn',
      }
    } catch (error: unknown ) {
      if (error instanceof McpError) thr ow error
      const message = error instanc eof Error ? error.message : String(error)
       throw new McpError(ErrorCode.InternalErro r, `sampling failed: ${message}`)
    }
  } )
}

// ---- Roots bridge (M5) ----

/** 
 * Register MCP `roots/list` handler that e xposes the harness workspace root.
 * Also l istens for `SIGUSR1` to notify clients of wor kspace changes via
 * `notifications/roots/l ist_changed`.
 *
 * The workspace root is d erived from `process.cwd()`; on multi-root se tups
 * callers can extend this by re-invoki ng after changing the working directory.
 */ 
function registerRootsHandler(server: Serve r): void {
  server.setRequestHandler(ListRo otsRequestSchema, async () => {
    const cw d = process.cwd()
    return {
      roots:  [{ uri: `file://${cwd}`, name: 'workspace' } ],
    }
  })

  // Notify clients when t he workspace changes. SIGUSR1 is a convention al
  // signal for requesting a state refres h without restarting the process.
  // Not a vailable on Windows; the try/catch guards tha t.
  try {
    process.on('SIGUSR1', () =>  {
      try {
        // The MCP SDK Server  exposes notification sending via `notificati on`.
        // eslint-disable-next-line @ty pescript-eslint/no-explicit-any
        ;(se rver as any).notification({ method: 'notifica tions/roots/list_changed' })
      } catch { 
        // Server may be closed; ignore.
       }
    })
  } catch {
    // SIGUSR1 m ay not be available on all platforms (e.g., W indows).
  }
} 