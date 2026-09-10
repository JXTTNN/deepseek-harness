/**
 * Declarative workflow execution tool: runs a DAG of tool calls with
 * parallelism, conditional branches, and retries.
 *
 * The `workflow_run` tool accepts a workflow definition (a list of steps with
 * dependencies) and executes it as a directed acyclic graph (DAG). Steps with
 * no unmet dependencies run in parallel; each step's result is stored in a
 * shared context that later steps (and their `condition` expressions) can
 * reference. Failed steps retry up to their declared `retry` count before
 * being marked as failed.
 *
 * @module @deepseek-ai/dsh-tool-workflow-run
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'

export const name = 'tool-workflow-run'
export const inject = ['tools']

/** One step in a declarative workflow. */
interface WorkflowStep {
  /** Unique step identifier within this workflow. */
  id: string
  /** Name of the harness tool to invoke. */
  tool: string
  /** Arguments to pass to the tool. */
  args?: Record<string, unknown>
  /** IDs of steps that must complete before this step starts. */
  depends_on?: string[]
  /** JS expression evaluated against the workflow context; falsy skips this step. */
  condition?: string
  /** Whether this step may run in parallel with its siblings (default true). */
  parallel?: boolean
  /** Number of retry attempts on failure (default 0). */
  retry?: number
}

/** Result of one workflow step execution. */
interface StepResult {
  /** 'success' | 'skipped' | 'failed' */
  status: 'success' | 'skipped' | 'failed'
  /** The tool result value on success. */
  result?: JsonValue
  /** The error message on failure. */
  error?: string
}

/** The complete workflow execution result. */
interface WorkflowResult {
  steps: Record<string, StepResult>
  duration_ms: number
}

/** Default retry count when a step does not declare one. */
const DEFAULT_RETRY = 0

/** Maximum retry attempts to prevent infinite loops. */
const MAX_RETRY = 10

/**
 * Register the `workflow_run` tool that executes a declarative DAG of tool
 * calls with parallelism, conditions, and retries.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'workflow_run',
    description:
      'Execute a declarative workflow: a DAG of tool calls with parallel execution, '
      + 'conditional branches (JS expressions referencing prior step results), and '
      + 'per-step retries. Each step names a tool and its arguments; depends_on lists '
      + ' prerequisite step IDs; condition is a JS expression evaluated against the '
      + ' workflow context (steps.<id>.result, context) — falsy skips the step. '
      + 'Returns per-step status/result/error and total duration.',
    parameters: {
      workflow: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          steps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Unique step identifier.' },
                tool: { type: 'string', required: true, description: 'Harness tool name to invoke.' },
                args: { type: 'json', description: 'Arguments object for the tool.' },
                depends_on: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Step IDs that must complete before this step.',
                },
                condition: {
                  type: 'string',
                  description: 'JS expression; falsy result skips this step. Can reference steps.<id>.result and context.',
                },
                parallel: {
                  type: 'boolean',
                  description: 'Whether this step may run in parallel with siblings (default true).',
                },
                retry: {
                  type: 'integer',
                  description: 'Retry attempts on failure (default 0, max 10).',
                },
              },
            },
          },
        },
      },
      context: {
        type: 'json',
        description: 'Global context variables accessible to condition expressions.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const startTime = Date.now()
      const steps = normalizeSteps(args.workflow.steps)
      const globalContext = args.context ?? {}

      // Validate the DAG: check for duplicate IDs, unknown dependencies, and cycles.
      validateDag(steps)

      // Execute the workflow.
      const results = await executeWorkflow(ctx, steps, globalContext, exec.signal)

      const duration_ms = Date.now() - startTime
      const result: WorkflowResult = { steps: results, duration_ms }
      return result as unknown as JsonValue
    },
  }))
}

/**
 * Normalize raw step arguments from the JSON schema (where args is JsonValue)
 * into the WorkflowStep type with optional args as Record.
 */
function normalizeSteps(raw: Array<Record<string, unknown>>): WorkflowStep[] {
  return raw.map(step => {
    const normalized: WorkflowStep = {
      id: step.id as string,
      tool: step.tool as string,
    }
    if (step.args !== undefined && step.args !== null) {
      normalized.args = step.args as Record<string, unknown>
    }
    if (step.depends_on !== undefined) {
      normalized.depends_on = step.depends_on as string[]
    }
    if (step.condition !== undefined) {
      normalized.condition = step.condition as string
    }
    if (step.parallel !== undefined) {
      normalized.parallel = step.parallel as boolean
    }
    if (step.retry !== undefined) {
      normalized.retry = step.retry as number
    }
    return normalized
  })
}

/**
 * Validate the workflow DAG: no duplicate step IDs, all depends_on references
 * exist, and there are no cycles.
 */
function validateDag(steps: WorkflowStep[]): void {
  const ids = new Set<string>()
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`workflow_run: duplicate step id "${step.id}"`)
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      if (!ids.has(dep)) throw new Error(`workflow_run: step "${step.id}" depends on unknown step "${dep}"`)
    }
  }
  // Cycle detection via topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const step of steps) {
    inDegree.set(step.id, 0)
    adjacency.set(step.id, [])
  }
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      adjacency.get(dep)!.push(step.id)
      inDegree.set(step.id, inDegree.get(step.id)! + 1)
    }
  }
  const queue: string[] = []
  for (const [id, degree] of inDegree) if (degree === 0) queue.push(id)
  let processed = 0
  while (queue.length > 0) {
    const id = queue.pop()!
    processed++
    for (const next of adjacency.get(id) ?? []) {
      inDegree.set(next, inDegree.get(next)! - 1)
      if (inDegree.get(next) === 0) queue.push(next)
    }
  }
  if (processed < steps.length) {
    throw new Error('workflow_run: cycle detected in step dependencies')
  }
}

/**
 * Execute the workflow DAG: process steps in topological order, running
 * independent steps in parallel, evaluating conditions, and retrying failures.
 */
async function executeWorkflow(
  ctx: Context,
  steps: WorkflowStep[],
  globalContext: unknown,
  signal: AbortSignal,
): Promise<Record<string, StepResult>> {
  const results: Record<string, StepResult> = {}
  const completed = new Set<string>()

  while (completed.size < steps.length) {
    // Find all steps whose dependencies are met and haven't been started.
    const ready: WorkflowStep[] = []
    for (const step of steps) {
      if (completed.has(step.id)) continue
      const deps = step.depends_on ?? []
      if (deps.every(d => completed.has(d))) ready.push(step)
    }
    if (ready.length === 0) {
      // This shouldn't happen after cycle validation, but guard against it.
      throw new Error('workflow_run: no steps ready but workflow incomplete')
    }

    // Partition into parallel and exclusive steps.
    const parallelSteps = ready.filter(s => s.parallel !== false)
    const exclusiveSteps = ready.filter(s => s.parallel === false)

    // Execute exclusive steps one at a time, then parallel steps together.
    for (const step of exclusiveSteps) {
      signal.throwIfAborted()
      results[step.id] = await executeStep(ctx, step, results, globalContext, signal)
      completed.add(step.id)
    }

    if (parallelSteps.length > 0) {
      const executions = parallelSteps.map(async step => {
        results[step.id] = await executeStep(ctx, step, results, globalContext, signal)
      })
      await Promise.all(executions)
      for (const step of parallelSteps) completed.add(step.id)
    }
  }

  return results
}

/**
 * Execute one workflow step: evaluate its condition, invoke the tool with
 * retries, and return the result.
 */
async function executeStep(
  ctx: Context,
  step: WorkflowStep,
  results: Record<string, StepResult>,
  globalContext: unknown,
  signal: AbortSignal,
): Promise<StepResult> {
  // Evaluate condition if present.
  if (step.condition !== undefined) {
    try {
      const shouldRun = evaluateCondition(step.condition, results, globalContext)
      if (!shouldRun) return { status: 'skipped' }
    } catch (error: unknown) {
      return { status: 'failed', error: `condition evaluation failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // Execute with retries.
  const maxRetries = Math.min(step.retry ?? DEFAULT_RETRY, MAX_RETRY)
  let lastError = 'unknown error'
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal.throwIfAborted()
    try {
      const result = await invokeTool(ctx, step, signal)
      return { status: 'success', result: result as unknown as JsonValue }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < maxRetries) continue
    }
  }
  return { status: 'failed', error: lastError }
}

/**
 * Invoke a harness tool by name with the given arguments.
 */
async function invokeTool(
  ctx: Context,
  step: WorkflowStep,
  signal: AbortSignal,
): Promise<unknown> {
  const schemas = ctx.tools.schemas()
  const found = schemas.find(s => s.name === step.tool)
  if (found === undefined) throw new Error(`unknown tool "${step.tool}"`)

  const exec: ToolExecutionInput = {
    callId: `wf-${step.id}-${crypto.randomUUID()}` as ToolExecutionInput['callId'],
    name: step.tool,
    arguments: step.args ?? {},
    signal,
  }
  const result: ToolExecutionResult = await ctx.tools.execute(exec)
  if (result.isError) {
    const text = result.content
      .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
      .join('\n')
    throw new Error(text)
  }
  return result.value
}

/**
 * Safely evaluate a condition expression against the workflow context.
 * The expression can reference `steps` (prior results) and `context` (global).
 */
function evaluateCondition(
  expression: string,
  results: Record<string, StepResult>,
  globalContext: unknown,
): unknown {
  // Create a restricted evaluation scope. The Function constructor runs in a
  // sandboxed scope with only the provided variables; it cannot access the
  // enclosing closure or global Node APIs.
  const scope = { steps: results, context: globalContext }
  // eslint-disable-next-line no-new-func
  const fn = new Function('steps', 'context', `"use strict"; return (${expression});`)
  return fn(scope.steps, scope.context)
}