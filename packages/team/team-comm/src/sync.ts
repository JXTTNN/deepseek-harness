/**
 * File sync module — track which files each agent is reading or writing.
 *
 * In a multi-agent team, agents may work on the same codebase simultaneously.
 * This module provides a lightweight file-claim system:
 * - An agent claims a file for writing (exclusive) or reading (shared)
 * - Other agents can check before modifying a file whether someone else has a claim
 * - Claims have a TTL and auto-expire
 *
 * @module @deepseek-ai/dsh-team-comm/sync
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd } from './shared'

// -- Constants ------------------------------------------------------------

/** Sync claim TTL in ms (default 10 minutes). */
export const SYNC_CLAIM_TTL_MS = 10 * 60_000

// -- Types ----------------------------------------------------------------

/** Claim type: write = exclusive, read = shared. */
export type ClaimType = 'read' | 'write'

/** One file sync claim. */
export interface SyncClaim {
  id: string
  sessionId: string
  filePath: string
  claimType: ClaimType
  claimedAt: string
  expiresAt: string
}

/** Summary of claims on a file. */
export interface FileSyncStatus {
  filePath: string
  writeClaims: SyncClaim[]
  readClaims: SyncClaim[]
  /** True if another agent has an active write claim. */
  locked: boolean
}

// -- Helpers --------------------------------------------------------------

function syncDir(agent: { session: { header?: { cwd?: string } } }): string {
  return join(teamCwd(agent), TEAM_DIR, 'sync')
}

function claimFile(agent: { session: { header?: { cwd?: string } } }, id: string): string {
  return join(syncDir(agent), `${id}.json`)
}

function isExpired(claim: SyncClaim, now: number): boolean {
  return now >= new Date(claim.expiresAt).getTime()
}

function cleanupExpired(dir: string): void {
  if (!existsSync(dir)) return
  const now = Date.now()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const claim = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SyncClaim
      if (isExpired(claim, now)) {
        try { unlinkSync(join(dir, file)) } catch { /* best-effort */ }
      }
    } catch {
      // Corrupted file, remove it
      try { unlinkSync(join(dir, file)) } catch { /* best-effort */ }
    }
  }
}

// -- CRUD -----------------------------------------------------------------

/** Claim a file for reading or writing. */
export function claimFile_(
  agent: { session: { id: string; header?: { cwd?: string } } },
  filePath: string,
  claimType: ClaimType,
  ttlMs?: number,
): SyncClaim {
  const dir = syncDir(agent)
  mkdirSync(dir, { recursive: true })
  cleanupExpired(dir)

  // Check for conflicting write claims
  if (claimType === 'write') {
    const existing = readFileClaims(agent, filePath)
    const activeWrite = existing.filter(c => c.sessionId !== agent.session.id && !isExpired(c, Date.now()))
    if (activeWrite.length > 0) {
      throw new Error(`File "${filePath}" is locked by ${activeWrite[0]!.sessionId}`)
    }
  }

  const now = new Date()
  const ttl = ttlMs ?? SYNC_CLAIM_TTL_MS
  const claim: SyncClaim = {
    id: randomUUID().slice(0, 8),
    sessionId: agent.session.id,
    filePath,
    claimType,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  }

  const file = claimFile(agent, claim.id)
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(claim, null, 2))
  renameSync(tmp, file)
  return claim
}

/** Read all active claims for a specific file. */
export function readFileClaims(
  agent: { session: { header?: { cwd?: string } } },
  filePath: string,
): SyncClaim[] {
  const dir = syncDir(agent)
  if (!existsSync(dir)) return []
  cleanupExpired(dir)
  const claims: SyncClaim[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const claim = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SyncClaim
      if (claim.filePath === filePath && !isExpired(claim, Date.now())) {
        claims.push(claim)
      }
    } catch {
      // skip corrupted
    }
  }
  return claims
}

/** Get sync status for a file (summary of read/write claims). */
export function getFileSyncStatus(
  agent: { session: { header?: { cwd?: string } } },
  filePath: string,
): FileSyncStatus {
  const claims = readFileClaims(agent, filePath)
  const writeClaims = claims.filter(c => c.claimType === 'write')
  const readClaims = claims.filter(c => c.claimType === 'read')
  return {
    filePath,
    writeClaims,
    readClaims,
    locked: writeClaims.length > 0,
  }
}

/** List all active sync claims. */
export function listAllClaims(
  agent: { session: { header?: { cwd?: string } } },
): SyncClaim[] {
  const dir = syncDir(agent)
  if (!existsSync(dir)) return []
  cleanupExpired(dir)
  const claims: SyncClaim[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const claim = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SyncClaim
      if (!isExpired(claim, Date.now())) {
        claims.push(claim)
      }
    } catch {
      // skip corrupted
    }
  }
  return claims.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt))
}

/** Release a specific claim by id. */
export function releaseClaim(
  agent: { session: { id: string; header?: { cwd?: string } } },
  claimId: string,
): boolean {
  const file = claimFile(agent, claimId)
  if (!existsSync(file)) return false
  try {
    const claim = JSON.parse(readFileSync(file, 'utf-8')) as SyncClaim
    // Only the owner can release their claim
    if (claim.sessionId !== agent.session.id) return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** Release all claims owned by the calling session. */
export function releaseAllClaims(
  agent: { session: { id: string; header?: { cwd?: string } } },
): number {
  const dir = syncDir(agent)
  if (!existsSync(dir)) return 0
  let released = 0
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const claim = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SyncClaim
      if (claim.sessionId === agent.session.id) {
        unlinkSync(join(dir, file))
        released++
      }
    } catch {
      // skip corrupted
    }
  }
  return released
}