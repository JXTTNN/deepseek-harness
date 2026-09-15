/**
 * Budget module — track and enforce resource budgets for agents.
 *
 * Each agent session can have a budget that limits:
 * - Total tokens consumed
 * - Total tool calls made
 * - Rate of calls within a time window
 *
 * Budgets are enforced by checking before each operation whether the
 * session has remaining quota. When a budget is exceeded, the check
 * returns `exceeded: true` so the caller can take appropriate action.
 *
 * @module @deepseek-ai/dsh-team-comm/budget
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, assertSafeTeamId, teamCwd, writeTextAtomic } from './shared'

// -- Constants ------------------------------------------------------------

const BUDGET_DIR = 'budgets'

// -- Types ----------------------------------------------------------------

/** Budget status. */
export type BudgetStatus = 'active' | 'exceeded' | 'paused' | 'deleted'

/** A resource budget for a session. */
export interface Budget {
  id: string
  sessionId: string
  tokenLimit: number
  tokenUsed: number
  callLimit: number
  callUsed: number
  timeWindowMs: number
  windowStart: string
  status: BudgetStatus
  createdAt: string
  updatedAt: string
}

/** Usage check result. */
export interface BudgetCheck {
  sessionId: string
  exceeded: boolean
  reason?: string
  remainingTokens: number
  remainingCalls: number
  tokenUsed: number
  callUsed: number
}

// -- Helpers --------------------------------------------------------------

function budgetDir(agent: { session: { header?: { cwd?: string } } }): string {
  return join(teamCwd(agent), TEAM_DIR, BUDGET_DIR)
}

function budgetFile(agent: { session: { header?: { cwd?: string } } }, id: string): string {
  // The id arrives from a model-controlled tool argument and is interpolated
  // into a path, so validate it here: every caller funnels through this helper.
  return join(budgetDir(agent), `${assertSafeTeamId(id, 'budget id')}.json`)
}

function nowISO(): string {
  return new Date().toISOString()
}

// -- CRUD -----------------------------------------------------------------

/** Create a budget for a session. */
export function createBudget(
  agent: { session: { id: string; header?: { cwd?: string } } },
  input: {
    sessionId?: string
    tokenLimit?: number
    callLimit?: number
    timeWindowMs?: number
  },
): Budget {
  const dir = budgetDir(agent)
  mkdirSync(dir, { recursive: true })

  const now = nowISO()
  const budget: Budget = {
    id: randomUUID().slice(0, 8),
    sessionId: input.sessionId ?? agent.session.id,
    tokenLimit: input.tokenLimit ?? 100_000,
    tokenUsed: 0,
    callLimit: input.callLimit ?? 100,
    callUsed: 0,
    timeWindowMs: input.timeWindowMs ?? 60_000,
    windowStart: now,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }

  writeTextAtomic(budgetFile(agent, budget.id), JSON.stringify(budget, null, 2))
  return budget
}

/** Read a budget by id. */
export function readBudget(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): Budget | undefined {
  const file = budgetFile(agent, id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Budget
  } catch {
    return undefined
  }
}

/** Find a budget by session id (returns the first active budget). */
export function findBudgetBySession(
  agent: { session: { header?: { cwd?: string } } },
  sessionId: string,
): Budget | undefined {
  const dir = budgetDir(agent)
  if (!existsSync(dir)) return undefined
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const b = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Budget
      if (b.sessionId === sessionId && b.status === 'active') return b
    } catch {
      // skip corrupted
    }
  }
  return undefined
}

/** List all budgets, optionally filtered. */
export function listBudgets(
  agent: { session: { header?: { cwd?: string } } },
  filter?: { status?: BudgetStatus; sessionId?: string },
): Budget[] {
  const dir = budgetDir(agent)
  if (!existsSync(dir)) return []
  const budgets: Budget[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const b = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Budget
      if (filter) {
        if (filter.status && b.status !== filter.status) continue
        if (filter.sessionId && b.sessionId !== filter.sessionId) continue
      }
      budgets.push(b)
    } catch {
      // skip corrupted
    }
  }
  return budgets.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt)
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id)
  })
}

/** Record token and call usage for a budget. */
export function recordUsage(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
  tokens: number,
  calls: number,
): Budget | undefined {
  const budget = readBudget(agent, id)
  if (!budget) return undefined
  if (budget.status !== 'active') throw new Error(`Budget ${id} is ${budget.status}`)

  // Check if time window has elapsed — reset window counters
  const now = Date.now()
  const windowStartMs = new Date(budget.windowStart).getTime()
  if (now - windowStartMs >= budget.timeWindowMs) {
    budget.windowStart = nowISO()
    budget.callUsed = 0
  }

  budget.tokenUsed += tokens
  budget.callUsed += calls
  budget.updatedAt = nowISO()

  // Check if budget is exceeded
  if (budget.tokenUsed >= budget.tokenLimit || budget.callUsed >= budget.callLimit) {
    budget.status = 'exceeded'
  }

  writeTextAtomic(budgetFile(agent, id), JSON.stringify(budget, null, 2))
  return budget
}

/** Check if a session can make more calls (without recording usage). */
export function checkBudget(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): BudgetCheck | undefined {
  const budget = readBudget(agent, id)
  if (!budget) return undefined

  // Check if time window has elapsed
  const now = Date.now()
  const windowStartMs = new Date(budget.windowStart).getTime()
  let effectiveCallUsed = budget.callUsed
  if (now - windowStartMs >= budget.timeWindowMs) {
    effectiveCallUsed = 0
  }

  const remainingTokens = Math.max(0, budget.tokenLimit - budget.tokenUsed)
  const remainingCalls = Math.max(0, budget.callLimit - effectiveCallUsed)

  let exceeded = false
  let reason: string | undefined

  if (budget.status === 'paused') {
    exceeded = true
    reason = 'budget is paused'
  } else if (remainingTokens <= 0) {
    exceeded = true
    reason = 'token limit reached'
  } else if (remainingCalls <= 0) {
    exceeded = true
    reason = 'call limit reached'
  } else if (budget.status === 'exceeded') {
    exceeded = true
    reason = 'budget is exceeded'
  }

  return {
    sessionId: budget.sessionId,
    exceeded,
    ...(reason !== undefined ? { reason } : {}),
    remainingTokens,
    remainingCalls,
    tokenUsed: budget.tokenUsed,
    callUsed: effectiveCallUsed,
  }
}

/** Update budget limits. */
export function updateBudget(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
  updates: { tokenLimit?: number; callLimit?: number; timeWindowMs?: number; status?: BudgetStatus },
): Budget | undefined {
  const budget = readBudget(agent, id)
  if (!budget) return undefined

  if (updates.tokenLimit !== undefined) budget.tokenLimit = updates.tokenLimit
  if (updates.callLimit !== undefined) budget.callLimit = updates.callLimit
  if (updates.timeWindowMs !== undefined) budget.timeWindowMs = updates.timeWindowMs
  if (updates.status !== undefined) budget.status = updates.status

  // If limits were increased, budget might no longer be exceeded
  if (budget.status === 'exceeded' && budget.tokenUsed < budget.tokenLimit && budget.callUsed < budget.callLimit) {
    budget.status = 'active'
  }

  budget.updatedAt = nowISO()
  writeTextAtomic(budgetFile(agent, id), JSON.stringify(budget, null, 2))
  return budget
}

/** Reset usage counters for a budget. */
export function resetUsage(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): Budget | undefined {
  const budget = readBudget(agent, id)
  if (!budget) return undefined

  budget.tokenUsed = 0
  budget.callUsed = 0
  budget.windowStart = nowISO()
  budget.status = 'active'
  budget.updatedAt = nowISO()

  writeTextAtomic(budgetFile(agent, id), JSON.stringify(budget, null, 2))
  return budget
}

/** Delete a budget. */
export function deleteBudget(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): boolean {
  const file = budgetFile(agent, id)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}