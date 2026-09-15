/**
 * recovery.ts - ???????
 *
 * ??????????,????????????
 * ?? open-multi-agent (OMA) ? orchestrator/recovery.ts,
 * ??? deepseek-harness ????????
 *
 * ????:
 * - PlanPatch:?????????(addTasks / retargetPending / supersedePending)
 * - Replanner:??????????????
 * - onPlanPatch:????,?????????
 * - ??:maxPlanRevisions(??3)?maxAddedTasks(??20)
 */

// ---------------------------------------------------------------------------
// ????
// ---------------------------------------------------------------------------

/** ????:fixed = ????,repairable = ???? */
export type RecoveryMode = 'fixed' | 'repairable'

/** ?????? */
export type TaskOutcomeKind = 'success' | 'failure' | 'verification_rejected'

/** ???? - ?????????????? */
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

/** ?????? */
export interface TaskOutcome {
  kind: TaskOutcomeKind
  task: TaskSnapshot
  result?: { success: boolean; output?: unknown; errorInfo?: unknown }
  verification?: { verdict: 'approved' | 'rejected'; reason?: string }
  planRevision?: number
  tasks: TaskSnapshot[]
}

/** ????????? */
export interface PlanPatchTask {
  /** ?????,??? dependsOn ??? */
  key: string
  title: string
  description: string
  assignee?: string
  /** ????????? key ????? ID */
  dependsOn?: string[]
}

/** ?????????? assignee */
export interface PlanPatchRetarget {
  taskId: string
  assignee: string
}

/** ??????????? */
export interface PlanPatchSupersede {
  taskId: string
}

/** ????????? */
export interface PlanPatch {
  reason: string
  addTasks?: PlanPatchTask[]
  retargetPending?: PlanPatchRetarget[]
  supersedePending?: PlanPatchSupersede[]
}

/** ????(????) */
export interface RecoveryOptions {
  mode?: RecoveryMode
  replanner?: Replanner
  onTaskOutcome?: (outcome: TaskOutcome) => PlanPatch | undefined
  onPlanPatch?: (patch: PlanPatch, outcome: TaskOutcome) => boolean | Promise<boolean>
  maxPlanRevisions?: number
  maxAddedTasks?: number
}

/** ?????? - ?????????????? */
export interface Replanner {
  name: string
  replan(outcome: TaskOutcome): PlanPatch | undefined
}

/** ????????(?????) */
export interface ResolvedRecoveryOptions {
  mode: RecoveryMode
  onTaskOutcome?: (outcome: TaskOutcome) => PlanPatch | undefined
  onPlanPatch?: (patch: PlanPatch, outcome: TaskOutcome) => boolean | Promise<boolean>
  maxPlanRevisions: number
  maxAddedTasks: number
}

// ---------------------------------------------------------------------------
// ????
// ---------------------------------------------------------------------------

/**
 * ???????,???????? fallback?
 * @param value - ??????
 * @param fallback - ???
 * @param name - ???(??????)
 * @returns ???????
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
// ????
// ---------------------------------------------------------------------------

/**
 * ??????,???????????????
 *
 * ?????:
 * - perRun(????)?????? configured(????)
 * - ????????? mode,??? 'fixed'
 * - onTaskOutcome ? replanner ??????
 * - repairable ??????? onTaskOutcome ? replanner ??
 *
 * @param configured - ?????????
 * @param perRun - ?????????(??????)
 * @returns ????????
 * @throws ?? onTaskOutcome ? replanner ????
 * @throws ?? repairable ??????? onTaskOutcome ? replanner
 */
export function resolveRecoveryOptions(
  configured: RecoveryOptions | undefined,
  perRun: RecoveryOptions | undefined,
): ResolvedRecoveryOptions {
  // ????:perRun ??? configured
  const mode = perRun?.mode ?? configured?.mode
  const replanner = perRun?.replanner ?? configured?.replanner
  const onTaskOutcome = perRun?.onTaskOutcome ?? configured?.onTaskOutcome
  const onPlanPatch = perRun?.onPlanPatch ?? configured?.onPlanPatch
  const maxPlanRevisions = perRun?.maxPlanRevisions ?? configured?.maxPlanRevisions
  const maxAddedTasks = perRun?.maxAddedTasks ?? configured?.maxAddedTasks

  // ??????? mode ? 'fixed',?? fixed ??
  if (mode === undefined || mode === 'fixed') {
    return {
      mode: 'fixed',
      maxPlanRevisions: positiveInteger(maxPlanRevisions, 3, 'maxPlanRevisions'),
      maxAddedTasks: positiveInteger(maxAddedTasks, 20, 'maxAddedTasks'),
    }
  }

  // mode === 'repairable'

  // ????? onTaskOutcome ? replanner,????
  if (onTaskOutcome && replanner) {
    throw new Error(
      'Cannot specify both onTaskOutcome and replanner in repairable mode - choose one strategy',
    )
  }

  // ???? onTaskOutcome ??? replanner,????
  if (!onTaskOutcome && !replanner) {
    throw new Error(
      'Repairable mode requires either onTaskOutcome or replanner to be specified',
    )
  }

  // ????? replanner,????? onTaskOutcome
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
 * ?????????? TaskOutcome?
 *
 * @param input - ?????????????????
 * @returns ???? TaskOutcome
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
 * ?? PlanPatch ?????
 *
 * ????:
 * 1. retargetPending ?? taskId ??????????
 * 2. retargetPending ?? assignee ??? agent ???
 * 3. addTasks ?? assignee(???)??? agent ???
 * 4. supersedePending ?? taskId ??????????
 * 5. addTasks ?? dependsOn ??? key/ID ????(????? key ????? ID)
 *
 * @param patch - ??????
 * @param existingTasks - ??????
 * @param agentNames - ?? agent ??
 * @throws ??????
 */
export function validatePlanPatch(
  patch: PlanPatch,
  existingTasks: readonly TaskSnapshot[],
  agentNames: readonly string[],
): void {
  const existingIds = new Set(existingTasks.map((t) => t.id))
  const agentSet = new Set(agentNames)

  // ?????????????
  const patchKeys = new Set<string>()
  if (patch.addTasks) {
    for (const task of patch.addTasks) {
      // ?? key ???
      if (!task.key || task.key.trim() === '') {
        throw new Error(`addTasks: task key must not be empty`)
      }
      // ?? key ???
      if (patchKeys.has(task.key)) {
        throw new Error(`addTasks: duplicate patch key "${task.key}"`)
      }
      patchKeys.add(task.key)

      // ?? assignee ? agent ???
      if (task.assignee && !agentSet.has(task.assignee)) {
        throw new Error(
          `addTasks: assignee "${task.assignee}" for task "${task.key}" is not in agent names`,
        )
      }
    }

    // ?? dependsOn ??:???????? key ????? ID
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

  // ?? retargetPending
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

  // ?? supersedePending
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
 * ??????????????????
 *
 * @param revisions - ??????,???? addedTasks ??
 * @returns ?????????
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
 * ?? PlanPatch ???(???????)?
 *
 * ????:?????????????,?????????????
 *
 * @param patch - ????????
 * @returns ?????
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