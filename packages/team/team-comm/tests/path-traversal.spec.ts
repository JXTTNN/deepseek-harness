/**
 * Path-traversal guards on the id/name -> filesystem-path boundary.
 *
 * Every module in this package interpolates a model-controlled identifier into
 * a path under `.team/`. Before these guards existed, `readHandoff(agent,
 * '../../evil')` resolved to a file OUTSIDE `.team/handoffs/`, so a single tool
 * call could read, overwrite, or delete arbitrary `.json` files on the host.
 *
 * The guard lives in each module's path helper rather than only at the tool
 * boundary in index.ts, because that helper is the one point every reader,
 * writer, and deleter in the module funnels through — a new caller cannot
 * bypass it. These tests therefore exercise the modules directly, which is also
 * the stricter test: it fails if a future refactor reintroduces an unguarded
 * path build even while the tool layer still validates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createHandoff, deleteHandoff, readHandoff } from '../src/handoff'
import { readContract, updateContractStatus } from '../src/contract'
import { deletePipeline, readPipeline } from '../src/pipeline'
import { deleteConsensus, readConsensus } from '../src/consensus'
import { deleteBudget, readBudget } from '../src/budget'
import { releaseClaim } from '../src/sync'
import {
  readAgentSpec,
  readElection,
  readRole,
  writeAgentSpec,
  writeElection,
  writeRole,
} from '../src/election'
import { readPermissionRules, writePermissionRules } from '../src/permission'

const TMP = join(tmpdir(), `team-comm-traversal-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

/**
 * Identifiers a tool argument could carry that must never be interpolated into
 * a path. Each trips a different branch of `isSafeTeamId`: separators, the two
 * dot-directories, empty/whitespace-only, and an embedded NUL.
 */
const HOSTILE_IDS = [
  '../escape',
  '..\\escape',
  'nested/path',
  'nested\\path',
  '..',
  '.',
  '',
  '   ',
  'nul\0byte',
] as const

/** A name that is legal: no separators, no dot-directories, already trimmed. */
const LEGAL_ID = 'worker-alpha'

describe('path-traversal guards', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  describe('read/delete paths reject hostile identifiers', () => {
    const agent = () => makeAgent('s1', TMP)

    // Table-driven so a newly added module is one line, not a copied block.
    const readers: ReadonlyArray<{ label: string; call: (id: string) => unknown }> = [
      { label: 'handoff.readHandoff', call: id => readHandoff(agent(), id) },
      { label: 'handoff.deleteHandoff', call: id => deleteHandoff(agent(), id) },
      { label: 'contract.readContract', call: id => readContract(agent(), id) },
      { label: 'contract.updateContractStatus', call: id => updateContractStatus(agent(), id, 'accepted') },
      { label: 'pipeline.readPipeline', call: id => readPipeline(agent(), id) },
      { label: 'pipeline.deletePipeline', call: id => deletePipeline(agent(), id) },
      { label: 'consensus.readConsensus', call: id => readConsensus(agent(), id) },
      { label: 'consensus.deleteConsensus', call: id => deleteConsensus(agent(), id) },
      { label: 'budget.readBudget', call: id => readBudget(agent(), id) },
      { label: 'budget.deleteBudget', call: id => deleteBudget(agent(), id) },
      { label: 'sync.releaseClaim', call: id => releaseClaim(agent(), id) },
      { label: 'election.readElection', call: id => readElection(agent(), id) },
      { label: 'election.readRole', call: id => readRole(agent(), id) },
      { label: 'election.readAgentSpec', call: id => readAgentSpec(agent(), id) },
      {
        label: 'election.writeRole',
        call: id => writeRole(agent(), { name: id, definedAt: new Date().toISOString() }),
      },
      {
        label: 'election.writeElection',
        call: id => writeElection(agent(), {
          role: id,
          leader: 's1',
          leaseExpires: new Date().toISOString(),
          electedAt: new Date().toISOString(),
          voters: ['s1'],
        }),
      },
      {
        label: 'election.writeAgentSpec',
        call: id => writeAgentSpec(agent(), {
          name: id,
          description: 'd',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      },
      { label: 'permission.readPermissionRules', call: id => readPermissionRules(TMP, 'role', id) },
      { label: 'permission.writePermissionRules', call: id => writePermissionRules(TMP, 'role', id, {}) },
    ]

    // Enumerated rather than interpolated into one `it` per case, so a failure
    // names the exact module that lost its guard.
    it.each(readers)('$label throws for every hostile identifier', ({ call }) => {
      for (const id of HOSTILE_IDS) {
        expect(() => call(id)).toThrow(/must be a non-empty string without path separators/)
      }
    })

    it.each(readers)('$label still accepts a legal identifier', ({ call }) => {
      // Must not throw. The return value is irrelevant here: a miss is a legal
      // outcome (undefined / false / {}), a rejection is a regression.
      expect(() => call(LEGAL_ID)).not.toThrow()
    })

    it('permission paths reject a hostile layer too', () => {
      expect(() => readPermissionRules(TMP, '../escape', 'scope')).toThrow()
      expect(() => writePermissionRules(TMP, '../escape', 'scope', {})).toThrow()
    })
  })

  describe('an escape cannot touch a file outside .team/', () => {
    it('leaves a sibling file untouched when a traversal delete is attempted', () => {
      // Target the file that the pre-guard code would have resolved to:
      // join(TMP/.team/handoffs, '../..//outside.json') escapes the team root.
      const outside = join(TMP, 'outside.json')
      writeFileSync(outside, JSON.stringify({ keep: true }))

      expect(() => deleteHandoff(makeAgent('s1', TMP), '../outside')).toThrow()
      expect(existsSync(outside)).toBe(true)
      expect(JSON.parse(readFileSync(outside, 'utf-8'))).toEqual({ keep: true })
    })

    it('leaves a sibling file untouched when a traversal write is attempted', () => {
      const outside = join(TMP, 'outside.json')
      writeFileSync(outside, JSON.stringify({ keep: true }))

      expect(() => writePermissionRules(TMP, 'role', '../outside', { tool: false })).toThrow()
      expect(JSON.parse(readFileSync(outside, 'utf-8'))).toEqual({ keep: true })
    })
  })

  describe('legitimate round trips still work', () => {
    it('creates and reads a handoff by its generated id', () => {
      const agent = makeAgent('s1', TMP)
      const created = createHandoff(agent, {
        taskId: 'task-1',
        toSession: 's2',
        reason: 'rebalance',
        context: 'ctx',
      })
      // The id the module generates must itself pass the guard, or every
      // create/read cycle would break.
      expect(readHandoff(agent, created.id)?.id).toBe(created.id)
    })

    it('reads back a role and an agent spec written under a legal name', () => {
      const agent = makeAgent('s1', TMP)
      writeRole(agent, { name: LEGAL_ID, capabilities: ['review'], definedAt: new Date().toISOString() })
      expect(readRole(agent, LEGAL_ID)?.name).toBe(LEGAL_ID)

      writeAgentSpec(agent, {
        name: LEGAL_ID,
        description: 'd',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      expect(readAgentSpec(agent, LEGAL_ID)?.name).toBe(LEGAL_ID)
    })

    it('reads back permission rules for a legal scope', () => {
      writePermissionRules(TMP, 'role', LEGAL_ID, { 'team_send': true })
      expect(readPermissionRules(TMP, 'role', LEGAL_ID)).toEqual({ 'team_send': true })
    })
  })
})
