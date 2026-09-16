/**
 * recovery.ts - Recovery and replanning for failed task outcomes.
 *
 * Turns a failed task outcome into a validated plan patch. The design is
 * adapted from open-multi-agent (OMA) orchestrator/recovery.ts, and
 * trimmed down to what deepseek-harness actually needs.
 *
 * Contents:
 * - PlanPatch: a plan revision with three operations (addTasks / retargetPending / supersedePending)
 * - Replanner: produces and applies a plan patch for an outcome
 * - onPlanPatch: notified when a patch is produced, so callers can accept or veto it
 * - Defaults: maxPlanRevisions(3), maxAddedTasks(20)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Recovery mode: fixed = never replan, repairable = allow replanning. */
export type RecoveryMode = 'fixed' | 'repairable'

/** The three ways a task can finish. */
export type TaskOutcomeKind = 'success' | 'failure' | 'verification_rejected'

/** Immutable snapshot of one task - the shape a plan patch reasons about. */
export interface TaskSnapshot {
  id: string
  title: string
  description: string
  status: string
  assignee?: string
  dependsOn?: string[]
  createdAt: string
  updatedAt: string
}

/** A finished task plus its result and verification verdict. */
export interface TaskOutcome {
  kind: TaskOutcomeKind
  task: TaskSnapshot
  result?: { success: boolean; output?: unknown; errorInfo?: unknown }
  verification?: { verdict: 'approved' | 'rejected'; reason?: string }
  planRevision?: number
  tasks: TaskSnapshot[]
}

/** One task to add, before it is materialised with a real ID. */
export interface PlanPatchTask {
  /** Stable key identifying this task within the patch; referenced by dependsOn. */
  key: string
  title: string
  description: string
  assignee?: string
  /** Patch keys or existing task IDs this task waits on. */
  dependsOn?: string[]
}

/** Move an existing pending task to a different assignee. */
export interface PlanPatchRetarget {
  taskId: string
  assignee: string
}

/** Supersede an existing task, dropping it from the plan. */
export interface PlanPatchSupersede {
  taskId: string
}

/** A single plan revision: why, plus the operations to apply. */
export interface PlanPatch {
  reason: string
  addTasks?: PlanPatchTask[]
  retargetPending?: PlanPatchRetarget[]
  supersedePending?: PlanPatchSupersede[]
}

/** Recovery configuration (all optional; per-run values win over these). */
export interface RecoveryOptions {
  mode?: RecoveryMode
  replanner?: Replanner
  onTaskOutcome?: (outcome: TaskOutcome) => PlanPatch | undefined
  onPlanPatch?: (patch: PlanPatch, outcome: TaskOutcome) => boolean | Promise<boolean>
  maxPlanRevisions?: number
  maxAddedTasks?: number
}

/** Replanner - an object that turns an outcome into a plan patch. */
export interface Replanner {
  name: string
  replan(outcome: TaskOutcome): PlanPatch | undefined
}

/** Recovery options with defaults filled in (what the runtime consumes). */
export interface ResolvedRecoveryOptions {
  mode: RecoveryMode
  onTaskOutcome?: (outcome: TaskOutcome) => PlanPatch | undefined
  onPlanPatch?: (patch: PlanPatch, outcome: TaskOutcome) => boolean | Promise<boolean>
  maxPlanRevisions: number
  maxAddedTasks: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a validated positive integer, or the fallback when it is unset.
 * @param value - candidate value (undefined/null means "unset")
 * @param fallback - value used when it is unset
 * @param name - option name, used in the error message
 * @returns the resolved positive integer
 */
function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

/**
 * Merge the configured and per-run options into a complete, validated set.
 *
 * Rules:
 * - perRun wins over configured for every field
 * - an unset mode defaults to 'fixed'
 * - onTaskOutcome and replanner are mutually exclusive
 * - repairable mode requires exactly one of onTaskOutcome / replanner
 *
 * @param configured - deployment-level recovery options
 * @param perRun - per-run overrides (take precedence)
 * @returns the resolved options
 * @throws if both onTaskOutcome and replanner are set
 * @throws if repairable mode is set without onTaskOutcome or replanner
 */
export function resolveRecoveryOptions(
  configured: RecoveryOptions | undefined,
  perRun: RecoveryOptions | undefined,
): ResolvedRecoveryOptions {
  // Precedence: perRun overrides configured.
  const mode = perRun?.mode ?? configured?.mode
  const replanner = perRun?.replanner ?? configured?.replanner
  const onTaskOutcome = perRun?.onTaskOutcome ?? configured?.onTaskOutcome
  const onPlanPatch = perRun?.onPlanPatch ?? configured?.onPlanPatch
  const maxPlanRevisions = perRun?.maxPlanRevisions ?? configured?.maxPlanRevisions
  const maxAddedTasks = perRun?.maxAddedTasks ?? configured?.maxAddedTasks

  // Unset or 'fixed': fixed mode never replans.
  if (mode === undefined || mode === 'fixed') {
    return {
      mode: 'fixed',
      maxPlanRevisions: positiveInteger(maxPlanRevisions, 3, 'maxPlanRevisions'),
      maxAddedTasks: positiveInteger(maxAddedTasks, 20, 'maxAddedTasks'),
    }
  }

  // mode === 'repairable'

  // Repairable mode: the two replanning strategies are mutually exclusive.
  if (onTaskOutcome && replanner) {
    throw new Error(
      'Cannot specify both onTaskOutcome and replanner in repairable mode - choose one strategy',
    )
  }

  // Repairable mode also requires at least one replanning strategy.
  if (!onTaskOutcome && !replanner) {
    throw new Error(
      'Repairable mode requires either onTaskOutcome or replanner to be specified',
    )
  }

  // With only a replanner given, wrap it as onTaskOutcome.
  const resolvedOnTaskOutcome = onTaskOutcome ?? ((outcome: TaskOutcome) => replanner!.replan(outcome))

  return {
    mode: 'repairable',
    onTaskOutcome: resolvedOnTaskOutcome,
    ...(onPlanPatch !== undefined ? { onPlanPatch } : {}),
    maxPlanRevisions: positiveInteger(maxPlanRevisions, 3, 'maxPlanRevisions'),
    maxAddedTasks: positiveInteger(maxAddedTasks, 20, 'maxAddedTasks'),
  }
}

/**
 * Build a TaskOutcome from a task, its result, and optional verification.
 *
 * @param input - task, result, verification, planRevision and the task list
 * @returns the assembled TaskOutcome
 */
export function buildTaskOutcome(input: {
  task: TaskSnapshot
  result: { success: boolean; output?: unknown; errorInfo?: unknown }
  verification?: { verdict: 'approved' | 'rejected'; reason?: string }
  planRevision?: number
  tasks: TaskSnapshot[]
}): TaskOutcome {
  let kind: TaskOutcomeKind

  if (input.verification?.verdict === 'rejected') {
    kind = 'verification_rejected'
  } else if (input.result.success) {
    kind = 'success'
  } else {
    kind = 'failure'
  }

  return {
    kind,
    task: input.task,
    result: input.result,
    ...(input.verification !== undefined ? { verification: input.verification } : {}),
    ...(input.planRevision !== undefined ? { planRevision: input.planRevision } : {}),
    tasks: input.tasks,
  }
}

/**
 * Validate a PlanPatch against the existing board and the known agent names.
 *
 * Rules:
 * 1. retargetPending taskId must exist in the existing tasks
 * 2. retargetPending assignee must be a known agent name
 * 3. addTasks assignee (when set) must be a known agent name
 * 4. supersedePending taskId must exist in the existing tasks
 * 5. addTasks dependsOn must resolve to a patch key or an existing task ID
 *
 * @param patch - the plan patch to check
 * @param existingTasks - current board used to resolve task IDs
 * @param agentNames - ?? agent ??
 * @throws on the first violated rule
 */
export function validatePlanPatch(
  patch: PlanPatch,
  existingTasks: readonly TaskSnapshot[],
  agentNames: readonly string[],
): void {
  const existingIds = new Set(existingTasks.map((t) => t.id))
  const agentSet = new Set(agentNames)

  // Patch-declared keys must be unique and non-empty.
  const patchKeys = new Set<string>()
  if (patch.addTasks) {
    for (const task of patch.addTasks) {
      // Key must be present.
      if (!task.key || task.key.trim() === '') {
        throw new Error(`addTasks: task key must not be empty`)
      }
      // Key must be unique.
      if (patchKeys.has(task.key)) {
        throw new Error(`addTasks: duplicate patch key "${task.key}"`)
      }
      patchKeys.add(task.key)

      // Assignee, when present, must name a known agent.
      if (task.assignee && !agentSet.has(task.assignee)) {
        throw new Error(
          `addTasks: assignee "${task.assignee}" for task "${task.key}" is not in agent names`,
        )
      }
    }

    // dependsOn must resolve to a patch key or an existing task ID.
    for (const task of patch.addTasks) {
      if (task.dependsOn) {
        for (const dep of task.dependsOn) {
          if (!patchKeys.has(dep) && !existingIds.has(dep)) {
            throw new Error(
              `addTasks: dependsOn reference "${dep}" in task "${task.key}" does not exist (not a patch key or existing task ID)`,
            )
          }
        }
      }
    }
  }

  // retargetPending
  if (patch.retargetPending) {
    for (const retarget of patch.retargetPending) {
      if (!existingIds.has(retarget.taskId)) {
        throw new Error(
          `retargetPending: taskId "${retarget.taskId}" does not exist in existing tasks`,
        )
      }
      if (!agentSet.has(retarget.assignee)) {
        throw new Error(
          `retargetPending: assignee "${retarget.assignee}" is not in agent names`,
        )
      }
    }
  }

  // supersedePending
  if (patch.supersedePending) {
    for (const supersede of patch.supersedePending) {
      if (!existingIds.has(supersede.taskId)) {
        throw new Error(
          `supersedePending: taskId "${supersede.taskId}" does not exist in existing tasks`,
        )
      }
    }
  }
}

/**
 * Total number of tasks added across all recorded plan revisions.
 *
 * @param revisions - revision records, each carrying an addedTasks map
 * @returns the summed number of added tasks
 */
export function countAddedTasks(
  revisions: readonly { addedTasks: Readonly<Record<string, string>> }[],
): number {
  let total = 0
  for (const revision of revisions) {
    total += Object.keys(revision.addedTasks).length
  }
  return total
}

/**
 * Stable signature for a PlanPatch (used to detect duplicate revisions).
 *
 * Note: ordering is normalised, so a reordered equivalent patch signs the same.
 *
 * @param patch - the plan patch to sign
 * @returns the signature string
 */
export function planPatchSignature(patch: PlanPatch): string {
  const parts: string[] = []

  parts.push(`reason:${patch.reason}`)

  if (patch.addTasks) {
    const addSorted = [...patch.addTasks].sort((a, b) => a.key.localeCompare(b.key))
    for (const t of addSorted) {
      const deps = t.dependsOn ? t.dependsOn.slice().sort().join(',') : ''
      parts.push(`add:${t.key}:${t.title}:${t.assignee ?? ''}:${deps}`)
    }
  }

  if (patch.retargetPending) {
    const retargetSorted = [...patch.retargetPending].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    )
    for (const r of retargetSorted) {
      parts.push(`retarget:${r.taskId}:${r.assignee}`)
    }
  }

  if (patch.supersedePending) {
    const supersedeSorted = [...patch.supersedePending].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    )
    for (const s of supersedeSorted) {
      parts.push(`supersede:${s.taskId}`)
    }
  }

  return parts.join('|')
}