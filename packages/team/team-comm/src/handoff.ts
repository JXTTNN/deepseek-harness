/**
 * Handoff module — formal task ownership transfer between agents.
 *
 * When an agent is stuck, overloaded, or needs to transfer a task to another
 * agent with better capabilities, a handoff provides a structured transfer:
 * - The sending agent creates a handoff with working context
 * - The receiving agent accepts or rejects the handoff
 * - On accept, the receiving agent takes ownership of the task
 * - On completion, the handoff is marked as completed
 *
 * This is different from team_task (which creates new tasks) and team_spawn
 * (which creates subagents). A handoff transfers an *ongoing* task between
 * peers, preserving the working context.
 *
 * @module @deepseek-ai/dsh-team-comm/handoff
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd } from './shared'

// -- Constants ------------------------------------------------------------

const HANDOFF_DIR = 'handoffs'

// -- Types ----------------------------------------------------------------

export type HandoffStatus = 'pending' | 'accepted' | 'rejected' | 'completed' | 'cancelled'

export interface TaskHandoff {
  id: string
  taskId: string
  fromSession: string
  toSession: string
  reason: string
  context: string
  status: HandoffStatus
  createdAt: string
  acceptedAt?: string
  completedAt?: string
  updatedAt: string
}

// -- Helpers --------------------------------------------------------------

function handoffDir(agent: { session: { header?: { cwd?: string } } }): string {
  return join(teamCwd(agent), TEAM_DIR, HANDOFF_DIR)
}

function handoffFile(agent: { session: { header?: { cwd?: string } } }, id: string): string {
  return join(handoffDir(agent), `${id}.json`)
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function nowISO(): string {
  return new Date().toISOString()
}

// -- CRUD -----------------------------------------------------------------

/** Create a handoff request. */
export function createHandoff(
  agent: { session: { id: string; header?: { cwd?: string } } },
  input: {
    taskId: string
    toSession: string
    reason: string
    context: string
  },
): TaskHandoff {
  if (!input.taskId) throw new Error('createHandoff: taskId required')
  if (!input.toSession) throw new Error('createHandoff: toSession required')
  if (!input.reason) throw new Error('createHandoff: reason required')

  const dir = handoffDir(agent)
  mkdirSync(dir, { recursive: true })

  const now = nowISO()
  const handoff: TaskHandoff = {
    id: randomUUID().slice(0, 8),
    taskId: input.taskId,
    fromSession: agent.session.id,
    toSession: input.toSession,
    reason: input.reason,
    context: input.context,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }

  atomicWrite(handoffFile(agent, handoff.id), JSON.stringify(handoff, null, 2))
  return handoff
}

/** Read a handoff by id. */
export function readHandoff(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): TaskHandoff | undefined {
  const file = handoffFile(agent, id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as TaskHandoff
  } catch {
    return undefined
  }
}

/** List all handoffs, optionally filtered. */
export function listHandoffs(
  agent: { session: { header?: { cwd?: string } } },
  filter?: { status?: HandoffStatus; fromSession?: string; toSession?: string; taskId?: string },
): TaskHandoff[] {
  const dir = handoffDir(agent)
  if (!existsSync(dir)) return []
  const handoffs: TaskHandoff[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const h = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as TaskHandoff
      if (filter) {
        if (filter.status && h.status !== filter.status) continue
        if (filter.fromSession && h.fromSession !== filter.fromSession) continue
        if (filter.toSession && h.toSession !== filter.toSession) continue
        if (filter.taskId && h.taskId !== filter.taskId) continue
      }
      handoffs.push(h)
    } catch {
      // skip corrupted
    }
  }
  return handoffs.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt)
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id)
  })
}

/** Accept a handoff (only the target session can accept). */
export function acceptHandoff(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
): TaskHandoff | undefined {
  const handoff = readHandoff(agent, id)
  if (!handoff) return undefined
  if (handoff.status !== 'pending') throw new Error(`Handoff ${id} is ${handoff.status}`)
  if (handoff.toSession !== agent.session.id) throw new Error(`Handoff ${id} is for ${handoff.toSession}, not ${agent.session.id}`)

  handoff.status = 'accepted'
  handoff.acceptedAt = nowISO()
  handoff.updatedAt = nowISO()

  atomicWrite(handoffFile(agent, id), JSON.stringify(handoff, null, 2))
  return handoff
}

/** Reject a handoff (only the target session can reject). */
export function rejectHandoff(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
): TaskHandoff | undefined {
  const handoff = readHandoff(agent, id)
  if (!handoff) return undefined
  if (handoff.status !== 'pending') throw new Error(`Handoff ${id} is ${handoff.status}`)
  if (handoff.toSession !== agent.session.id) throw new Error(`Handoff ${id} is for ${handoff.toSession}, not ${agent.session.id}`)

  handoff.status = 'rejected'
  handoff.updatedAt = nowISO()

  atomicWrite(handoffFile(agent, id), JSON.stringify(handoff, null, 2))
  return handoff
}

/** Complete a handoff (the accepting agent marks it as done). */
export function completeHandoff(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
): TaskHandoff | undefined {
  const handoff = readHandoff(agent, id)
  if (!handoff) return undefined
  if (handoff.status !== 'accepted') throw new Error(`Handoff ${id} is ${handoff.status}, must be accepted first`)
  if (handoff.toSession !== agent.session.id) throw new Error(`Handoff ${id} is for ${handoff.toSession}, not ${agent.session.id}`)

  handoff.status = 'completed'
  handoff.completedAt = nowISO()
  handoff.updatedAt = nowISO()

  atomicWrite(handoffFile(agent, id), JSON.stringify(handoff, null, 2))
  return handoff
}

/** Cancel a handoff (only the originating session can cancel). */
export function cancelHandoff(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
): TaskHandoff | undefined {
  const handoff = readHandoff(agent, id)
  if (!handoff) return undefined
  if (handoff.status === 'completed') throw new Error(`Handoff ${id} is already completed`)
  if (handoff.fromSession !== agent.session.id) throw new Error(`Only the originator can cancel handoff ${id}`)

  handoff.status = 'cancelled'
  handoff.updatedAt = nowISO()

  atomicWrite(handoffFile(agent, id), JSON.stringify(handoff, null, 2))
  return handoff
}

/** Delete a handoff. */
export function deleteHandoff(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): boolean {
  const file = handoffFile(agent, id)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}