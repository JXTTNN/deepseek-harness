/**
 * 3D Engine TypeScript Bridge
 *
 * Calls the offline Python `engine3d` module via child_process.
 * This gives dsh agents free, unlimited local 3D geometry generation
 * (box, sphere, cylinder, torus, extrude) with GLB/OBJ/PLY export.
 * No API key needed. The cloud provider (Tripo/Meshy) is a separate
 * optional layer invoked by the `3d_generate_cloud` tool.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Python interpreter path (overridable via ENGINE3D_PYTHON env). */
const PYTHON_BIN = process.env.ENGINE3D_PYTHON ?? 'python3'

/** Module entry point resolved relative to repo root. */
const MODULE_ENTRY = 'engine3d.cli'

export interface BridgeRequest {
  action: 'build' | 'info'
  kind?: string       // box|sphere|cylinder|cone|torus
  params?: Record<string, unknown>
  format?: 'glb' | 'obj' | 'ply' | 'stl'
}

export interface BridgeResponse {
  ok: boolean
  format?: string
  data?: string   // base64 encoded mesh data
  error?: string
}

/**
 * Run the offline Python 3D engine and return its JSON response.
 * Timeout defaults to 30 s; geometry ops are O(1) to O(10k faces) so this
 * is extremely generous.
 */
export async function callEngine3d(request: BridgeRequest, timeoutMs = 30_000): Promise<BridgeResponse> {
  const input = JSON.stringify(request)

  const { stdout, stderr } = await execFileAsync(
    PYTHON_BIN,
    ['-m', MODULE_ENTRY],
    {
      input,
      timeout: timeoutMs,
      encoding: 'utf-8',
      env: { ...process.env },
    } as any,
  )

  // Engine3d always writes valid JSON to stdout, even on error.
  try {
    return JSON.parse(String(stdout)) as BridgeResponse
  } catch {
    return { ok: false, error: `engine3d parse failure: stdout=${stdout}  stderr=${stderr}` }
  }
}

/**
 * Build a local primitive mesh. Returns base64-encoded GLB by default.
 */
export async function buildPrimitive(
  kind: string,
  params: Record<string, unknown> = {},
  format: 'glb' | 'obj' | 'ply' | 'stl' = 'glb',
): Promise<BridgeResponse> {
  return callEngine3d({ action: 'build', kind, params, format })
}

/**
 * Quick health check – returns the engine version and available primitives.
 */
export async function engineInfo(): Promise<BridgeResponse> {
  return callEngine3d({ action: 'info' }, 5_000)
}