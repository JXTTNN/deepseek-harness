/**
 * Spawn helper functions for subagent delegation with skill injection.
 *
 * Extracted from index.ts for module separation. Contains types, constants,
 * and helper functions for:
 * - Subagent spawn record management
 * - Skill rendering for prompt injection
 * - Spawn record persistence in .team/spawns/
 *
 * Note: loadSkillsForSpawn() is NOT in this module because it depends on
 * the skillsService from ctx. It remains in index.ts.
 *
 * @module @deepseek-ai/dsh-team-comm/spawn
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd } from './shared'

/** Default subagent provider. */
export const DEFAULT_SPAWN_PROVIDER = 'spawn'

/** Default max delegation depth. */
export const DEFAULT_SPAWN_MAX_DEPTH = 3

/** Spawn record stored in .team/spawns/<childId>.json */
export interface SpawnRecord {
  childId: string
  parentSessionId: string
  label: string
  mode: 'one-shot' | 'continuable'
  provider: string
  role: string | undefined
  depth: number | undefined
  skills: string[] | undefined
  spawnedAt: number
}

/** Render a loaded skill definition into a prompt-prefix block. */
export function renderSkillForPrompt(skill: { name: string; content: string; description?: string }): string {
  return [
    `<skill_content name="${skill.name}">`,
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Write a spawn record to .team/spawns/ for team visibility. */
export function writeSpawnRecord(
  agent: { session: { id: string; header?: { cwd?: string } } },
  childId: string,
  spec: {
    label: string
    mode: 'one-shot' | 'continuable'
    provider: string
    role: string | undefined
    depth: number | undefined
    skills: string[] | undefined
  },
): void {
  const cwd = teamCwd(agent)
  const spawnsDir = join(cwd, TEAM_DIR, 'spawns')
  mkdirSync(spawnsDir, { recursive: true })
  const record: SpawnRecord = {
    childId,
    parentSessionId: agent.session.id,
    label: spec.label,
    mode: spec.mode,
    provider: spec.provider,
    role: spec.role,
    depth: spec.depth,
    skills: spec.skills,
    spawnedAt: Date.now(),
  }
  const file = join(spawnsDir, `${childId}.json`)
  const fd = openSync(file, 'w')
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** List spawn records for a parent session. */
export function listSpawnRecords(
  agent: { session: { id: string; header?: { cwd?: string } } },
): SpawnRecord[] {
  const cwd = teamCwd(agent)
  const spawnsDir = join(cwd, TEAM_DIR, 'spawns')
  if (!existsSync(spawnsDir)) return []
  const records: SpawnRecord[] = []
  for (const file of readdirSync(spawnsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = readFileSync(join(spawnsDir, file), 'utf8')
      const rec = JSON.parse(raw) as SpawnRecord
      if (rec.parentSessionId === agent.session.id) records.push(rec)
    } catch { /* skip corrupt */ }
  }
  return records.sort((a, b) => a.spawnedAt - b.spawnedAt)
}
