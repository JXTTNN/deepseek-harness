/**
 * Election, role management, auto-assignment, and agent definition module.
 *
 * Extracted from index.ts for module separation. Contains types, constants,
 * and helper functions for:
 * - F1: Leader election with lease-based failover
 * - F6: Typed role definitions with capabilities and write sets
 * - F10: Adaptive task assignment strategies
 * - Agent spec definitions with hot reload
 *
 * @module @deepseek-ai/dsh-team-comm/election
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { TEAM_DIR, teamCwd, isSafeTeamId, readAllPresence } from './shared'

// -- F1: Leader Election ------------------------------------------------

/** F1: Election lease duration in ms (default 5 minutes). */
export const ELECTION_LEASE_MS = 5 * 60_000

/** F1: One election record for a role. */
export interface ElectionRecord {
  role: string
  leader: string
  leaseExpires: string
  electedAt: string
  voters: string[]
}

/** F1: Read an election record for a role. */
export function readElection(agent: { session: { header?: { cwd?: string } } }, role: string): ElectionRecord | undefined {
  const file = join(teamCwd(agent), TEAM_DIR, 'election', `${role}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ElectionRecord
  } catch {
    return undefined
  }
}

/** F1: Write an election record atomically. */
export function writeElection(agent: { session: { header?: { cwd?: string } } }, record: ElectionRecord): void {
  const dir = join(teamCwd(agent), TEAM_DIR, 'election')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${record.role}.json`)
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, file)
}

/** F1: Perform deterministic election: smallest session id among live peers wins. */
export function electLeader(agent: { session: { id: string; header?: { cwd?: string } } }, role: string): ElectionRecord {
  const peers = readAllPresence(agent)
  const sessionIds = peers.map(p => p.id).filter(isSafeTeamId).sort()
  const leader = sessionIds.length > 0 ? sessionIds[0]! : agent.session.id
  const now = new Date()
  const record: ElectionRecord = {
    role,
    leader,
    leaseExpires: new Date(now.getTime() + ELECTION_LEASE_MS).toISOString(),
    electedAt: now.toISOString(),
    voters: sessionIds,
  }
  writeElection(agent, record)
  return record
}

// -- F6: Role Definitions -----------------------------------------------

/** F6: One role definition. */
export interface RoleDefinition {
  name: string
  capabilities?: string[]
  writeSet?: string[]
  tools?: string[]
  disallowedTools?: string[]
  maxConcurrentTasks?: number
  definedAt: string
}

/** F6: Session-to-role assignment map. */
export interface RoleAssignments {
  [session: string]: string
}

/** F6: Read a role definition. */
export function readRole(agent: { session: { header?: { cwd?: string } } }, name: string): RoleDefinition | undefined {
  const file = join(teamCwd(agent), TEAM_DIR, 'roles', `${name}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RoleDefinition
  } catch {
    return undefined
  }
}

/** F6: Write a role definition atomically. */
export function writeRole(agent: { session: { header?: { cwd?: string } } }, role: RoleDefinition): void {
  const dir = join(teamCwd(agent), TEAM_DIR, 'roles')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${role.name}.json`)
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(role, null, 2))
  renameSync(tmp, file)
}

/** F6: Read all role assignments. */
export function readRoleAssignments(agent: { session: { header?: { cwd?: string } } }): RoleAssignments {
  const file = join(teamCwd(agent), TEAM_DIR, 'roles', 'assignments.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RoleAssignments
  } catch {
    return {}
  }
}

/** F6: Write role assignments atomically. */
export function writeRoleAssignments(agent: { session: { header?: { cwd?: string } } }, assignments: RoleAssignments): void {
  const dir = join(teamCwd(agent), TEAM_DIR, 'roles')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'assignments.json')
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(assignments, null, 2))
  renameSync(tmp, file)
}

// -- F10: Auto-Assign State ---------------------------------------------

/** F10: Read the round-robin counter state. */
export function readAutoAssignState(agent: { session: { header?: { cwd?: string } } }): { roundRobinIndex: number } {
  const file = join(teamCwd(agent), TEAM_DIR, 'auto_assign_state.json')
  if (!existsSync(file)) return { roundRobinIndex: 0 }
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as { roundRobinIndex: number }
  } catch {
    return { roundRobinIndex: 0 }
  }
}

/** F10: Write the round-robin counter state atomically. */
export function writeAutoAssignState(agent: { session: { header?: { cwd?: string } } }, state: { roundRobinIndex: number }): void {
  const file = join(teamCwd(agent), TEAM_DIR, 'auto_assign_state.json')
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}

// -- Agent Spec Definitions ---------------------------------------------

/** Agent spec definition. */
export interface AgentSpec {
  name: string
  description: string
  model?: string
  tools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
  permissionMode?: 'read_only' | 'accept_edits' | 'auto' | 'plan'
  systemPrompt?: string
  isolation?: 'worktree' | 'docker' | 'none'
  mcpServers?: string[]
  createdAt: string
  updatedAt: string
}

/** Read an agent spec. */
export function readAgentSpec(agent: { session: { header?: { cwd?: string } } }, name: string): AgentSpec | undefined {
  const file = join(teamCwd(agent), TEAM_DIR, 'agents', `${name}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as AgentSpec
  } catch {
    return undefined
  }
}

/** Write an agent spec atomically. */
export function writeAgentSpec(agent: { session: { header?: { cwd?: string } } }, spec: AgentSpec): void {
  const dir = join(teamCwd(agent), TEAM_DIR, 'agents')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${spec.name}.json`)
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(spec, null, 2))
  renameSync(tmp, file)
}
