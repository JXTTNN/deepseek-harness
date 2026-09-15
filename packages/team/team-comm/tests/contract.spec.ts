import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createContract,
  readContract,
  listContracts,
  updateContractStatus,
  verifyContract,

} from '../src/contract'

const TMP = join(tmpdir(), `dsh-contract-test-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('contract module', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // -- createContract --

  describe('createContract', () => {
    it('should create a contract with status proposed', () => {
      const agent = makeAgent('producer-1', TMP)
      const contract = createContract(agent, {
        consumer: 'consumer-1',
        description: 'Deliver test results',
        outputSchema: { status: 'string', count: 'number' },
      })
      expect(contract.status).toBe('proposed')
      expect(contract.producer).toBe('producer-1')
      expect(contract.consumer).toBe('consumer-1')
      expect(contract.id).toBeDefined()
      expect(contract.createdAt).toBeDefined()
    })

    it('should include optional fields when provided', () => {
      const agent = makeAgent('p1', TMP)
      const contract = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string' },
        inputSchema: { query: 'string' },
        deadline: '2026-12-31T00:00:00.000Z',
      })
      expect(contract.inputSchema).toEqual({ query: 'string' })
      expect(contract.deadline).toBe('2026-12-31T00:00:00.000Z')
    })

    it('should not include optional fields when omitted', () => {
      const agent = makeAgent('p1', TMP)
      const contract = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string' },
      })
      expect(contract.inputSchema).toBeUndefined()
      expect(contract.deadline).toBeUndefined()
    })
  })

  // -- readContract --

  describe('readContract', () => {
    it('should return undefined when contract does not exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(readContract(agent, 'nonexistent')).toBeUndefined()
    })

    it('should read a created contract', () => {
      const agent = makeAgent('p1', TMP)
      const created = createContract(agent, {
        consumer: 'c1',
        description: 'Deliver data',
        outputSchema: { data: 'string' },
      })
      const read = readContract(agent, created.id)
      expect(read).toBeDefined()
      expect(read!.id).toBe(created.id)
      expect(read!.description).toBe('Deliver data')
    })
  })

  // -- listContracts --

  describe('listContracts', () => {
    it('should return empty when no contracts exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(listContracts(agent)).toEqual([])
    })

    it('should list all contracts sorted by createdAt', async () => {
      const agent = makeAgent('p1', TMP)
      const c1 = createContract(agent, { consumer: 'c1', description: 'A', outputSchema: {} })
      await new Promise(r => setTimeout(r, 2))
      const c2 = createContract(agent, { consumer: 'c2', description: 'B', outputSchema: {} })
      const list = listContracts(agent)
      expect(list).toHaveLength(2)
      expect(list[0]!.id).toBe(c1.id)
      expect(list[1]!.id).toBe(c2.id)
    })

    it('should filter by status', () => {
      const agent = makeAgent('p1', TMP)
      createContract(agent, { consumer: 'c1', description: 'A', outputSchema: {} })
      const list = listContracts(agent, { status: 'proposed' })
      expect(list).toHaveLength(1)
      expect(list[0]!.status).toBe('proposed')
    })

    it('should filter by participant', () => {
      const agent = makeAgent('p1', TMP)
      createContract(agent, { consumer: 'c1', description: 'A', outputSchema: {} })
      const asProducer = listContracts(agent, { participant: 'p1' })
      const asConsumer = listContracts(agent, { participant: 'c1' })
      const asUnrelated = listContracts(agent, { participant: 'x' })
      expect(asProducer).toHaveLength(1)
      expect(asConsumer).toHaveLength(1)
      expect(asUnrelated).toHaveLength(0)
    })
  })

  // -- updateContractStatus --

  describe('updateContractStatus', () => {
    it('should update status to accepted', () => {
      const agent = makeAgent('p1', TMP)
      const created = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string' },
      })
      const updated = updateContractStatus(agent, created.id, 'accepted')
      expect(updated).toBeDefined()
      expect(updated!.status).toBe('accepted')
      expect(updated!.acceptedAt).toBeDefined()
    })

    it('should update status to delivered with deliverable', () => {
      const agent = makeAgent('p1', TMP)
      const created = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string' },
      })
      const deliverable = { result: 'success' }
      const updated = updateContractStatus(agent, created.id, 'delivered', { deliverable })
      expect(updated).toBeDefined()
      expect(updated!.status).toBe('delivered')
      expect(updated!.deliveredAt).toBeDefined()
      expect(updated!.deliverable).toEqual(deliverable)
    })

    it('should return undefined for nonexistent contract', () => {
      const agent = makeAgent('p1', TMP)
      expect(updateContractStatus(agent, 'nope', 'accepted')).toBeUndefined()
    })
  })

  // -- verifyContract --

  describe('verifyContract', () => {
    it('should return invalid when contract not found', () => {
      const agent = makeAgent('s1', TMP)
      const result = verifyContract(agent, 'nonexistent')
      expect(result.valid).toBe(false)
      expect(result.contract).toBeUndefined()
    })

    it('should return invalid when not yet delivered', () => {
      const agent = makeAgent('p1', TMP)
      const created = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string' },
      })
      const result = verifyContract(agent, created.id)
      expect(result.valid).toBe(false)
      expect(result.missing).toContain('deliverable')
    })

    it('should verify a delivered contract with all expected keys', () => {
      const agent = makeAgent('p1', TMP)
      const created = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string', count: 'number' },
      })
      updateContractStatus(agent, created.id, 'delivered', {
        deliverable: { result: 'ok', count: 5 },
      })
      const result = verifyContract(agent, created.id)
      expect(result.valid).toBe(true)
      expect(result.missing).toEqual([])
    })

    it('should detect missing keys in deliverable', () => {
      const agent = makeAgent('p1', TMP)
      const created = createContract(agent, {
        consumer: 'c1',
        description: 'Task',
        outputSchema: { result: 'string', count: 'number', extra: 'string' },
      })
      updateContractStatus(agent, created.id, 'delivered', {
        deliverable: { result: 'ok' },
      })
      const result = verifyContract(agent, created.id)
      expect(result.valid).toBe(false)
      expect(result.missing).toContain('count')
      expect(result.missing).toContain('extra')
    })
  })
})