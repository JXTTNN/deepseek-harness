/**
 * Consensus module — multi-agent debate and verification.
 *
 * Multiple agents analyze the same question independently, then cross-review
 * each other's responses across rounds, and converge on a synthesized result.
 * This produces higher quality outputs than any single agent alone.
 *
 * Workflow:
 * 1. createConsensus — define a question and add participants
 * 2. submitResponse — each participant submits their initial analysis
 * 3. startCrossReview — transition to cross-review round
 * 4. submitReview — each participant reviews others' responses
 * 5. synthesize — produce a final synthesized result
 *
 * @module @deepseek-ai/dsh-team-comm/consensus
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd } from './shared'

// -- Constants ------------------------------------------------------------

const CONSENSUS_DIR = 'consensus'

// -- Types ----------------------------------------------------------------

export type ConsensusStatus = 'collecting' | 'reviewing' | 'synthesized' | 'cancelled'
export type RoundType = 'initial' | 'cross-review' | 'synthesis'
export type RoundStatus = 'pending' | 'collecting' | 'completed'

export interface ConsensusRound {
  type: RoundType
  status: RoundStatus
  responses: Record<string, string>
  startedAt?: string
  completedAt?: string
}

export interface ConsensusSession {
  id: string
  question: string
  description: string
  participants: string[]
  rounds: ConsensusRound[]
  currentRound: number
  status: ConsensusStatus
  result?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

// -- Helpers --------------------------------------------------------------

function consensusDir(agent: { session: { header?: { cwd?: string } } }): string {
  return join(teamCwd(agent), TEAM_DIR, CONSENSUS_DIR)
}

function consensusFile(agent: { session: { header?: { cwd?: string } } }, id: string): string {
  return join(consensusDir(agent), `${id}.json`)
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

/** Create a new consensus session with a question. */
export function createConsensus(
  agent: { session: { id: string; header?: { cwd?: string } } },
  input: { question: string; description?: string; participants?: string[] },
): ConsensusSession {
  if (!input.question) throw new Error('createConsensus: question required')

  const dir = consensusDir(agent)
  mkdirSync(dir, { recursive: true })

  const now = nowISO()
  const session: ConsensusSession = {
    id: randomUUID().slice(0, 8),
    question: input.question,
    description: input.description ?? '',
    participants: input.participants ?? [agent.session.id],
    rounds: [
      {
        type: 'initial',
        status: 'collecting',
        responses: {},
        startedAt: now,
      },
    ],
    currentRound: 0,
    status: 'collecting',
    createdBy: agent.session.id,
    createdAt: now,
    updatedAt: now,
  }

  atomicWrite(consensusFile(agent, session.id), JSON.stringify(session, null, 2))
  return session
}

/** Read a consensus session by id. */
export function readConsensus(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): ConsensusSession | undefined {
  const file = consensusFile(agent, id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ConsensusSession
  } catch {
    return undefined
  }
}

/** List all consensus sessions, optionally filtered. */
export function listConsensus(
  agent: { session: { header?: { cwd?: string } } },
  filter?: { status?: ConsensusStatus; createdBy?: string; participant?: string },
): ConsensusSession[] {
  const dir = consensusDir(agent)
  if (!existsSync(dir)) return []
  const sessions: ConsensusSession[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ConsensusSession
      if (filter) {
        if (filter.status && s.status !== filter.status) continue
        if (filter.createdBy && s.createdBy !== filter.createdBy) continue
        if (filter.participant && !s.participants.includes(filter.participant)) continue
      }
      sessions.push(s)
    } catch {
      // skip corrupted
    }
  }
  return sessions.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt)
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id)
  })
}

/** Add a participant to a consensus session. */
export function addParticipant(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
  participantId: string,
): ConsensusSession | undefined {
  const session = readConsensus(agent, id)
  if (!session) return undefined
  if (session.participants.includes(participantId)) return session

  session.participants.push(participantId)
  session.updatedAt = nowISO()
  atomicWrite(consensusFile(agent, id), JSON.stringify(session, null, 2))
  return session
}

/** Submit a response for the current round. */
export function submitResponse(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
  response: string,
): ConsensusSession | undefined {
  const session = readConsensus(agent, id)
  if (!session) return undefined
  if (session.status === 'cancelled' || session.status === 'synthesized') {
    throw new Error(`Consensus ${id} is ${session.status}`)
  }

  const round = session.rounds[session.currentRound]!
  if (round.status === 'completed') {
    throw new Error(`Round ${session.currentRound} is already completed`)
  }

  round.responses[agent.session.id] = response
  session.updatedAt = nowISO()

  // Check if all participants have submitted
  const allSubmitted = session.participants.every(p => round.responses[p] !== undefined)
  if (allSubmitted) {
    round.status = 'completed'
    round.completedAt = nowISO()
  }

  atomicWrite(consensusFile(agent, id), JSON.stringify(session, null, 2))
  return session
}

/** Start the cross-review round. Each participant reviews others' responses. */
export function startCrossReview(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): ConsensusSession | undefined {
  const session = readConsensus(agent, id)
  if (!session) return undefined
  if (session.status !== 'collecting') throw new Error(`Consensus ${id} is not collecting`)

  const currentRound = session.rounds[session.currentRound]!
  if (currentRound.status !== 'completed') {
    throw new Error(`Current round is not completed yet`)
  }

  const now = nowISO()
  session.currentRound++
  session.rounds.push({
    type: 'cross-review',
    status: 'collecting',
    responses: {},
    startedAt: now,
  })
  session.status = 'reviewing'
  session.updatedAt = now

  atomicWrite(consensusFile(agent, id), JSON.stringify(session, null, 2))
  return session
}

/** Generate cross-review prompt for a participant. */
export function getCrossReviewPrompt(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
  participantId: string,
): string | undefined {
  const session = readConsensus(agent, id)
  if (!session) return undefined
  if (session.currentRound < 1) return undefined

  const initialRound = session.rounds[0]!
  const myResponse = initialRound.responses[participantId]
  const othersResponses = Object.entries(initialRound.responses)
    .filter(([pid]) => pid !== participantId)
    .map(([pid, resp]) => `- ${pid}: ${resp}`)
    .join('\n')

  return `Your previous response:\n${myResponse ?? '(not submitted)'}\n\nOther participants' responses:\n${othersResponses}\n\nTask: Review the other responses. Do you agree or disagree? What did they miss? Update your position if needed.`
}

/** Synthesize the consensus result. */
export function synthesizeConsensus(
  agent: { session: { id: string; header?: { cwd?: string } } },
  id: string,
  result: string,
): ConsensusSession | undefined {
  const session = readConsensus(agent, id)
  if (!session) return undefined
  if (session.status === 'cancelled') throw new Error(`Consensus ${id} is cancelled`)
  if (session.status === 'synthesized') throw new Error(`Consensus ${id} is already synthesized`)

  const now = nowISO()
  session.currentRound++
  session.rounds.push({
    type: 'synthesis',
    status: 'completed',
    responses: {},
    completedAt: now,
  })
  session.status = 'synthesized'
  session.result = result
  session.updatedAt = now

  atomicWrite(consensusFile(agent, id), JSON.stringify(session, null, 2))
  return session
}

/** Cancel a consensus session. */
export function cancelConsensus(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): ConsensusSession | undefined {
  const session = readConsensus(agent, id)
  if (!session) return undefined
  if (session.status === 'synthesized') throw new Error(`Consensus ${id} is already synthesized`)

  session.status = 'cancelled'
  session.updatedAt = nowISO()

  atomicWrite(consensusFile(agent, id), JSON.stringify(session, null, 2))
  return session
}

/** Delete a consensus session. */
export function deleteConsensus(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): boolean {
  const file = consensusFile(agent, id)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}