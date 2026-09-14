/**
 * Tool permission 4-layer model helpers.
 *
 * Extracted from index.ts for module separation.
 *
 * @module @deepseek-ai/dsh-team-comm/permission
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR } from './shared'

/** Permission layers from most general to most specific. */
export const PERMISSION_LAYERS = ['deployment', 'role', 'agent', 'task'] as const

/** Read permission rules for a layer. */
export function readPermissionRules(cwd: string, layer: string, scope: string): Record<string, boolean> {
  const file = join(cwd, TEAM_DIR, 'permissions', layer, `${scope}.json`)
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

/** Write permission rules for a layer. */
export function writePermissionRules(cwd: string, layer: string, scope: string, rules: Record<string, boolean>): void {
  const dir = join(cwd, TEAM_DIR, 'permissions', layer)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${scope}.json`)
  const fd = openSync(file, 'w')
  try { writeFileSync(fd, JSON.stringify(rules, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
}
