/**
 * Governance layer for team-comm: declarative governance intent, execution
 * receipt validation, and task-spec generation.
 *
 * This module adapts the open-multi-agent (OMA) governance model to
 * deepseek-harness's file-system-based team communication. A governance
 * declaration states what roles must participate and in what order; an
 * execution receipt records what actually happened. `evaluateGovernance`
 * compares the two and returns a conclusion. `buildGovernanceTaskSpecs`
 * turns a governance declaration into concrete task assignments.
 *
 * @module @deepseek-ai/dsh-team-comm/governance
 */

// -- Types --------------------------------------------------------------

/**
 * Whether a governance requirement is mandatory or merely preferred.
 * - `'required'`: the governance rules MUST be satisfied; violation is a failure.
 * - `'preferred'`: the governance rules SHOULD be satisfied but may be degraded
 *   (e.g. budget constraints) without failing.
 */
export type GovernanceIntent = 'required' | 'preferred'

/**
 * The outcome of evaluating a governance declaration against an execution receipt.
 * - `'satisfied'`: all required governance rules were met.
 * - `'unsatisfied'`: one or more required governance rules were violated.
 * - `'not-applicable'`: no governance was declared or the intent was not `'required'`.
 */
export type GovernanceConclusion = 'satisfied' | 'unsatisfied' | 'not-applicable'

/**
 * The specific reason a governance declaration was `'unsatisfied'`.
 * - `'overridden'`: the run explicitly overrode required governance mode.
 * - `'budget'`: a preferred governance was degraded due to budget constraints.
 * - `'missing_roles'`: one or more required roles did not execute.
 * - `'order_violation'`: the execution order did not match the required order.
 * - `'no_independent_review'`: with 2+ required roles, no independent review occurred.
 */
export type GovernanceUnsatisfiedReason =
  | 'overridden'
  | 'budget'
  | 'missing_roles'
  | 'order_violation'
  | 'no_independent_review'

/**
 * A governance declaration: what the orchestrator requires of a run.
 * All fields are optional; an empty/undefined declaration means no governance.
 */
export interface GovernanceDeclaration {
  /** Whether the rules are mandatory or preferred. */
  governanceIntent?: GovernanceIntent
  /** Roles that must all execute. */
  requiredRoles?: string[]
  /** The required execution order of roles (must be a permutation of `requiredRoles`). */
  requiredOrder?: string[]
}

/**
 * Runtime resolution that may relax a governance declaration.
 * Used by the orchestrator when it decides to override or degrade governance.
 */
export interface GovernanceRunResolution {
  /** If true, the run explicitly overrode required governance mode. */
  modeOverride?: boolean
  /** If true, a preferred governance was degraded due to budget constraints. */
  preferredBudgetDegraded?: boolean
}

/**
 * A directed edge in the execution dependency graph.
 * `from` executed before `to`; `to` depends on `from`.
 */
export interface ExecutionReceiptDependencyEdge {
  from: string
  to: string
}

/**
 * A record of what actually happened during a run, used to validate against
 * a governance declaration. Adapted for deepseek-harness's file-system model.
 */
export interface ExecutionReceipt {
  /** Whether the run was single-agent or multi-agent. */
  mode: 'single' | 'multi-agent'
  /** The set of roles that executed. */
  rolesExecuted: string[]
  /** The order in which roles executed (chronological). */
  executionOrder: string[]
  /** Directed dependency edges between roles. */
  dependencyEdges: ExecutionReceiptDependencyEdge[]
  /** Number of roles that executed independently (no incoming/outgoing edges). */
  independentRolesCount: number
  /** Whether an independent review (cross-role verification) occurred. */
  independentReviewOccurred: boolean
  /** Token usage, if tracked. */
  totalTokens: { input: number; output: number } | null
  /** Wall-clock duration in milliseconds, if tracked. */
  durationMs: number | null
  /** Whether the run was partial (incomplete). */
  partial: boolean
}

/**
 * A concrete task specification generated from a governance declaration.
 * Each task is assigned to a specific role (agent) and may depend on other tasks.
 */
export interface GovernanceTaskSpec {
  /** Short task title. */
  title: string
  /** Detailed task description. */
  description: string
  /** The agent/role assigned to this task. */
  assignee: string
  /** Tasks that must complete before this one starts. */
  dependsOn?: string[]
  /** Memory scope: whether the agent sees only dependency outputs or all context. */
  memoryScope?: 'dependencies' | 'all'
}

// -- Helper functions ---------------------------------------------------

/**
 * Find duplicate values in an array.
 * Returns a list of values that appear more than once (each duplicate value
 * appears only once in the result).
 *
 * @param values - the array to check for duplicates
 * @returns array of duplicate values (empty if no duplicates)
 */
function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) {
      duplicates.add(v)
    } else {
      seen.add(v)
    }
  }
  return [...duplicates]
}

/**
 * Check whether `values` is a permutation of `expected`.
 * Two arrays are permutations if they contain exactly the same elements
 * (with the same multiplicities), regardless of order.
 *
 * @param values - the array to check
 * @param expected - the reference array
 * @returns true if `values` is a permutation of `expected`
 */
function isPermutation(values: readonly string[], expected: readonly string[]): boolean {
  if (values.length !== expected.length) return false
  const expectedCounts = new Map<string, number>()
  for (const e of expected) {
    expectedCounts.set(e, (expectedCounts.get(e) ?? 0) + 1)
  }
  for (const v of values) {
    const count = expectedCounts.get(v)
    if (count === undefined || count <= 0) return false
    expectedCounts.set(v, count - 1)
  }
  return true
}

/**
 * Check whether the execution order in `receipt` matches the `requiredOrder`.
 *
 * For each consecutive pair (A, B) in `requiredOrder`, we verify that either:
 * 1. A appears before B in `executionOrder`, OR
 * 2. There is a dependency path from A to B in the dependency graph
 *    (meaning B transitively depends on A, enforcing A-before-B ordering).
 *
 * This dual check ensures the order constraint is satisfied whether the
 * execution was sequential (executionOrder) or DAG-based (dependencyEdges).
 *
 * @param requiredOrder - the required chronological order of roles
 * @param receipt - the execution receipt containing actual order and edges
 * @param executedRoles - the set of roles that actually executed
 * @returns true if the execution order satisfies the required order
 */
function matchesRequiredOrder(
  requiredOrder: readonly string[],
  receipt: ExecutionReceipt,
  executedRoles: ReadonlySet<string>,
): boolean {
  // Build adjacency list from dependency edges for path queries.
  const adjacency = new Map<string, Set<string>>()
  for (const role of executedRoles) {
    adjacency.set(role, new Set())
  }
  for (const edge of receipt.dependencyEdges) {
    const neighbors = adjacency.get(edge.from)
    if (neighbors !== undefined) {
      neighbors.add(edge.to)
    }
  }

  // Build a quick lookup: position of each role in executionOrder.
  const execPosition = new Map<string, number>()
  for (let i = 0; i < receipt.executionOrder.length; i++) {
    const role = receipt.executionOrder[i]
    if (role !== undefined) {
      execPosition.set(role, i)
    }
  }

  // For each consecutive pair in requiredOrder, verify A precedes B.
  for (let i = 0; i < requiredOrder.length - 1; i++) {
    const a = requiredOrder[i]
    const b = requiredOrder[i + 1]
    if (a === undefined || b === undefined) continue

    // Both roles must have executed.
    if (!executedRoles.has(a) || !executedRoles.has(b)) return false

    // Check 1: A appears before B in executionOrder.
    const posA = execPosition.get(a)
    const posB = execPosition.get(b)
    if (posA !== undefined && posB !== undefined && posA < posB) {
      continue // satisfied for this pair
    }

    // Check 2: There is a dependency path from A to B (B depends on A).
    if (hasDependencyPath(a, b, adjacency)) {
      continue // satisfied for this pair
    }

    // Neither check passed: order violation.
    return false
  }

  return true
}

/**
 * Check whether there is a directed path from `from` to `to` in the
 * dependency adjacency graph (BFS traversal).
 *
 * @param from - the starting node
 * @param to - the target node
 * @param adjacency - directed graph as adjacency list
 * @returns true if a path exists from `from` to `to`
 */
function hasDependencyPath(
  from: string,
  to: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (from === to) return true

  const visited = new Set<string>()
  const queue: string[] = [from]
  visited.add(from)

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break

    const neighbors = adjacency.get(current)
    if (neighbors === undefined) continue

    for (const neighbor of neighbors) {
      if (neighbor === to) return true
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
  }

  return false
}

// -- Core functions -----------------------------------------------------

/**
 * Evaluate a governance declaration against an execution receipt.
 *
 * The evaluation follows these steps:
 * 1. If `governanceIntent` is not `'required'`, return `'not-applicable'`.
 * 2. If `requiredRoles` is empty or contains duplicates, return `'unsatisfied'`.
 * 3. If not all required roles executed, return `'unsatisfied'` (reason: `missing_roles`).
 * 4. If `requiredOrder` is specified, validate it is a permutation of `requiredRoles`
 *    and that the execution order matches; otherwise return `'unsatisfied'` (reason: `order_violation`).
 * 5. If there are 2+ required roles, check that independent review occurred;
 *    otherwise return `'unsatisfied'` (reason: `no_independent_review`).
 * 6. All checks pass: return `'satisfied'`.
 *
 * @param declaration - the governance declaration (may be undefined)
 * @param receipt - the execution receipt to validate against
 * @returns the governance conclusion
 */
export function evaluateGovernance(
  declaration: GovernanceDeclaration | undefined,
  receipt: ExecutionReceipt,
): GovernanceConclusion {
  // Step 1: No declaration or not 'required' ? not applicable.
  if (declaration === undefined) return 'not-applicable'
  if (declaration.governanceIntent !== 'required') return 'not-applicable'

  const requiredRoles = declaration.requiredRoles ?? []

  // Step 2: Empty required roles or duplicates ? unsatisfied.
  if (requiredRoles.length === 0) return 'unsatisfied'
  const duplicates = findDuplicates(requiredRoles)
  if (duplicates.length > 0) return 'unsatisfied'

  // Step 3: All required roles must have executed.
  const executedSet = new Set(receipt.rolesExecuted)
  for (const role of requiredRoles) {
    if (!executedSet.has(role)) {
      return 'unsatisfied'
    }
  }

  // Step 4: If requiredOrder is specified, validate it.
  if (declaration.requiredOrder !== undefined && declaration.requiredOrder.length > 0) {
    // requiredOrder must be a permutation of requiredRoles.
    if (!isPermutation(declaration.requiredOrder, requiredRoles)) {
      return 'unsatisfied'
    }
    // Execution order must match the required order.
    if (!matchesRequiredOrder(declaration.requiredOrder, receipt, executedSet)) {
      return 'unsatisfied'
    }
  }

  // Step 5: With 2+ required roles, independent review must have occurred.
  if (requiredRoles.length >= 2) {
    if (!receipt.independentReviewOccurred) {
      return 'unsatisfied'
    }
  }

  // Step 6: All checks passed.
  return 'satisfied'
}

/**
 * Build concrete task specifications from a governance declaration.
 *
 * Given a goal, a list of available agent names, and a governance declaration,
 * this function produces an array of `GovernanceTaskSpec` - one per required
 * role - that can be dispatched to the team.
 *
 * Rules:
 * 1. If `governanceIntent` is not `'required'` or `'preferred'`, return `undefined`.
 * 2. `requiredRoles` must be non-empty, have no duplicates, and all be in `agentNames`.
 * 3. If `requiredOrder` is specified, it must be a permutation of `requiredRoles`.
 * 4. Tasks are ordered by `requiredOrder` (if specified) or `requiredRoles` (otherwise).
 * 5. If `requiredOrder` is specified, each task depends on the previous one
 *    (chain dependency). Otherwise, all tasks are independent.
 *
 * @param goal - the high-level goal description
 * @param agentNames - the available agent/role names
 * @param options - the governance declaration
 * @returns array of task specs, or `undefined` if governance is not applicable
 */
export function buildGovernanceTaskSpecs(
  goal: string,
  agentNames: readonly string[],
  options?: GovernanceDeclaration,
): GovernanceTaskSpec[] | undefined {
  // Step 1: Only 'required' or 'preferred' intent produces task specs.
  if (options === undefined) return undefined
  if (options.governanceIntent !== 'required' && options.governanceIntent !== 'preferred') {
    return undefined
  }

  const requiredRoles = options.requiredRoles ?? []

  // Step 2: Validate requiredRoles.
  if (requiredRoles.length === 0) return undefined
  const duplicates = findDuplicates(requiredRoles)
  if (duplicates.length > 0) return undefined

  const agentSet = new Set(agentNames)
  for (const role of requiredRoles) {
    if (!agentSet.has(role)) {
      return undefined
    }
  }

  // Step 3: Validate requiredOrder if specified.
  let order: string[]
  if (options.requiredOrder !== undefined && options.requiredOrder.length > 0) {
    if (!isPermutation(options.requiredOrder, requiredRoles)) {
      return undefined
    }
    order = [...options.requiredOrder]
  } else {
    order = [...requiredRoles]
  }

  // Step 4 & 5: Build task specs with dependencies.
  const hasOrder = options.requiredOrder !== undefined && options.requiredOrder.length > 0
  const specs: GovernanceTaskSpec[] = []

  for (let i = 0; i < order.length; i++) {
    const role = order[i]
    if (role === undefined) continue

    const spec: GovernanceTaskSpec = {
      title: `${role}: ${goal}`,
      description: `Role "${role}" is assigned to work on: ${goal}`,
      assignee: role,
    }

    // If there is a required order, each task depends on the previous one.
    if (hasOrder && i > 0) {
      const prevRole = order[i - 1]
      if (prevRole !== undefined) {
        spec.dependsOn = [prevRole]
        // When ordered, each agent should only see the output of its dependencies,
        // not the full context - this enforces sequential independence.
        spec.memoryScope = 'dependencies'
      }
    }

    specs.push(spec)
  }

  return specs
}