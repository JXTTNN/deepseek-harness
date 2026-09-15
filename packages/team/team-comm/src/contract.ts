/**
 * Task contract module — define and verify contracts between agents.
 *
 * A contract specifies:
 * - The producer agent and what it promises to deliver (output schema)
 * - The consumer agent and what it expects (input schema)
 * - A deadline and validation rules
 *
 * Contracts enable reliable handoffs in multi-agent workflows by making
 * expectations explicit and verifiable.
 *
 * @module @deepseek-ai/dsh-team-comm/contract
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, assertSafeTeamId, teamCwd, writeTextAtomic } from './shared'

// -- Types ----------------------------------------------------------------

/** Contract status lifecycle. */
export type ContractStatus = 'proposed' | 'accepted' | 'delivered' | 'verified' | 'breached' | 'cancelled'

/** One contract between a producer and a consumer. */
export interface TaskContract {
  id: string
  producer: string
  consumer: string
  description: string
  /** JSON schema fragment describing the expected output shape. */
  outputSchema: Record<string, unknown>
  /** JSON schema fragment describing the expected input shape the consumer needs. */
  inputSchema?: Record<string, unknown>
  deadline?: string
  status: ContractStatus
  createdAt: string
  acceptedAt?: string
  deliveredAt?: string
  verifiedAt?: string
  /** Actual delivered payload (filled when status = delivered). */
  deliverable?: Record<string, unknown>
  /** Verification result notes. */
  verificationNotes?: string
}

// -- Helpers --------------------------------------------------------------

function contractDir(agent: { session: { header?: { cwd?: string } } }): string {
  return join(teamCwd(agent), TEAM_DIR, 'contracts')
}

function contractFile(agent: { session: { header?: { cwd?: string } } }, id: string): string {
  // The id arrives from a model-controlled tool argument and is interpolated
  // into a path, so validate it here: every caller funnels through this helper.
  return join(contractDir(agent), `${assertSafeTeamId(id, 'contract id')}.json`)
}

// -- CRUD -----------------------------------------------------------------

/** Create a new contract (status = proposed). */
export function createContract(
  agent: { session: { id: string; header?: { cwd?: string } } },
  opts: {
    consumer: string
    description: string
    outputSchema: Record<string, unknown>
    inputSchema?: Record<string, unknown>
    deadline?: string
  },
): TaskContract {
  const dir = contractDir(agent)
  mkdirSync(dir, { recursive: true })

  const contract: TaskContract = {
    id: randomUUID().slice(0, 8),
    producer: agent.session.id,
    consumer: opts.consumer,
    description: opts.description,
    outputSchema: opts.outputSchema,
    ...(opts.inputSchema !== undefined ? { inputSchema: opts.inputSchema } : {}),
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    status: 'proposed',
    createdAt: new Date().toISOString(),
  }

  const file = contractFile(agent, contract.id)
  writeTextAtomic(file, JSON.stringify(contract, null, 2))
  return contract
}

/** Read a contract by id. */
export function readContract(agent: { session: { header?: { cwd?: string } } }, id: string): TaskContract | undefined {
  const file = contractFile(agent, id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as TaskContract
  } catch {
    return undefined
  }
}

/** List all contracts, optionally filtered by status or participant. */
export function listContracts(
  agent: { session: { header?: { cwd?: string } } },
  filter?: { status?: ContractStatus; participant?: string },
): TaskContract[] {
  const dir = contractDir(agent)
  if (!existsSync(dir)) return []
  const contracts: TaskContract[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const c = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as TaskContract
      if (filter?.status && c.status !== filter.status) continue
      if (filter?.participant && c.producer !== filter.participant && c.consumer !== filter.participant) continue
      contracts.push(c)
    } catch {
      // skip corrupted
    }
  }
  return contracts.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt)
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id)
  })
}

/** Update a contract's status atomically. */
export function updateContractStatus(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
  status: ContractStatus,
  extra?: { deliverable?: Record<string, unknown>; verificationNotes?: string },
): TaskContract | undefined {
  const existing = readContract(agent, id)
  if (!existing) return undefined

  const now = new Date().toISOString()
  const updated: TaskContract = {
    ...existing,
    status,
    ...(status === 'accepted' ? { acceptedAt: now } : {}),
    ...(status === 'delivered' ? { deliveredAt: now } : {}),
    ...(status === 'verified' ? { verifiedAt: now } : {}),
    ...(extra?.deliverable !== undefined ? { deliverable: extra.deliverable } : {}),
    ...(extra?.verificationNotes !== undefined ? { verificationNotes: extra.verificationNotes } : {}),
  }

  const file = contractFile(agent, id)
  writeTextAtomic(file, JSON.stringify(updated, null, 2))
  return updated
}

/** Verify a delivered contract against its output schema (simple shallow check). */
export function verifyContract(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
): { valid: boolean; missing: string[]; contract: TaskContract | undefined } {
  const contract = readContract(agent, id)
  if (!contract) return { valid: false, missing: [], contract: undefined }
  if (contract.status !== 'delivered' || !contract.deliverable) {
    return { valid: false, missing: ['deliverable'], contract }
  }

  // Shallow check: every key in outputSchema must be present in deliverable
  const expectedKeys = Object.keys(contract.outputSchema)
  const actualKeys = Object.keys(contract.deliverable)
  const missing = expectedKeys.filter(k => !actualKeys.includes(k))

  return { valid: missing.length === 0, missing, contract }
}