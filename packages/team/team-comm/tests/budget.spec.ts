import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createBudget,
  readBudget,
  findBudgetBySession,
  listBudgets,
  recordUsage,
  checkBudget,
  updateBudget,
  resetUsage,
  deleteBudget,
} from '../src/budget'

const TMP = join(tmpdir(), `budget-test-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('budget', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  describe('createBudget', () => {
    it('should create a budget with defaults', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, {})
      expect(b.id).toBeDefined()
      expect(b.sessionId).toBe('s1')
      expect(b.tokenLimit).toBe(100_000)
      expect(b.tokenUsed).toBe(0)
      expect(b.callLimit).toBe(100)
      expect(b.callUsed).toBe(0)
      expect(b.status).toBe('active')
    })

    it('should create a budget with custom limits', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, {
        sessionId: 's2',
        tokenLimit: 5000,
        callLimit: 10,
        timeWindowMs: 30_000,
      })
      expect(b.sessionId).toBe('s2')
      expect(b.tokenLimit).toBe(5000)
      expect(b.callLimit).toBe(10)
      expect(b.timeWindowMs).toBe(30_000)
    })
  })

  describe('readBudget', () => {
    it('should read a budget by id', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, {})
      const read = readBudget(agent, b.id)
      expect(read).toBeDefined()
      expect(read!.id).toBe(b.id)
    })

    it('should return undefined for non-existent', () => {
      const agent = makeAgent('s1', TMP)
      expect(readBudget(agent, 'nonexistent')).toBeUndefined()
    })
  })

  describe('findBudgetBySession', () => {
    it('should find an active budget by session id', () => {
      const agent = makeAgent('s1', TMP)
      createBudget(agent, { sessionId: 's2', tokenLimit: 1000 })
      const found = findBudgetBySession(agent, 's2')
      expect(found).toBeDefined()
      expect(found!.sessionId).toBe('s2')
    })

    it('should return undefined if no active budget', () => {
      const agent = makeAgent('s1', TMP)
      expect(findBudgetBySession(agent, 's2')).toBeUndefined()
    })
  })

  describe('listBudgets', () => {
    it('should return empty when none exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(listBudgets(agent)).toEqual([])
    })

    it('should list all budgets', async () => {
      const agent = makeAgent('s1', TMP)
      createBudget(agent, { sessionId: 's1' })
      await new Promise(r => setTimeout(r, 2))
      createBudget(agent, { sessionId: 's2' })
      const list = listBudgets(agent)
      expect(list).toHaveLength(2)
    })

    it('should filter by status', () => {
      const agent = makeAgent('s1', TMP)
      const b1 = createBudget(agent, { sessionId: 's1', tokenLimit: 10 })
      createBudget(agent, { sessionId: 's2', tokenLimit: 100_000 })
      recordUsage(agent, b1.id, 20, 1)
      const active = listBudgets(agent, { status: 'active' })
      expect(active).toHaveLength(1)
      expect(active[0]!.sessionId).toBe('s2')
    })
  })

  describe('recordUsage', () => {
    it('should record token and call usage', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 1000, callLimit: 10 })
      const updated = recordUsage(agent, b.id, 100, 1)
      expect(updated!.tokenUsed).toBe(100)
      expect(updated!.callUsed).toBe(1)
    })

    it('should mark budget as exceeded when token limit reached', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100, callLimit: 10 })
      const updated = recordUsage(agent, b.id, 100, 1)
      expect(updated!.status).toBe('exceeded')
    })

    it('should mark budget as exceeded when call limit reached', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100_000, callLimit: 2 })
      recordUsage(agent, b.id, 10, 1)
      const updated = recordUsage(agent, b.id, 10, 1)
      expect(updated!.status).toBe('exceeded')
    })

    it('should throw if budget is not active', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100 })
      updateBudget(agent, b.id, { status: 'paused' })
      expect(() => recordUsage(agent, b.id, 10, 1)).toThrow('paused')
    })
  })

  describe('checkBudget', () => {
    it('should return not exceeded for active budget', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 1000, callLimit: 10 })
      const check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(false)
      expect(check!.remainingTokens).toBe(1000)
      expect(check!.remainingCalls).toBe(10)
    })

    it('should return exceeded when token limit reached', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100, callLimit: 10 })
      recordUsage(agent, b.id, 100, 1)
      const check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(true)
      expect(check!.reason).toBe('token limit reached')
    })

    it('should return exceeded when call limit reached', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100_000, callLimit: 1 })
      recordUsage(agent, b.id, 10, 1)
      const check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(true)
      expect(check!.reason).toBe('call limit reached')
    })

    it('should return exceeded for paused budget', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, {})
      updateBudget(agent, b.id, { status: 'paused' })
      const check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(true)
      expect(check!.reason).toBe('budget is paused')
    })
  })

  describe('updateBudget', () => {
    it('should update token limit', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100 })
      const updated = updateBudget(agent, b.id, { tokenLimit: 500 })
      expect(updated!.tokenLimit).toBe(500)
    })

    it('should reactivate exceeded budget when limits increased', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100, callLimit: 10 })
      recordUsage(agent, b.id, 100, 1)
      expect(readBudget(agent, b.id)!.status).toBe('exceeded')
      const updated = updateBudget(agent, b.id, { tokenLimit: 500 })
      expect(updated!.status).toBe('active')
    })

    it('should update status', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, {})
      const updated = updateBudget(agent, b.id, { status: 'paused' })
      expect(updated!.status).toBe('paused')
    })
  })

  describe('resetUsage', () => {
    it('should reset usage counters', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 100, callLimit: 10 })
      recordUsage(agent, b.id, 50, 5)
      const reset = resetUsage(agent, b.id)
      expect(reset!.tokenUsed).toBe(0)
      expect(reset!.callUsed).toBe(0)
      expect(reset!.status).toBe('active')
    })
  })

  describe('deleteBudget', () => {
    it('should delete a budget', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, {})
      expect(deleteBudget(agent, b.id)).toBe(true)
      expect(readBudget(agent, b.id)).toBeUndefined()
    })

    it('should return false for non-existent', () => {

      const agent = makeAgent('s1', TMP)
      expect(deleteBudget(agent, 'nonexistent')).toBe(false)
    })
  })

  describe('full budget lifecycle', () => {
    it('should support create → use → check → exceed → update → reset', () => {
      const agent = makeAgent('s1', TMP)
      const b = createBudget(agent, { tokenLimit: 200, callLimit: 5 })

      // Use some budget
      recordUsage(agent, b.id, 50, 1)
      let check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(false)
      expect(check!.remainingTokens).toBe(150)

      // Use more
      recordUsage(agent, b.id, 150, 3)
      check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(true)

      // Increase limit
      updateBudget(agent, b.id, { tokenLimit: 500 })
      check = checkBudget(agent, b.id)
      expect(check!.exceeded).toBe(false)

      // Reset
      resetUsage(agent, b.id)
      check = checkBudget(agent, b.id)
      expect(check!.tokenUsed).toBe(0)
      expect(check!.remainingTokens).toBe(500)
    })
  })
})