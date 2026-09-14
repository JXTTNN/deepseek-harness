import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ELECTION_LEASE_MS,
  type ElectionRecord,
  readElection, writeElection, electLeader,
  type RoleDefinition,
  readRole, writeRole,
  type RoleAssignments,
  readRoleAssignments, writeRoleAssignments,
  readAutoAssignState, writeAutoAssignState,
  type AgentSpec,
  readAgentSpec, writeAgentSpec,
} from '../src/election'

const TMP = join(tmpdir(), `dsh-election-test-${Date.now()}`)
const TEAM_DIR = '.team'

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('election module', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // -- Constants --

  describe('ELECTION_LEASE_MS', () => {
    it('should be 5 minutes', () => {
      expect(ELECTION_LEASE_MS).toBe(5 * 60_000)
    })
  })

  // -- Election --

  describe('readElection / writeElection', () => {
    it('should return undefined when no election file exists', () => {
      const agent = makeAgent('s1', TMP)
      expect(readElection(agent, 'coordinator')).toBeUndefined()
    })

    it('should write and read an election record', () => {
      const agent = makeAgent('s1', TMP)
      const record: ElectionRecord = {
        role: 'coordinator',
        leader: 's1',
        leaseExpires: new Date(Date.now() + ELECTION_LEASE_MS).toISOString(),
        electedAt: new Date().toISOString(),
        voters: ['s1', 's2'],
      }
      writeElection(agent, record)
      const read = readElection(agent, 'coordinator')
      expect(read).toBeDefined()
      expect(read!.role).toBe('coordinator')
      expect(read!.leader).toBe('s1')
      expect(read!.voters).toEqual(['s1', 's2'])
    })

    it('should handle corrupted election files gracefully', () => {
      const agent = makeAgent('s1', TMP)
      const dir = join(TMP, TEAM_DIR, 'election')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'coordinator.json'), 'not json')
      expect(readElection(agent, 'coordinator')).toBeUndefined()
    })
  })

  describe('electLeader', () => {
    it('should elect the smallest session id among live peers', () => {
      const agent = makeAgent('session-aaa', TMP)
      // Create presence files for peers (must include id, name, ts to be valid)
      const presenceDir = join(TMP, TEAM_DIR, 'presence')
      mkdirSync(presenceDir, { recursive: true })
      const now = new Date().toISOString()
      writeFileSync(join(presenceDir, 'session-aaa.json'), JSON.stringify({ id: 'session-aaa', name: 'aaa', ts: now }))
      writeFileSync(join(presenceDir, 'session-zzz.json'), JSON.stringify({ id: 'session-zzz', name: 'zzz', ts: now }))
      writeFileSync(join(presenceDir, 'session-bbb.json'), JSON.stringify({ id: 'session-bbb', name: 'bbb', ts: now }))

      const record = electLeader(agent, 'coordinator')
      expect(record.leader).toBe('session-aaa')
      expect(record.role).toBe('coordinator')
      expect(record.voters).toContain('session-aaa')
      expect(record.voters).toContain('session-bbb')
      expect(record.voters).toContain('session-zzz')
    })

    it('should elect self when no peers are present', () => {
      const agent = makeAgent('session-alone', TMP)
      const record = electLeader(agent, 'solo-role')
      expect(record.leader).toBe('session-alone')
    })
  })

  // -- Roles --

  describe('readRole / writeRole', () => {
    it('should return undefined when no role file exists', () => {
      const agent = makeAgent('s1', TMP)
      expect(readRole(agent, 'developer')).toBeUndefined()
    })

    it('should write and read a role definition', () => {
      const agent = makeAgent('s15', TMP)
      const role: RoleDefinition = {
        name: 'developer',
        capabilities: ['read', 'write'],
        writeSet: ['src/**/*.ts'],
        tools: ['edit', 'bash'],
        definedAt: new Date().toISOString(),
      }
      writeRole(agent, role)
      const read = readRole(agent, 'developer')
      expect(read).toBeDefined()
      expect(read!.name).toBe('developer')
      expect(read!.capabilities).toEqual(['read', 'write'])
      expect(read!.writeSet).toEqual(['src/**/*.ts'])
    })
  })

  describe('readRoleAssignments / writeRoleAssignments', () => {
    it('should return empty when no assignments file exists', () => {
      const agent = makeAgent('s1', TMP)
      expect(readRoleAssignments(agent)).toEqual({})
    })

    it('should write and read role assignments', () => {
      const agent = makeAgent('s1', TMP)
      const assignments: RoleAssignments = { 'session-a': 'developer', 'session-b': 'reviewer' }
      writeRoleAssignments(agent, assignments)
      const read = readRoleAssignments(agent)
      expect(read).toEqual(assignments)
    })
  })

  // -- Auto-assign state --

  describe('readAutoAssignState / writeAutoAssignState', () => {
    it('should return { roundRobinIndex: 0 } when no state file exists', () => {
      const agent = makeAgent('s1', TMP)
      expect(readAutoAssignState(agent)).toEqual({ roundRobinIndex: 0 })
    })

    it('should write and read auto-assign state', () => {
      const agent = makeAgent('s1', TMP)
      writeAutoAssignState(agent, { roundRobinIndex: 5 })
      const read = readAutoAssignState(agent)
      expect(read.roundRobinIndex).toBe(5)
    })
  })

  // -- Agent specs --

  describe('readAgentSpec / writeAgentSpec', () => {
    it('should return undefined when no agent spec file exists', () => {
      const agent = makeAgent('s1', TMP)
      expect(readAgentSpec(agent, 'researcher')).toBeUndefined()
    })

    it('should write and read an agent spec', () => {
      const agent = makeAgent('s1', TMP)
      const spec: AgentSpec = {
        name: 'researcher',
        description: 'Research agent',
        model: 'deepseek-chat',
        tools: ['web_search', 'read'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      writeAgentSpec(agent, spec)
      const read = readAgentSpec(agent, 'researcher')
      expect(read).toBeDefined()
      expect(read!.name).toBe('researcher')
      expect(read!.model).toBe('deepseek-chat')
      expect(read!.tools).toEqual(['web_search', 'read'])
    })
  })
})