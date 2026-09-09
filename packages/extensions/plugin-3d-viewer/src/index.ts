/**
 * 3D Viewer Plugin for DeepSeek Harness
 *
 * Dual-track 3D pipeline:
 *   1. LOCAL (free, unlimited, no API key) — `3d_build` runs the embedded
 *      Python `engine3d` (trimesh) to build parametric solids and export
 *      GLB/OBJ/PLY/STL entirely offline. This is the default, zero-config path.
 *   2. CLOUD (optional accelerator) — `3d_generate` calls a configurable
 *      text/image→mesh provider (Tripo3D / Meshy / any OpenAI-compatible
 *      endpoint). Disabled unless an API key is supplied; never required.
 *
 * Real-time preview is served to the web UI over the viewer WebSocket port,
 * and models are visualized with Three.js (GLB/OBJ/PLY, progressive LOD).
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue, ContentBlock } from '@deepseek-ai/cordis'
import { buildPrimitive, engineInfo, type BridgeResponse } from './bridge.ts'

export const name = 'plugin-3d-viewer'
export const inject = ['skill', 'tools']

/**
 * 3D Viewer Configuration.
 * The local engine needs nothing; cloud generation is opt-in.
 * Env overrides: MESHY_API_URL / THREE_API_URL / MESHY_API_KEY / TRIPO_API_KEY.
 */
export interface D3ViewerConfig {
  /** WebSocket port for real-time model streaming */
  wsPort?: number
  /** Storage backend for generated models */
  storage?: 'local' | 'cloud' | 'memory'
  /** Enable progressive mesh refinement (streaming updates) */
  progressive?: boolean
  /** Preview quality tier */
  previewQuality?: 'thumbnail' | 'low' | 'medium' | 'high'
  /**
   * Cloud 3D generation API endpoint (optional accelerator).
   * Supports: Meshy, Tripo3D, or any compatible /v1 endpoint.
   */
  apiEndpoint?: string
  /** Cloud API key. Empty ⇒ cloud tools report "local mode" and no request is made. */
  apiKey?: string
  /** Which cloud provider id to use when apiKey is present. */
  provider?: 'meshy' | 'tripo' | 'krea'
}

/** Known free-tier / cloud 3D API endpoints. */
const DEFAULT_ENDPOINTS: Record<string, string> = {
  meshy: 'https://api.meshy.ai/openapi/v1',
  tripo: 'https://api.tripo3d.ai/v2/openapi',
  krea: 'https://api.krea.ai/api/v1/generate-3d',
}

export interface ModelMetadata {
  id: string
  name: string
  format: 'glb' | 'obj' | 'ply' | 'gltf' | 'stl'
  vertices: number
  faces: number
  thumbnail?: string
  createdAt: number
  progress?: number
  tags?: string[]
  /** 'local' (engine3d) or 'cloud' (provider). */
  source: 'local' | 'cloud'
  /** base64 mesh payload for local models. */
  data?: string
}

class D3ViewerService extends Service {
  private models: Map<string, ModelMetadata> = new Map()
  private config: Required<D3ViewerConfig>

  constructor(ctx: Context, config: D3ViewerConfig) {
    super(ctx)
    const provider = config.provider ?? 'meshy'
    this.config = {
      wsPort: config.wsPort ?? 8310,
      storage: config.storage ?? 'memory',
      progressive: config.progressive ?? true,
      previewQuality: config.previewQuality ?? 'medium',
      apiEndpoint: config.apiEndpoint
        ?? process.env.MESHY_API_URL
        ?? process.env.THREE_API_URL
        ?? DEFAULT_ENDPOINTS[provider],
      apiKey: config.apiKey ?? process.env.MESHY_API_KEY ?? process.env.TRIPO_API_KEY ?? '',
      provider,
    }
  }

  get cloudEnabled(): boolean {
    return this.config.apiKey.length > 0
  }

  start(): void {
    this.registerTools()
    this.ctx.logger.info(
      `3D Viewer Plugin initialized — local engine ON, cloud ${this.cloudEnabled ? 'ON (' + this.config.provider + ')' : 'OFF (set MESHY_API_KEY/TRIPO_API_KEY to enable)'}`,
    )
  }

  private registerTools(): void {
    const ctx = this.ctx

    // -------------------------------------------------------------------------
    // 3d_build — LOCAL, free, unlimited, no API key (embedded trimesh engine)
    // -------------------------------------------------------------------------
    ctx.tools.register({
      name: '3d_build',
      description:
        'Build a parametric 3D solid entirely offline using the embedded engine3d '
        + '(box, sphere, cylinder, cone, torus). Free, unlimited, no API key. '
        + 'Returns a base64 GLB/OBJ/PLY/STL you can view or export.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone', 'torus'], description: 'Primitive type.' },
          params: { type: 'object', description: 'Dimensions, e.g. {radius:2,subdivisions:3} or {dimensions:[1,2,3]}.' },
          format: { type: 'string', enum: ['glb', 'obj', 'ply', 'stl'], default: 'glb' },
        },
        required: ['kind'],
      },
      async execute(this: D3ViewerService, args: any) {
        const res: BridgeResponse = await buildPrimitive(args.kind, args.params ?? {}, args.format || 'glb')
        if (!res.ok) return { success: false, error: res.error ?? 'engine3d build failed' }

        const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const metadata: ModelMetadata = {
          id,
          name: `${args.kind} (${args.format || 'glb'})`,
          format: (args.format || 'glb') as ModelMetadata['format'],
          vertices: -1,
          faces: -1,
          createdAt: Date.now(),
          progress: 100,
          source: 'local',
          data: res.data,
        }
        this.models.set(id, metadata)

        return {
          success: true,
          source: 'local',
          model_id: id,
          format: metadata.format,
          preview_url: `ws://localhost:${this.config.wsPort}/model/${id}`,
          bytes: res.data ? Math.floor(res.data.length * 0.75) : 0,
        }
      },
    } as any)

    // -------------------------------------------------------------------------
    // 3d_generate — CLOUD (optional). Falls back gracefully when no key.
    // -------------------------------------------------------------------------
    ctx.tools.register({
      name: '3d_generate',
      description:
        'Generate a 3D model from a text description using a cloud provider '
        + '(Tripo3D / Meshy / compatible endpoint). Requires an API key; if none '
        + 'is set, use 3d_build for free offline geometry instead.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the 3D model.' },
          format: { type: 'string', enum: ['glb', 'obj', 'ply', 'stl'], default: 'glb' },
          quality: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
        },
        required: ['prompt'],
      },
      async execute(this: D3ViewerService, args: any) {
        if (!this.cloudEnabled) {
          return {
            success: false,
            source: 'cloud',
            error:
              'Cloud generation is disabled (no API key). '
              + 'Set MESHY_API_KEY or TRIPO_API_KEY, or call 3d_build for free offline geometry.',
          }
        }

        const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const metadata: ModelMetadata = {
          id,
          name: args.prompt.slice(0, 50),
          format: args.format || 'glb',
          vertices: 0,
          faces: 0,
          createdAt: Date.now(),
          progress: 0,
          source: 'cloud',
        }
        this.models.set(id, metadata)

        // Tripo3D async task API (works when provider === 'tripo').
        try {
          const base = this.config.apiEndpoint.replace(/\/+$/, '')
          const headers = {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          }

          if (this.config.provider === 'tripo') {
            const body = {
              type: 'text_to_model',
              prompt: args.prompt,
              model_version: 'v2.5-20250123',
            }
            const r = await fetch(`${base}/task`, { method: 'POST', headers, body: JSON.stringify(body) })
            const data = await r.json()
            const taskId = data?.data?.task_id
            return {
              success: Boolean(taskId),
              source: 'cloud',
              model_id: id,
              task_id: taskId,
              status: taskId ? 'processing' : 'failed',
              preview_url: `ws://localhost:${this.config.wsPort}/model/${id}`,
            }
          }

          // Meshy text→3D.
          const r = await fetch(`${base}/text-to-3d`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: args.prompt, should_texture: true }),
          })
          const data = await r.json()
          return {
            success: Boolean(data?.id),
            source: 'cloud',
            model_id: id,
            task_id: data?.id,
            status: data?.id ? 'processing' : 'failed',
            preview_url: `ws://localhost:${this.config.wsPort}/model/${id}`,
          }
        } catch (e) {
          return { success: false, source: 'cloud', error: String(e) }
        }
      },
    } as any)

    // -------------------------------------------------------------------------
    // 3d_query — poll cloud task status (only useful in cloud mode).
    // -------------------------------------------------------------------------
    ctx.tools.register({
      name: '3d_query',
      description: 'Check a cloud 3D generation task and fetch its result URL when ready.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id returned by 3d_generate.' },
        },
        required: ['task_id'],
      },
      async execute(this: D3ViewerService, args: any) {
        if (!this.cloudEnabled) return { success: false, error: 'cloud disabled (no API key)' }
        try {
          const base = this.config.apiEndpoint.replace(/\/+$/, '')
          const headers = { Authorization: `Bearer ${this.config.apiKey}` }
          const path = this.config.provider === 'tripo' ? `${base}/task/${args.task_id}` : `${base}/text-to-3d/${args.task_id}`
          const r = await fetch(path, { headers })
          const data = await r.json()
          return { success: true, status: data?.status ?? data?.status, raw: data }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      },
    } as any)

    // -------------------------------------------------------------------------
    // 3d_view — open a model in the web UI viewer.
    // -------------------------------------------------------------------------
    ctx.tools.register({
      name: '3d_view',
      description: 'View a 3D model in the web UI',
      parameters: {
        type: 'object',
        properties: { model_id: { type: 'string', description: 'ID of the model to view.' } },
        required: ['model_id'],
      },
      async execute(this: D3ViewerService, args: any) {
        const model = this.models.get(args.model_id)
        if (!model) return { success: false, error: 'Model not found' }
        return { success: true, model: { ...model, data: undefined }, viewUrl: `ws://localhost:${this.config.wsPort}/model/${model.id}` }
      },
    } as any)

    // -------------------------------------------------------------------------
    // 3d_list — enumerate session models.
    // -------------------------------------------------------------------------
    ctx.tools.register({
      name: '3d_list',
      description: 'List all 3D models in the workspace',
      parameters: { type: 'object', properties: { tag: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
      async execute(this: D3ViewerService, args: any) {
        let models = Array.from(this.models.values()).map(m => ({ ...m, data: undefined }))
        if (args.tag) models = models.filter(m => m.tags?.includes(args.tag))
        return { models: models.slice(0, args.limit || 50) }
      },
    } as any)

    // -------------------------------------------------------------------------
    // 3d_engine_info — report local engine health (diagnostics / CI).
    // -------------------------------------------------------------------------
    ctx.tools.register({
      name: '3d_engine_info',
      description: 'Report the offline engine3d version and available primitives.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const info = await engineInfo()
        return info.ok ? { success: true, ...info } : { success: false, error: info.error }
      },
    } as any)
  }
}

export function apply(ctx: Context, config: D3ViewerConfig): void {
  ctx.service.register(new D3ViewerService(ctx, config))
}

export default { name, inject, apply }
