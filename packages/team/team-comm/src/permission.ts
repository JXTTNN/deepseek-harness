/**
 * Tool permission 4-layer model helpers.
 *
 * Extracted from index.ts for module separation.
 *
 * @module @deepseek-ai/dsh-team-comm/permission
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { TEAM_DIR, assertSafeTeamId } from './shared'

/** Permission layers from most general to most specific. */
export const PERMISSION_LAYERS = ['deployment', 'role', 'agent', 'task'] as const

/**
 * Resolve `<team>/permissions/<layer>/<scope>.json`.
 *
 * Both components come from tool arguments the model controls and are
 * interpolated into a path, so both are validated: `deployment`/`role`/`agent`/
 * `task` are the only legal layers, and a scope containing a separator or `..`
 * would otherwise escape `.team/permissions/`.
 */
function permissionFile(cwd: string, layer: string, scope: string): string {
  assertSafeTeamId(layer, 'permission layer')
  assertSafeTeamId(scope, 'permission scope')
  return join(cwd, TEAM_DIR, 'permissions', layer, `${scope}.json`)
}

/** Read permission rules for a layer. */
export function readPermissionRules(cwd: string, layer: string, scope: string): Record<string, boolean> {
  const file = permissionFile(cwd, layer, scope)
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

/** Write permission rules for a layer. */
export function writePermissionRules(cwd: string, layer: string, scope: string, rules: Record<string, boolean>): void {
  const file = permissionFile(cwd, layer, scope)
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
  try { writeFileSync(fd, JSON.stringify(rules, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
}
