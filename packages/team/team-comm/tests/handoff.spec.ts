import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createHandoff,
  readHandoff,
  listHandoffs,
  acceptHandoff,
  rejectHandoff,
  completeHandoff,
  cancelHandoff,
  deleteHandoff,
} from '../src/handoff'

const TMP = join(tmpdir(), `handoff-test-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('handoff', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  describe('createHandoff', () => {
    it('should create a handoff request', () => {
      const agent = makeAgent('s1', TMP)
      const h = createHandoff(agent, {
        taskId: 'task-1',
        toSession: 's2',
        reason: 'Need help with testing',
        context: 'Currently working on test file X',
      })
      expect(h.id).toBeDefined()
      expect(h.taskId).toBe('task-1')
      expect(h.fromSession).toBe('s1')
      expect(h.toSession).toBe('s2')
      expect(h.reason).toBe('Need help with testing')
      expect(h.context).toBe('Currently working on test file X')
      expect(h.status).toBe('pending')
    })

    it('should throw if taskId missing', () => {
      const agent = makeAgent('s1', TMP)
      expect(() => createHandoff(agent, {
        taskId: '',
        toSession: 's2',
        reason: 'test',
        context: 'test',
      })).toThrow('taskId required')
    })

    it('should throw if toSession missing', () => {
      const agent = makeAgent('s1', TMP)
      expect(() => createHandoff(agent, {
        taskId: 'task-1',
        toSession: '',
        reason: 'test',
        context: 'test',
      })).toThrow('toSession required')
    })
  })

  describe('readHandoff', () => {
    it('should read a handoff by id', () => {
      const agent = makeAgent('s1', TMP)
      const h = createHandoff(agent, {
        taskId: 'task-1',
        toSession: 's2',
        reason: 'test',
        context: 'test',
      })
      const read = readHandoff(agent, h.id)
      expect(read).toBeDefined()
      expect(read!.id).toBe(h.id)
    })

    it('should return undefined for non-existent', () => {
      const agent = makeAgent('s1', TMP)
      expect(readHandoff(agent, 'nonexistent')).toBeUndefined()
    })
  })

  describe('listHandoffs', () => {
    it('should return empty when none exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(listHandoffs(agent)).toEqual([])
    })

    it('should list all handoffs', async () => {
      const agent = makeAgent('s1', TMP)
      createHandoff(agent, { taskId: 't1', toSession: 's2', reason: 'r1', context: 'c1' })
      await new Promise(r => setTimeout(r, 2))
      createHandoff(agent, { taskId: 't2', toSession: 's3', reason: 'r2', context: 'c2' })
      const list = listHandoffs(agent)
      expect(list).toHaveLength(2)
    })

    it('should filter by status', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      acceptHandoff(agent2, h.id)
      const pending = listHandoffs(agent1, { status: 'pending' })
      const accepted = listHandoffs(agent1, { status: 'accepted' })
      expect(pending).toHaveLength(0)
      expect(accepted).toHaveLength(1)
    })

    it('should filter by fromSession', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      createHandoff(agent1, { taskId: 't1', toSession: 's3', reason: 'r', context: 'c' })
      createHandoff(agent2, { taskId: 't2', toSession: 's3', reason: 'r', context: 'c' })
      const fromS1 = listHandoffs(agent1, { fromSession: 's1' })
      expect(fromS1).toHaveLength(1)
      expect(fromS1[0]!.fromSession).toBe('s1')
    })

    it('should filter by toSession', () => {
      const agent = makeAgent('s1', TMP)
      createHandoff(agent, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      createHandoff(agent, { taskId: 't2', toSession: 's3', reason: 'r', context: 'c' })
      const toS2 = listHandoffs(agent, { toSession: 's2' })
      expect(toS2).toHaveLength(1)
      expect(toS2[0]!.toSession).toBe('s2')
    })
  })

  describe('acceptHandoff', () => {
    it('should accept a pending handoff', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      const accepted = acceptHandoff(agent2, h.id)
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.acceptedAt).toBeDefined()
    })

    it('should throw if not the target session', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent3 = makeAgent('s3', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      expect(() => acceptHandoff(agent3, h.id)).toThrow('for s2, not s3')
    })

    it('should throw if already accepted', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      acceptHandoff(agent2, h.id)
      expect(() => acceptHandoff(agent2, h.id)).toThrow('accepted')
    })
  })

  describe('rejectHandoff', () => {
    it('should reject a pending handoff', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      const rejected = rejectHandoff(agent2, h.id)
      expect(rejected!.status).toBe('rejected')
    })

    it('should throw if not the target session', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent3 = makeAgent('s3', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      expect(() => rejectHandoff(agent3, h.id)).toThrow('for s2, not s3')
    })
  })

  describe('completeHandoff', () => {
    it('should complete an accepted handoff', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      acceptHandoff(agent2, h.id)
      const completed = completeHandoff(agent2, h.id)
      expect(completed!.status).toBe('completed')
      expect(completed!.completedAt).toBeDefined()
    })

    it('should throw if not accepted yet', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      expect(() => completeHandoff(agent2, h.id)).toThrow('pending')
    })

    it('should throw if not the target session', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent3 = makeAgent('s3', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      expect(() => completeHandoff(agent3, h.id)).toThrow('for s2, not s3')
    })
  })

  describe('cancelHandoff', () => {
    it('should cancel a pending handoff', () => {
      const agent1 = makeAgent('s1', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      const cancelled = cancelHandoff(agent1, h.id)
      expect(cancelled!.status).toBe('cancelled')
    })

    it('should throw if not the originator', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      expect(() => cancelHandoff(agent2, h.id)).toThrow('Only the originator')
    })

    it('should throw if already completed', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const h = createHandoff(agent1, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      acceptHandoff(agent2, h.id)
      completeHandoff(agent2, h.id)
      expect(() => cancelHandoff(agent1, h.id)).toThrow('already completed')
    })
  })

  describe('deleteHandoff', () => {
    it('should delete a handoff', () => {
      const agent = makeAgent('s1', TMP)
      const h = createHandoff(agent, { taskId: 't1', toSession: 's2', reason: 'r', context: 'c' })
      expect(deleteHandoff(agent, h.id)).toBe(true)
      expect(readHandoff(agent, h.id)).toBeUndefined()
    })

    it('should return false for non-existent', () => {
      const agent = makeAgent('s1', TMP)
      expect(deleteHandoff(agent, 'nonexistent')).toBe(false)
    })
  })

  describe('full handoff lifecycle', () => {
    it('should support create -> accept -> complete', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)

      const h = createHandoff(agent1, {
        taskId: 'task-42',
        toSession: 's2',
        reason: 'I am stuck on the database migration',
        context: 'Working on migration script, got error at line 15',
      })
      expect(h.status).toBe('pending')

      const accepted = acceptHandoff(agent2, h.id)
      expect(accepted!.status).toBe('accepted')

      const completed = completeHandoff(agent2, h.id)
      expect(completed!.status).toBe('completed')
    })

    it('should support create -> reject', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)

      const h = createHandoff(agent1, {
        taskId: 'task-42',
        toSession: 's2',
        reason: 'Need help',
        context: 'Working on frontend',
      })
      const rejected = rejectHandoff(agent2, h.id)
      expect(rejected!.status).toBe('rejected')
    })

    it('should support create -> cancel', () => {
      const agent1 = makeAgent('s1', TMP)

      const h = createHandoff(agent1, {
        taskId: 'task-42',
        toSession: 's2',
        reason: 'Need help',
        context: 'Working on frontend',
      })
      const cancelled = cancelHandoff(agent1, h.id)
      expect(cancelled!.status).toBe('cancelled')
    })
  })
})
