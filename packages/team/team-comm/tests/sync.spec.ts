import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  SYNC_CLAIM_TTL_MS,
  claimFile_,
  readFileClaims,
  getFileSyncStatus,
  listAllClaims,
  releaseClaim,
  releaseAllClaims,
} from '../src/sync'

const TMP = join(tmpdir(), `dsh-sync-test-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('sync module', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // -- Constants --

  describe('SYNC_CLAIM_TTL_MS', () => {
    it('should be 10 minutes', () => {
      expect(SYNC_CLAIM_TTL_MS).toBe(10 * 60_000)
    })
  })

  // -- claimFile_ --

  describe('claimFile_', () => {
    it('should create a read claim', () => {
      const agent = makeAgent('s1', TMP)
      const claim = claimFile_(agent, 'src/index.ts', 'read')
      expect(claim.claimType).toBe('read')
      expect(claim.sessionId).toBe('s1')
      expect(claim.filePath).toBe('src/index.ts')
      expect(claim.id).toBeDefined()
    })

    it('should create a write claim', () => {
      const agent = makeAgent('s1', TMP)
      const claim = claimFile_(agent, 'src/foo.ts', 'write')
      expect(claim.claimType).toBe('write')
    })

    it('should allow multiple read claims on the same file', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      claimFile_(agent1, 'src/shared.ts', 'read')
      claimFile_(agent2, 'src/shared.ts', 'read')
      const claims = readFileClaims(agent1, 'src/shared.ts')
      expect(claims).toHaveLength(2)
    })

    it('should throw when a second agent tries to write-claim a locked file', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      claimFile_(agent1, 'src/locked.ts', 'write')
      expect(() => claimFile_(agent2, 'src/locked.ts', 'write')).toThrow('locked')
    })

    it('should allow the same agent to re-claim a file for writing', () => {
      const agent = makeAgent('s1', TMP)
      claimFile_(agent, 'src/reclaim.ts', 'write')
      // Same agent can claim again (e.g. extending TTL)
      const claim2 = claimFile_(agent, 'src/reclaim.ts', 'write')
      expect(claim2.sessionId).toBe('s1')
    })

    it('should throw when a write claim conflicts with an existing write claim from another agent', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      claimFile_(agent1, 'src/exclusive.ts', 'write')
      expect(() => claimFile_(agent2, 'src/exclusive.ts', 'write')).toThrow()
    })
  })

  // -- readFileClaims --

  describe('readFileClaims', () => {
    it('should return empty when no claims exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(readFileClaims(agent, 'src/nothing.ts')).toEqual([])
    })

    it('should return only claims for the specified file', () => {
      const agent = makeAgent('s1', TMP)
      claimFile_(agent, 'src/a.ts', 'read')
      claimFile_(agent, 'src/b.ts', 'read')
      expect(readFileClaims(agent, 'src/a.ts')).toHaveLength(1)
      expect(readFileClaims(agent, 'src/a.ts')[0]!.filePath).toBe('src/a.ts')
    })
  })

  // -- getFileSyncStatus --

  describe('getFileSyncStatus', () => {
    it('should report locked=false when no write claims', () => {
      const agent = makeAgent('s1', TMP)
      claimFile_(agent, 'src/free.ts', 'read')
      const status = getFileSyncStatus(agent, 'src/free.ts')
      expect(status.locked).toBe(false)
      expect(status.readClaims).toHaveLength(1)
      expect(status.writeClaims).toHaveLength(0)
    })

    it('should report locked=true when a write claim exists', () => {
      const agent = makeAgent('s1', TMP)
      claimFile_(agent, 'src/locked.ts', 'write')
      const status = getFileSyncStatus(agent, 'src/locked.ts')
      expect(status.locked).toBe(true)
      expect(status.writeClaims).toHaveLength(1)
    })
  })

  // -- listAllClaims --

  describe('listAllClaims', () => {
    it('should return empty when no claims exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(listAllClaims(agent)).toEqual([])
    })

    it('should list all active claims sorted by claimedAt', () => {
      const agent = makeAgent('s1', TMP)
      claimFile_(agent, 'src/a.ts', 'read')
      claimFile_(agent, 'src/b.ts', 'write')
      const claims = listAllClaims(agent)
      expect(claims).toHaveLength(2)
    })
  })

  // -- releaseClaim --

  describe('releaseClaim', () => {
    it('should release a claim by id', () => {
      const agent = makeAgent('s1', TMP)
      const claim = claimFile_(agent, 'src/release.ts', 'read')
      expect(releaseClaim(agent, claim.id)).toBe(true)
      expect(readFileClaims(agent, 'src/release.ts')).toEqual([])
    })

    it('should return false for nonexistent claim', () => {
      const agent = makeAgent('s1', TMP)
      expect(releaseClaim(agent, 'nonexistent')).toBe(false)
    })

    it('should not release a claim owned by another session', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      const claim = claimFile_(agent1, 'src/owned.ts', 'read')
      expect(releaseClaim(agent2, claim.id)).toBe(false)
    })
  })

  // -- releaseAllClaims --

  describe('releaseAllClaims', () => {
    it('should release all claims owned by the calling session', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      claimFile_(agent1, 'src/a.ts', 'read')
      claimFile_(agent1, 'src/b.ts', 'write')
      claimFile_(agent2, 'src/c.ts', 'read')
      expect(releaseAllClaims(agent1)).toBe(2)
      expect(listAllClaims(agent1)).toHaveLength(1)
    })

    it('should return 0 when no claims exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(releaseAllClaims(agent)).toBe(0)
    })
  })
})