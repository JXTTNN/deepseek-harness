/**
 * Execution receipt - structured evidence of a multi-agent run built from
 * the team event logs (`.team/*.jsonl`).
 *
 * A receipt captures WHO ran (roles), in WHAT ORDER (execution order), how
 * they DEPENDED on each other (dependency edges), whether independent review
 * occurred, and how long the whole run took. It is designed to be
 * non-throwing: even with partial or malformed data it returns a usable
 * receipt with `partial: true` rather than throwing.
 *
 * Adapted from the OMA `execution-receipt` observability module to the
 * deepseek-harness file-system team-comm model where events live in
 * `.team/*.jsonl` append-only ledgers.
 *
 * @module @deepseek-ai/dsh-team-comm/execution-receipt
 */

// ?? Public types ????????????????????????????????????????????????????????

/** A directed dependency edge between two roles (sessions). */
export interface ExecutionReceiptDependencyEdge {
  from: string
  to: string
}

/** One approval/decision recorded during the run. */
export interface ExecutionReceiptApprovalDecision {
  requestId: string
  scope: 'plan' | 'task_round' | 'task_dispatch' | 'tool_call'
  requestHash: string
  decision: 'approved' | 'rejected'
  reviewerId: string
  reviewerDisplayName?: string
  decidedAt: string
}

/** The structured execution receipt returned by `buildExecutionReceipt`. */
export interface ExecutionReceipt {
  mode: 'single' | 'multi-agent'
  rolesExecuted: string[]
  executionOrder: string[]
  dependencyEdges: ExecutionReceiptDependencyEdge[]
  independentRolesCount: number
  independentReviewOccurred: boolean
  approvalDecisions?: ExecutionReceiptApprovalDecision[]
  totalTokens: { input: number; output: number } | null
  durationMs: number | null
  partial: boolean
}

/** One unified event from the merged team logs (matches `AuditEvent`). */
export interface TeamEvent {
  ts: string
  source: string
  action: string
  session?: string
  payload: unknown
}

// ?? Internal types ??????????????????????????????????????????????????????

/** Extracted facts about a single task, used to derive roles and edges. */
interface TaskFact {
  id: string | undefined
  role: string | undefined
  dependsOn: string[]
  startMs: number | undefined
  endMs: number | undefined
}

// ?? Helpers ?????????????????????????????????????????????????????????????

/** Return an empty (zero-value) receipt for the single-agent default. */
function emptyReceipt(): ExecutionReceipt {
  return {
    mode: 'single',
    rolesExecuted: [],
    executionOrder: [],
    dependencyEdges: [],
    independentRolesCount: 0,
    independentReviewOccurred: false,
    totalTokens: null,
    durationMs: null,
    partial: true,
  }
}

/**
 * Extract task facts from the unified event stream. Each `task` action event
 * contributes one TaskFact. Task records in `tasks.jsonl` carry `id`,
 * `createdBy` (the role/session that created the task), `deps` (ids of tasks
 * this one depends on), `ts` (creation timestamp), and `updatedTs` (last
 * update timestamp, used as the end time when the task reached a terminal
 * state).
 *
 * Returns a Map keyed by task id for O(1) dependency lookups.
 */
function readTaskFacts(events: readonly TeamEvent[]): Map<string, TaskFact> {
  const facts = new Map<string, TaskFact>()

  for (const event of events) {
    if (event.action !== 'task') continue

    const payload = event.payload as Record<string, unknown> | null
    if (payload === null || typeof payload !== 'object') continue

    const id = typeof payload['id'] === 'string' ? payload['id'] : undefined
    if (id === undefined) continue

    const role = typeof payload['createdBy'] === 'string' ? payload['createdBy'] : undefined
    const depsRaw = payload['deps']
    const dependsOn: string[] = Array.isArray(depsRaw)
      ? depsRaw.filter((d): d is string => typeof d === 'string')
      : []

    const tsStr = typeof payload['ts'] === 'string' ? payload['ts'] : undefined
    const updatedTsStr = typeof payload['updatedTs'] === 'string' ? payload['updatedTs'] : undefined
    const status = typeof payload['status'] === 'string' ? payload['status'] : undefined

    const startMs = tsStr !== undefined ? parseTs(tsStr) : undefined
    // The end time is the last update timestamp when the task reached a
    // terminal state; otherwise we treat it as still running (endMs = undefined).
    const endMs = (status === 'done' || status === 'blocked') && updatedTsStr !== undefined
      ? parseTs(updatedTsStr)
      : undefined

    // Merge: a task may appear in multiple events (create + updates).
    // Keep the earliest start time and the latest known end time.
    const existing = facts.get(id)
    if (existing !== undefined) {
      if (startMs !== undefined && (existing.startMs === undefined || startMs < existing.startMs)) {
        existing.startMs = startMs
      }
      if (endMs !== undefined && (existing.endMs === undefined || endMs > existing.endMs)) {
        existing.endMs = endMs
      }
      // Role and deps from the first sighting are authoritative; later
      // events only extend timing.
      if (existing.role === undefined && role !== undefined) existing.role = role
      if (existing.dependsOn.length === 0) existing.dependsOn = dependsOn
    } else {
      facts.set(id, { id, role, dependsOn, startMs, endMs })
    }
  }

  return facts
}

/** Parse an ISO-8601 timestamp to epoch milliseconds, returning undefined on failure. */
function parseTs(ts: string): number | undefined {
  const ms = new Date(ts).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Extract cross-role dependency edges from task facts. An edge `from ? to`
 * means role `from` produced a task that role `to` depended on (i.e. `to`
 * waited on `from`'s work). We only record edges where the two roles differ
 * - intra-role dependencies are not interesting for the receipt.
 */
function extractDependencyEdges(
  taskFacts: Map<string, TaskFact>,
): ExecutionReceiptDependencyEdge[] {
  const edges: ExecutionReceiptDependencyEdge[] = []
  const seen = new Set<string>()

  for (const fact of taskFacts.values()) {
    if (fact.role === undefined) continue
    for (const depId of fact.dependsOn) {
      const depFact = taskFacts.get(depId)
      if (depFact === undefined || depFact.role === undefined) continue
      if (depFact.role === fact.role) continue // same role - not a cross-role edge

      const key = `${depFact.role}?${fact.role}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: depFact.role, to: fact.role })
    }
  }

  return edges
}

/**
 * Determine the execution order of roles by sorting them by their earliest
 * task start time. Roles with no start time (e.g. only created tasks but
 * never had a timed event) are appended at the end in insertion order.
 */
function computeExecutionOrder(
  rolesWithStart: Array<{ role: string; startMs: number }>,
  allRoles: string[],
): string[] {
  // Sort roles with known start times ascending.
  const sorted = [...rolesWithStart].sort((a, b) => a.startMs - b.startMs)

  const orderedKnown = sorted.map(r => r.role)
  const knownSet = new Set(orderedKnown)

  // Append any roles that had no timed events, preserving their discovery order.
  const orderedUnknown = allRoles.filter(r => !knownSet.has(r))

  return [...orderedKnown, ...orderedUnknown]
}

/**
 * Extract approval decisions from review events. A review request followed by
 * a reply carrying a verdict ("pass"/"fail"/"needs-changes") is mapped to an
 * approval decision. This is best-effort: malformed events are skipped.
 */
function extractApprovalDecisions(
  events: readonly TeamEvent[],
): ExecutionReceiptApprovalDecision[] | undefined {
  const decisions: ExecutionReceiptApprovalDecision[] = []

  // Review requests: { reviewId, from, target, subject, content, msgId, ts }
  // Review replies arrive as inbox messages with replyTo = the review's msgId.
  // We match them by scanning `message` action events whose replyTo points to
  // a known review msgId.
  const reviewByMsgId = new Map<string, { reviewId: string; from: string; ts: string }>()

  for (const event of events) {
    if (event.action !== 'review') continue
    const payload = event.payload as Record<string, unknown> | null
    if (payload === null) continue

    const reviewId = typeof payload['reviewId'] === 'string' ? payload['reviewId'] : undefined
    const msgId = typeof payload['msgId'] === 'string' ? payload['msgId'] : undefined
    const from = typeof payload['from'] === 'string' ? payload['from'] : undefined
    const ts = typeof payload['ts'] === 'string' ? payload['ts'] : undefined

    if (reviewId === undefined || msgId === undefined || from === undefined || ts === undefined) {
      continue
    }
    reviewByMsgId.set(msgId, { reviewId, from, ts })
  }

  if (reviewByMsgId.size === 0) return undefined

  // Scan message events for replies that match a review msgId.
  for (const event of events) {
    if (event.action !== 'message') continue
    const payload = event.payload as Record<string, unknown> | null
    if (payload === null) continue

    const replyTo = typeof payload['replyTo'] === 'string' ? payload['replyTo'] : undefined
    const messageText = typeof payload['message'] === 'string' ? payload['message'] : undefined
    const from = typeof payload['from'] === 'string' ? payload['from'] : undefined
    const ts = typeof payload['ts'] === 'string' ? payload['ts'] : undefined

    if (replyTo === undefined || messageText === undefined || from === undefined || ts === undefined) {
      continue
    }

    const review = reviewByMsgId.get(replyTo)
    if (review === undefined) continue

    // Parse the verdict from the reply message text.
    const verdict = parseReviewVerdict(messageText)
    if (verdict === undefined) continue

    decisions.push({
      requestId: review.reviewId,
      scope: 'task_round',
      requestHash: replyTo,
      decision: verdict === 'pass' ? 'approved' : 'rejected',
      reviewerId: from,
      decidedAt: ts,
    })
  }

  return decisions.length > 0 ? decisions : undefined
}

/** Parse a review verdict from a reply message. Returns 'pass' | 'fail' | 'needs-changes' or undefined. */
function parseReviewVerdict(message: string): 'pass' | 'fail' | 'needs-changes' | undefined {
  // The review protocol asks the reviewer to reply with:
  //   "VERDICT: <pass|fail|needs-changes>\nFINDINGS:\n- ..."
  // Be lenient: match the first occurrence of a known verdict keyword.
  const lower = message.toLowerCase()
  if (lower.includes('verdict:')) {
    const afterVerdict = lower.slice(lower.indexOf('verdict:') + 'verdict:'.length)
    if (afterVerdict.includes('pass')) return 'pass'
    if (afterVerdict.includes('fail')) return 'fail'
    if (afterVerdict.includes('needs-changes') || afterVerdict.includes('needs changes')) {
      return 'needs-changes'
    }
  }
  // Fallback: look for a standalone verdict keyword anywhere in the message.
  if (/\bpass\b/.test(lower)) return 'pass'
  if (/\bfail\b/.test(lower)) return 'fail'
  if (/needs.?changes/.test(lower)) return 'needs-changes'
  return undefined
}

// ?? Core function ???????????????????????????????????????????????????????

/**
 * Build a structured execution receipt from the unified team event stream.
 *
 * The receipt captures:
 * - Which roles (sessions) participated
 * - The order in which roles first started executing
 * - Cross-role dependency edges (role A's task was depended on by role B)
 * - Whether independent review occurred (2+ roles + dependency edges)
 * - Approval decisions extracted from review requests and verdicts
 * - Total run duration (earliest start to latest end)
 *
 * This function is **non-throwing**: if data is incomplete or malformed it
 * returns a partial receipt with `partial: true` rather than throwing.
 *
 * @param events - The unified team event stream (as produced by the audit
 *   module's `readAllAuditEvents`).
 * @param options - Optional configuration:
 *   - `teamDir`: the `.team/` directory path (reserved for future file-system
 *     reads; currently events are passed directly).
 *   - `runId`: an optional run identifier for filtering (reserved for future
 *     use when multiple runs coexist in the same team directory).
 */
export function buildExecutionReceipt(
  events: readonly TeamEvent[],
  _options?: {
    teamDir?: string
    runId?: string
  },
): ExecutionReceipt {
  // If there are no events at all, return a partial empty receipt.
  if (events.length === 0) {
    return emptyReceipt()
  }

  let partial = false

  // 1. Extract task facts from the event stream.
  const taskFacts = readTaskFacts(events)

  // 2. Collect all distinct roles (sessions) that appear in the events.
  //    A role is any session that either created a task, sent a message,
  //    or appeared as a review target.
  const roleSet = new Set<string>()

  for (const fact of taskFacts.values()) {
    if (fact.role !== undefined) roleSet.add(fact.role)
  }

  for (const event of events) {
    // `session` on the event is the originating session.
    if (event.session !== undefined) {
      roleSet.add(event.session)
    }
    // For message events, both `from` and `to` are roles.
    if (event.action === 'message' || event.action === 'send') {
      const payload = event.payload as Record<string, unknown> | null
      if (payload !== null) {
        const from = typeof payload['from'] === 'string' ? payload['from'] : undefined
        const to = typeof payload['to'] === 'string' ? payload['to'] : undefined
        if (from !== undefined) roleSet.add(from)
        if (to !== undefined) roleSet.add(to)
      }
    }
    // For review events, both `from` (requester) and `target` (reviewer) are roles.
    if (event.action === 'review') {
      const payload = event.payload as Record<string, unknown> | null
      if (payload !== null) {
        const from = typeof payload['from'] === 'string' ? payload['from'] : undefined
        const target = typeof payload['target'] === 'string' ? payload['target'] : undefined
        if (from !== undefined) roleSet.add(from)
        if (target !== undefined) roleSet.add(target)
      }
    }
  }

  const rolesExecuted = [...roleSet]

  // 3. Determine execution order: sort roles by the earliest start time of
  //    any task they created.
  const rolesWithStart: Array<{ role: string; startMs: number }> = []

  for (const fact of taskFacts.values()) {
    if (fact.role !== undefined && fact.startMs !== undefined) {
      // Keep the earliest start per role.
      const existing = rolesWithStart.find(r => r.role === fact.role)
      if (existing === undefined) {
        rolesWithStart.push({ role: fact.role, startMs: fact.startMs })
      } else if (fact.startMs < existing.startMs) {
        existing.startMs = fact.startMs
      }
    }
  }

  const executionOrder = computeExecutionOrder(rolesWithStart, rolesExecuted)

  // 4. Extract cross-role dependency edges.
  const dependencyEdges = extractDependencyEdges(taskFacts)

  // 5. Determine mode: multi-agent if 2+ roles, single otherwise.
  const mode: 'single' | 'multi-agent' = rolesExecuted.length >= 2 ? 'multi-agent' : 'single'

  // 6. Independent review occurred when there are 2+ roles AND at least one
  //    cross-role dependency edge (one role's work depended on another's).
  const independentReviewOccurred =
    rolesExecuted.length >= 2 && dependencyEdges.length > 0

  // 7. Count independent roles: roles that have no incoming or outgoing
  //    dependency edges (they ran without depending on or being depended on
  //    by any other role).
  const rolesInEdges = new Set<string>()
  for (const edge of dependencyEdges) {
    rolesInEdges.add(edge.from)
    rolesInEdges.add(edge.to)
  }
  const independentRolesCount = rolesExecuted.filter(r => !rolesInEdges.has(r)).length

  // 8. Compute total duration: from the earliest event timestamp to the
  //    latest event timestamp.
  let earliestMs: number | undefined
  let latestMs: number | undefined

  for (const event of events) {
    const ms = parseTs(event.ts)
    if (ms === undefined) {
      partial = true
      continue
    }
    if (earliestMs === undefined || ms < earliestMs) earliestMs = ms
    if (latestMs === undefined || ms > latestMs) latestMs = ms
  }

  // Also consider task end times for a more accurate "latest" timestamp.
  for (const fact of taskFacts.values()) {
    if (fact.endMs !== undefined) {
      if (latestMs === undefined || fact.endMs > latestMs) latestMs = fact.endMs
    }
  }

  const durationMs = earliestMs !== undefined && latestMs !== undefined
    ? latestMs - earliestMs
    : null

  if (durationMs === null) partial = true

  // 9. Extract approval decisions from review events and their replies.
  const approvalDecisions = extractApprovalDecisions(events)

  // 10. Token usage is not tracked in the current team-comm event model.
  //     Reserved for future integration with the agent runtime.
  const totalTokens: { input: number; output: number } | null = null

  // 11. If any task fact is missing a role or start time, mark as partial.
  for (const fact of taskFacts.values()) {
    if (fact.role === undefined || fact.startMs === undefined) {
      partial = true
      break
    }
  }

  return {
    mode,
    rolesExecuted,
    executionOrder,
    dependencyEdges,
    independentRolesCount,
    independentReviewOccurred,
    ...(approvalDecisions !== undefined ? { approvalDecisions } : {}),
    totalTokens,
    durationMs,
    partial,
  }
}