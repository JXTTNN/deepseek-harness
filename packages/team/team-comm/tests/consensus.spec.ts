import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createConsensus,
  readConsensus,
  listConsensus,
  addParticipant,
  submitResponse,
  startCrossReview,
  getCrossReviewPrompt,
  synthesizeConsensus,
  cancelConsensus,
  deleteConsensus,
} from '../src/consensus'

const TMP = join(tmpdir(), `consensus-test-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('consensus', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  describe('createConsensus', () => {
    it('should create a consensus session', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'What framework to use?' })
      expect(c.id).toBeDefined()
      expect(c.question).toBe('What framework to use?')
      expect(c.participants).toEqual(['s1'])
      expect(c.rounds).toHaveLength(1)
      expect(c.rounds[0]!.type).toBe('initial')
      expect(c.rounds[0]!.status).toBe('collecting')
      expect(c.status).toBe('collecting')
      expect(c.currentRound).toBe(0)
      expect(c.createdBy).toBe('s1')
    })

    it('should throw if question is missing', () => {
      const agent = makeAgent('s1', TMP)
      expect(() => createConsensus(agent, { question: '' })).toThrow('question required')
    })

    it('should accept multiple participants', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, {
        question: 'Best approach?',
        participants: ['s1', 's2', 's3'],
      })
      expect(c.participants).toEqual(['s1', 's2', 's3'])
    })
  })

  describe('readConsensus', () => {
    it('should read a consensus by id', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      const read = readConsensus(agent, c.id)
      expect(read).toBeDefined()
      expect(read!.id).toBe(c.id)
      expect(read!.question).toBe('test?')
    })

    it('should return undefined for non-existent', () => {
      const agent = makeAgent('s1', TMP)
      expect(readConsensus(agent, 'nonexistent')).toBeUndefined()
    })
  })

  describe('listConsensus', () => {
    it('should return empty when none exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(listConsensus(agent)).toEqual([])
    })

    it('should list all sessions', async () => {
      const agent = makeAgent('s1', TMP)
      createConsensus(agent, { question: 'q1' })
      await new Promise(r => setTimeout(r, 2))
      createConsensus(agent, { question: 'q2' })
      const list = listConsensus(agent)
      expect(list).toHaveLength(2)
      expect(list[0]!.question).toBe('q1')
      expect(list[1]!.question).toBe('q2')
    })

    it('should filter by status', () => {
      const agent = makeAgent('s1', TMP)
      const c1 = createConsensus(agent, { question: 'q1' })
      createConsensus(agent, { question: 'q2' })
      cancelConsensus(agent, c1.id)
      const active = listConsensus(agent, { status: 'collecting' })
      expect(active).toHaveLength(1)
      expect(active[0]!.question).toBe('q2')
    })

    it('should filter by participant', () => {
      const agent = makeAgent('s1', TMP)
      createConsensus(agent, { question: 'q1', participants: ['s1', 's2'] })
      createConsensus(agent, { question: 'q2', participants: ['s1', 's3'] })
      const withS2 = listConsensus(agent, { participant: 's2' })
      expect(withS2).toHaveLength(1)
      expect(withS2[0]!.question).toBe('q1')
    })
  })

  describe('addParticipant', () => {
    it('should add a new participant', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      const updated = addParticipant(agent, c.id, 's2')
      expect(updated!.participants).toContain('s2')
      expect(updated!.participants).toHaveLength(2)
    })

    it('should not duplicate existing participant', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?', participants: ['s1', 's2'] })
      const updated = addParticipant(agent, c.id, 's2')
      expect(updated!.participants).toHaveLength(2)
    })

    it('should return undefined for non-existent', () => {
      const agent = makeAgent('s1', TMP)
      expect(addParticipant(agent, 'nonexistent', 's2')).toBeUndefined()
    })
  })

  describe('submitResponse', () => {
    it('should submit a response', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      const updated = submitResponse(agent, c.id, 'my analysis')
      expect(updated!.rounds[0]!.responses['s1']).toBe('my analysis')
    })

    it('should mark round completed when all participants submit', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const c = createConsensus(agent1, { question: 'test?', participants: ['s1', 's2'] })
      submitResponse(agent1, c.id, 'analysis from s1')
      const updated = submitResponse(agent2, c.id, 'analysis from s2')
      expect(updated!.rounds[0]!.status).toBe('completed')
      expect(updated!.rounds[0]!.completedAt).toBeDefined()
    })

    it('should not mark completed when not all submitted', () => {
      const agent1 = makeAgent('s1', TMP)
      const c = createConsensus(agent1, { question: 'test?', participants: ['s1', 's2'] })
      const updated = submitResponse(agent1, c.id, 'analysis from s1')
      expect(updated!.rounds[0]!.status).toBe('collecting')
    })

    it('should throw if consensus is cancelled', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      cancelConsensus(agent, c.id)
      expect(() => submitResponse(agent, c.id, 'response')).toThrow('cancelled')
    })
  })

  describe('startCrossReview', () => {
    it('should start cross-review round', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const c = createConsensus(agent1, { question: 'test?', participants: ['s1', 's2'] })
      submitResponse(agent1, c.id, 'response 1')
      submitResponse(agent2, c.id, 'response 2')
      const updated = startCrossReview(agent1, c.id)
      expect(updated!.currentRound).toBe(1)
      expect(updated!.rounds[1]!.type).toBe('cross-review')
      expect(updated!.rounds[1]!.status).toBe('collecting')
      expect(updated!.status).toBe('reviewing')
    })

    it('should throw if current round not completed', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?', participants: ['s1', 's2'] })
      expect(() => startCrossReview(agent, c.id)).toThrow('not completed')
    })

    it('should throw if not collecting status', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      cancelConsensus(agent, c.id)
      expect(() => startCrossReview(agent, c.id)).toThrow('not collecting')
    })
  })

  describe('getCrossReviewPrompt', () => {
    it('should generate cross-review prompt for a participant', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const c = createConsensus(agent1, { question: 'test?', participants: ['s1', 's2'] })
      submitResponse(agent1, c.id, 's1 analysis')
      submitResponse(agent2, c.id, 's2 analysis')
      startCrossReview(agent1, c.id)

      const prompt = getCrossReviewPrompt(agent1, c.id, 's1')
      expect(prompt).toBeDefined()
      expect(prompt).toContain('s1 analysis')
      expect(prompt).toContain('s2 analysis')
      expect(prompt).toContain('Review the other responses')
    })

    it('should return undefined before cross-review round', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      expect(getCrossReviewPrompt(agent, c.id, 's1')).toBeUndefined()
    })
  })

  describe('synthesizeConsensus', () => {
    it('should synthesize a result', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      submitResponse(agent, c.id, 'analysis')
      const result = synthesizeConsensus(agent, c.id, 'final synthesis')
      expect(result!.status).toBe('synthesized')
      expect(result!.result).toBe('final synthesis')
      expect(result!.rounds[result!.currentRound]!.type).toBe('synthesis')
    })

    it('should throw if already synthesized', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      synthesizeConsensus(agent, c.id, 'result')
      expect(() => synthesizeConsensus(agent, c.id, 'result2')).toThrow('already synthesized')
    })

    it('should throw if cancelled', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      cancelConsensus(agent, c.id)
      expect(() => synthesizeConsensus(agent, c.id, 'result')).toThrow('cancelled')
    })
  })

  describe('cancelConsensus', () => {
    it('should cancel a session', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      const cancelled = cancelConsensus(agent, c.id)
      expect(cancelled!.status).toBe('cancelled')
    })

    it('should throw if already synthesized', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      synthesizeConsensus(agent, c.id, 'result')
      expect(() => cancelConsensus(agent, c.id)).toThrow('already synthesized')
    })
  })

  describe('deleteConsensus', () => {
    it('should delete a session', () => {
      const agent = makeAgent('s1', TMP)
      const c = createConsensus(agent, { question: 'test?' })
      expect(deleteConsensus(agent, c.id)).toBe(true)
      expect(readConsensus(agent, c.id)).toBeUndefined()
    })

    it('should return false for non-existent', () => {
      const agent = makeAgent('s1', TMP)
      expect(deleteConsensus(agent, 'nonexistent')).toBe(false)
    })
  })

  describe('full consensus lifecycle', () => {
    it('should support create → submit → cross-review → synthesize', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const agent3 = makeAgent('s3', TMP)

      // Create with 3 participants
      const c = createConsensus(agent1, {
        question: 'Best testing framework?',
        description: 'Choose between vitest, jest, mocha',
        participants: ['s1', 's2', 's3'],
      })
      expect(c.status).toBe('collecting')

      // Submit initial responses
      submitResponse(agent1, c.id, 'Vitest is best for modern projects')
      submitResponse(agent2, c.id, 'Jest has better ecosystem')
      submitResponse(agent3, c.id, 'Mocha is most flexible')

      // Start cross-review
      const reviewing = startCrossReview(agent1, c.id)
      expect(reviewing!.status).toBe('reviewing')

      // Get cross-review prompts
      const prompt1 = getCrossReviewPrompt(agent1, c.id, 's1')
      expect(prompt1).toContain('Vitest is best')
      expect(prompt1).toContain('Jest has better ecosystem')
      expect(prompt1).toContain('Mocha is most flexible')

      // Submit cross-review responses
      submitResponse(agent1, c.id, 'Jest ecosystem is strong but Vitest is faster')
      submitResponse(agent2, c.id, 'Agree Vitest is faster, but ecosystem matters')
      submitResponse(agent3, c.id, 'Flexibility matters less than speed')

      // Synthesize
      const result = synthesizeConsensus(agent1, c.id, 'Consensus: Vitest for speed, Jest for ecosystem')
      expect(result!.status).toBe('synthesized')
      expect(result!.result).toBe('Consensus: Vitest for speed, Jest for ecosystem')
    })
  })
})