/**
 * Plan replay module: freeze a plan preview into a serializable artifact,
 * validate/edit it, and replay it from the frozen artifact without calling
 * the coordinator.
 *
 * The plan-replay workflow has four stages:
 *  1. **Plan preview** - decompose a goal into a task DAG without executing.
 *  2. **Plan artifact** - freeze the plan into a serializable JSON that can
 *     be diffed, committed, and passed to other processes.
 *  3. **Plan editing** - edit the artifact (reassign, redescribe, add/remove
 *     tasks) before replay.
 *  4. **Plan replay** - execute from the frozen plan without invoking the
 *     coordinator.
 *
 * Plan artifacts are stored in `.team/plans/<name>.json`.
 *
 * @module @deepseek-ai/dsh-team-comm/plan-replay
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** One task in a plan artifact. */
export interface PlanTaskArtifact {
  /** Unique task identifier within this plan. */
  id: string
  /** Short human-readable title. */
  title: string
  /** Detailed description of what the task should accomplish. */
  description: string
  /** Session id of the assigned worker (optional at planning time). */
  assignee?: string
  /** IDs of tasks that must complete before this task starts. */
  dependsOn?: string[]
  /** Memory scope for this task: only dependencies' results, or all prior results. */
  memoryScope?: 'dependencies' | 'all'
  /** Maximum retry attempts on failure (default 0). */
  maxRetries?: number
  /** Fixed delay between retry attempts in milliseconds. */
  retryDelayMs?: number
  /** Backoff multiplier applied to retryDelayMs on each subsequent retry. */
  retryBackoff?: number
}

/** A frozen, serializable plan artifact. */
export interface PlanArtifact {
  /** Schema version. Always 1. */
  version: 1
  /** The original goal the plan was generated for. */
  goal?: string
  /** The task DAG. */
  tasks: PlanTaskArtifact[]
}

/** Result of a plan-only preview (no execution). */
export interface PlanPreviewResult {
  /** Indicates this is a plan-only result (no execution occurred). */
  planOnly: true
  /** Indicates the preview succeeded. */
  success: true
  /** All tasks in pending status (not yet executed). */
  tasks: PlanTaskArtifact[]
  /** Total token usage from the planning call, if available. */
  totalTokenUsage?: { input: number; output: number }
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Create a plan artifact from a plan preview result.
 *
 * Validates that the input is a plan-only result and that every task has a
 * description, then constructs a `PlanArtifact` with version 1.
 *
 * @throws if `preview.planOnly` is not `true`
 * @throws if any task lacks a `description`
 */
export function createPlanArtifact(preview: PlanPreviewResult): PlanArtifact {
  if (preview.planOnly !== true) {
    throw new Error('createPlanArtifact: input must be a plan-only result (planOnly === true)')
  }
  if (preview.success !== true) {
    throw new Error('createPlanArtifact: input must be a successful preview (success === true)')
  }
  for (const task of preview.tasks) {
    if (typeof task.description !== 'string' || task.description.trim().length === 0) {
      throw new Error(`createPlanArtifact: task "${task.id}" must have a non-empty description`)
    }
  }
  return {
    version: 1,

    tasks: preview.tasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
      ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
      ...(t.memoryScope !== undefined ? { memoryScope: t.memoryScope } : {}),
      ...(t.maxRetries !== undefined ? { maxRetries: t.maxRetries } : {}),
      ...(t.retryDelayMs !== undefined ? { retryDelayMs: t.retryDelayMs } : {}),
      ...(t.retryBackoff !== undefined ? { retryBackoff: t.retryBackoff } : {}),
    })),
  }
}

/**
 * Validate a plan artifact thoroughly.
 *
 * Checks:
 *  1. `version` is 1
 *  2. `tasks` array is not empty
 *  3. Every task has `id`, `title`, `description`
 *  4. The dependency graph has no cycles
 *  5. All dependency references point to existing task IDs
 *
 * @throws on any validation failure with a descriptive message
 */
export function validatePlanArtifact(plan: PlanArtifact): void {
  if (plan.version !== 1) {
    throw new Error(`validatePlanArtifact: version must be 1, got ${plan.version}`)
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('validatePlanArtifact: tasks must be a non-empty array')
  }
  const ids = new Set<string>()
  for (const task of plan.tasks) {
    if (typeof task.id !== 'string' || task.id.length === 0) {
      throw new Error('validatePlanArtifact: every task must have a non-empty id')
    }
    if (ids.has(task.id)) {
      throw new Error(`validatePlanArtifact: duplicate task id "${task.id}"`)
    }
    ids.add(task.id)
    if (typeof task.title !== 'string' || task.title.length === 0) {
      throw new Error(`validatePlanArtifact: task "${task.id}" must have a non-empty title`)
    }
    if (typeof task.description !== 'string' || task.description.length === 0) {
      throw new Error(`validatePlanArtifact: task "${task.id}" must have a non-empty description`)
    }
  }
  // Validate the dependency graph (unknown refs + cycles).
  validateDependencyGraph(plan.tasks)
}

/**
 * Validate the dependency graph of a list of tasks.
 *
 * Checks that all `dependsOn` references point to existing task IDs and
 * that there are no cycles in the dependency graph.
 *
 * @throws if any dependency references an unknown task ID
 * @throws if a cycle is detected in the dependency graph
 */
export function validateDependencyGraph(tasks: PlanTaskArtifact[]): void {
  const unknown = findUnknownDependencies(tasks)
  if (unknown.length > 0) {
    const details = unknown.map(({ taskId, depId }) => `"${taskId}" depends on unknown "${depId}"`).join('; ')
    throw new Error(`validateDependencyGraph: ${details}`)
  }
  if (hasCycle(tasks)) {
    throw new Error('validateDependencyGraph: cycle detected in task dependencies')
  }
}

// ---------------------------------------------------------------------------
// File system operations
// ---------------------------------------------------------------------------

/** Directory under the team workspace where plan artifacts are stored. */
const PLANS_SUBDIR = 'plans'

/**
 * Save a plan artifact to `.team/plans/<name>.json`.
 *
 * Creates the directory if it does not exist. Writes atomically via a
 * temp-file rename to prevent concurrent readers from seeing a partial file.
 *
 * @returns the absolute file path of the saved artifact
 */
export function savePlanArtifact(plan: PlanArtifact, teamDir: string, name: string): string {
  validatePlanArtifact(plan)
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('savePlanArtifact: name must be a non-empty string')
  }
  // Reject path separators in the plan name to prevent path traversal.
  if (/[\\/]/.test(name) || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error(`savePlanArtifact: invalid plan name "${name}"`)
  }
  const plansDir = join(teamDir, PLANS_SUBDIR)
  mkdirSync(plansDir, { recursive: true })
  const file = join(plansDir, `${name}.json`)
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(plan, null, 2))
  // Atomic rename (on POSIX); on Windows, retry on transient EPERM/EBUSY.
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {

      renameSync(tmp, file)
      return file
    } catch (err) {
      lastError = err
      if (!existsSync(tmp)) {
        // Another writer already renamed it - assume success.
        return file
      }
      // Brief spin-wait for Windows share lock release.
      const wait = 10 * (attempt + 1)
      const until = Date.now() + wait
      while (Date.now() < until) { /* spin */ }
    }
  }
  // Last resort: non-atomic direct write.
  writeFileSync(file, JSON.stringify(plan, null, 2))
  try { unlinkSync(tmp) } catch { /* best-effort */ }
  if (lastError !== undefined) {
    console.warn('[plan-replay] savePlanArtifact: rename contended, fell back to direct write:', lastError)
  }
  return file
}

/**
 * Load a plan artifact from `.team/plans/<name>.json`.
 *
 * @returns the parsed plan artifact, or `null` if the file does not exist
 *          or cannot be parsed
 */
export function loadPlanArtifact(teamDir: string, name: string): PlanArtifact | null {
  if (typeof name !== 'string' || name.length === 0) return null
  if (/[\\/]/.test(name) || name === '.' || name === '..' || name.includes('\0')) return null
  const file = join(teamDir, PLANS_SUBDIR, `${name}.json`)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as PlanArtifact
    // Basic shape check before returning.
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * List all saved plan artifacts by name (without the `.json` extension).
 *
 * @returns an array of plan names sorted alphabetically
 */
export function listPlanArtifacts(teamDir: string): string[] {
  const plansDir = join(teamDir, PLANS_SUBDIR)
  if (!existsSync(plansDir)) return []
  const names: string[] = []
  for (const file of readdirSync(plansDir)) {
    if (!file.endsWith('.json')) continue
    names.push(file.slice(0, -5)) // strip ".json"
  }
  return names.sort()
}

/**
 * Delete a plan artifact from `.team/plans/<name>.json`.
 *
 * @returns `true` if the file was deleted, `false` if it did not exist
 */
export function deletePlanArtifact(teamDir: string, name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  if (/[\\/]/.test(name) || name === '.' || name === '..' || name.includes('\0')) return false
  const file = join(teamDir, PLANS_SUBDIR, `${name}.json`)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Auxiliary functions
// ---------------------------------------------------------------------------

/**
 * Detect whether the dependency graph contains a cycle using DFS with
 * three-color marking (WHITE = unvisited, GRAY = on current path, BLACK = done).
 *
 * @returns `true` if a cycle exists, `false` otherwise
 */
export function hasCycle(tasks: PlanTaskArtifact[]): boolean {
  // Build adjacency list: taskId ? list of task IDs that depend on it.
  const adj = new Map<string, string[]>()
  const taskIds = new Set<string>()
  for (const task of tasks) {
    taskIds.add(task.id)
    adj.set(task.id, [])
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      // Only add edges for known dependencies; unknown ones are handled
      // separately by findUnknownDependencies.
      if (taskIds.has(dep)) {
        adj.get(dep)!.push(task.id)
      }
    }
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of taskIds) color.set(id, WHITE)

  const dfs = (u: string): boolean => {
    color.set(u, GRAY)
    for (const v of adj.get(u) ?? []) {
      const cv = color.get(v) ?? WHITE
      if (cv === GRAY) return true // back edge ? cycle
      if (cv === WHITE && dfs(v)) return true
    }
    color.set(u, BLACK)
    return false
  }

  for (const id of taskIds) {
    if (color.get(id) === WHITE && dfs(id)) return true
  }
  return false
}

/**
 * Find all `dependsOn` references that point to task IDs not present in the
 * task list.
 *
 * @returns an array of `{ taskId, depId }` pairs for each unknown dependency
 */
export function findUnknownDependencies(tasks: PlanTaskArtifact[]): Array<{ taskId: string; depId: string }> {
  const knownIds = new Set(tasks.map(t => t.id))
  const unknown: Array<{ taskId: string; depId: string }> = []
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!knownIds.has(dep)) {
        unknown.push({ taskId: task.id, depId: dep })
      }
    }
  }
  return unknown
}