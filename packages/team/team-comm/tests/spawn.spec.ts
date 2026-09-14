import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_SPAWN_PROVIDER,
  DEFAULT_SPAWN_MAX_DEPTH,

  renderSkillForPrompt,
  writeSpawnRecord,
  listSpawnRecords,
} from '../src/spawn'

const TMP = join(tmpdir(), `dsh-spawn-test-${Date.now()}`)


function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('spawn module', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // -- Constants --

  describe('DEFAULT_SPAWN_PROVIDER', () => {
    it('should be "spawn"', () => {
      expect(DEFAULT_SPAWN_PROVIDER).toBe('spawn')
    })
  })

  describe('DEFAULT_SPAWN_MAX_DEPTH', () => {
    it('should be 3', () => {
      expect(DEFAULT_SPAWN_MAX_DEPTH).toBe(3)
    })
  })

  // -- renderSkillForPrompt --

  describe('renderSkillForPrompt', () => {
    it('should render a skill into XML-like prompt block', () => {
      const result = renderSkillForPrompt({ name: 'code-review', content: 'Review code carefully.' })
      expect(result).toContain('<skill_content name="code-review">')
      expect(result).toContain('<skill_instructions>')
      expect(result).toContain('Review code carefully.')
      expect(result).toContain('</skill_instructions>')
      expect(result).toContain('</skill_content>')
    })

    it('should handle empty content', () => {
      const result = renderSkillForPrompt({ name: 'empty', content: '' })
      expect(result).toContain('<skill_content name="empty">')
      expect(result).toContain('<skill_instructions>')
      expect(result).toContain('</skill_instructions>')
    })
  })

  // -- writeSpawnRecord / listSpawnRecords --

  describe('writeSpawnRecord / listSpawnRecords', () => {
    it('should write a spawn record and list it', () => {
      const agent = makeAgent('parent-session', TMP)
      writeSpawnRecord(agent, 'child-1', {
        label: 'research task',
        mode: 'one-shot',
        provider: 'spawn',
        role: undefined,
        depth: 1,
        skills: ['code-review'],
      })

      const records = listSpawnRecords(agent)
      expect(records).toHaveLength(1)
      expect(records[0]!.childId).toBe('child-1')
      expect(records[0]!.parentSessionId).toBe('parent-session')
      expect(records[0]!.label).toBe('research task')
      expect(records[0]!.mode).toBe('one-shot')
      expect(records[0]!.skills).toEqual(['code-review'])
    })

    it('should only list records for the calling parent session', () => {
      const parent1 = makeAgent('parent-1', TMP)
      const parent2 = makeAgent('parent-2', TMP)

      writeSpawnRecord(parent1, 'child-a', {
        label: 'task A',
        mode: 'one-shot',
        provider: 'spawn',
        role: undefined,
        depth: 1,
        skills: [],
      })
      writeSpawnRecord(parent2, 'child-b', {
        label: 'task B',
        mode: 'continuable',
        provider: 'fork',
        role: 'worker',
        depth: 2,
        skills: ['deep-research'],
      })

      expect(listSpawnRecords(parent1)).toHaveLength(1)
      expect(listSpawnRecords(parent1)[0]!.childId).toBe('child-a')
      expect(listSpawnRecords(parent2)).toHaveLength(1)
      expect(listSpawnRecords(parent2)[0]!.childId).toBe('child-b')
    })

    it('should return empty array when no spawns directory exists', () => {
      const agent = makeAgent('lonely', TMP)
      expect(listSpawnRecords(agent)).toEqual([])
    })

    it('should sort records by spawnedAt ascending', () => {
      const agent = makeAgent('parent', TMP)
      writeSpawnRecord(agent, 'child-2', {
        label: 'second',
        mode: 'one-shot',
        provider: 'spawn',
        role: undefined,
        depth: 1,
        skills: [],
      })
      // Small delay to ensure different timestamps
      writeSpawnRecord(agent, 'child-1', {
        label: 'first',
        mode: 'one-shot',
        provider: 'spawn',
        role: undefined,
        depth: 1,
        skills: [],
      })

      const records = listSpawnRecords(agent)
      // Both should be present, sorted by spawnedAt
      expect(records).toHaveLength(2)
      expect(records[0]!.spawnedAt).toBeLessThanOrEqual(records[1]!.spawnedAt)
    })
  })
})