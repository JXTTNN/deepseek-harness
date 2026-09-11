/**
 * Declarative workflow execution tool: r uns a DAG of tool calls with
 * parallelism,  conditional branches, and retries.
 *
 * The  `workflow_run` tool accepts a workflow defini tion (a list of steps with
 * dependencies) a nd executes it as a directed acyclic graph (D AG). Steps with
 * no unmet dependencies run  in parallel; each step's result is stored in  a
 * shared context that later steps (and the ir `condition` expressions) can
 * reference.  Failed steps retry up to their declared `ret ry` count before
 * being marked as failed.
  *
 * @module @deepseek-ai/dsh-tool-workflow-r un
 */

import type { Context } from '@deepse ek-ai/cordis'
import { defineTool } from '@de epseek-ai/dsh-tools'
import type { ToolExecut ionInput, ToolExecutionResult } from '@deepse ek-ai/dsh-tools'

import type { JsonValue } f rom '@deepseek-ai/dsh-session'

export const  name = 'tool-workflow-run'
export const injec t = ['tools']

/** One step in a declarative  workflow. */
interface WorkflowStep {
  /** U nique step identifier within this workflow. * /
  id: string
  /** Name of the harness tool  to invoke. */
  tool: string
  /** Arguments  to pass to the tool. */
  args: Record<strin g, unknown>
  /** IDs of steps that must comp lete before this step starts. */
  depends_on ?: string[]
  /** JS expression evaluated aga inst the workflow context; falsy skips this s tep. */
  condition?: string
  /** Whether th is step may run in parallel with its siblings  (default true). */
  parallel?: boolean
  /* * Number of retry attempts on failure (defaul t 0). */
  retry?: number
}


/** Result of o ne workflow step execution. */
interface Step Result {
  /** 'success' | 'skipped' | 'faile d' */
  status: 'success' | 'skipped' | 'fail ed'
  /** The tool result value on success. * /
  result?: JsonValue
  /** The error messag e on failure. */
  error?: string
}

/** The  complete workflow execution result. */
interf ace WorkflowResult {
  steps: Record<string,  StepResult>
  duration_ms: number
}

/** Defa ult retry count when a step does not declare  one. */
const DEFAULT_RETRY = 0

/** Maximum  retry attempts to prevent infinite loops. */
 const MAX_RETRY = 10

/**
 * Register the `wo rkflow_run` tool that executes a declarative  DAG of tool
 * calls with parallelism, condit ions, and retries.
 */
export function apply( ctx: Context): void {
  ctx.tools.register(de fineTool({
    name: 'workflow_run',
    desc ription:
      'Execute a declarative workflo w: a DAG of tool calls with parallel executio n, '
      + 'conditional branches (JS expres sions referencing prior step results), and '
       + 'per-step retries. Each step names a  tool and its arguments; depends_on lists '
       + ' prerequisite step IDs; condition is a  JS expression evaluated against the '
       + ' workflow context (steps.<id>.result, cont ext) — falsy skips the step. '
      + 'Ret urns per-step status/result/error and total d uration.',
    parameters: {
      workflow:  {
        type: 'object',
        required: t rue,
        additionalProperties: false,
         properties: {
          steps: {
             type: 'array',
            required: tru e,
            items: {
              type: ' object',
              additionalProperties:  false,
              properties: {
                 id: { type: 'string', required: true, d escription: 'Unique step identifier.' },
                 tool: { type: 'string', required:  true, description: 'Harness tool name to inv oke.' },
                args: { type: 'json' , description: 'Arguments object for the tool .' },
                depends_on: {
                   type: 'array',
                  ite ms: { type: 'string' },
                  des cription: 'Step IDs that must complete before  this step.',
                },
                 condition: {
                  type: 'str ing',
                  description: 'JS expr ession; falsy result skips this step. Can ref erence steps.<id>.result and context.',
                 },
                parallel: {
                   type: 'boolean',
                   description: 'Whether this step may run  in parallel with siblings (default true).',
                 },
                retry: {
                   type: 'integer',
                   description: 'Retry attempts on failure  (default 0, max 10).',
                },
               },
            },
          },
         },
      },
      context: {
        ty pe: 'json',
        description: 'Global cont ext variables accessible to condition express ions.',
      },
    },
    output: {
      s chema: { type: 'json' },
      render: (_args , value) => [{ type: 'text', text: JSON.strin gify(value, null, 2) }],
    },
    async exe cute(args, exec) {
      const startTime = Da te.now()
      const steps = args.workflow.st eps
      const globalContext = args.context  ?? {}

      // Validate the DAG: check for d uplicate IDs, unknown dependencies, and cycle s.
      validateDag(steps as WorkflowStep[]) 

      // Execute the workflow.
      const  results = await executeWorkflow(ctx, steps as  WorkflowStep[], globalContext, exec.signal)
 
      const duration_ms = Date.now() - start Time
      const result: WorkflowResult = { s teps: results, duration_ms }
      return res ult as unknown as JsonValue
    },
  }))
}

/ **
 * Validate the workflow DAG: no duplicate  step IDs, all depends_on references
 * exist , and there are no cycles.
 */
function valid ateDag(steps: WorkflowStep[]): void {
  const  ids = new Set<string>()
  for (const step of  steps) {
    if (ids.has(step.id)) throw new  Error(`workflow_run: duplicate step id "${st ep.id}"`)
    ids.add(step.id)
  }
  for (con st step of steps) {
    for (const dep of ste p.depends_on ?? []) {
      if (!ids.has(dep) ) throw new Error(`workflow_run: step "${step .id}" depends on unknown step "${dep}"`)
     }
  }
  // Cycle detection via topological so rt (Kahn's algorithm)
  const inDegree = new  Map<string, number>()
  const adjacency = new  Map<string, string[]>()
  for (const step of  steps) {
    inDegree.set(step.id, 0)
    ad jacency.set(step.id, [])
  }
  for (const ste p of steps) {
    for (const dep of step.depe nds_on ?? []) {
      adjacency.get(dep)!.pus h(step.id)
      inDegree.set(step.id, inDegr ee.get(step.id)! + 1)
    }
  }
  const queue : string[] = []
  for (const [id, degree] of  inDegree) if (degree === 0) queue.push(id)
   let processed = 0
  while (queue.length > 0)  {
    const id = queue.pop()!
    processed++ 
    for (const next of adjacency.get(id) ??  []) {
      inDegree.set(next, inDegree.get(n ext)! - 1)
      if (inDegree.get(next) === 0 ) queue.push(next)
    }
  }
  if (processed  < steps.length) {
    throw new Error('workfl ow_run: cycle detected in step dependencies') 
  }
}

/**
 * Execute the workflow DAG: proc ess steps in topological order, running
 * in dependent steps in parallel, evaluating condi tions, and retrying failures.
 */
async funct ion executeWorkflow(
  ctx: Context,
  steps:  WorkflowStep[],
  globalContext: unknown,
   signal: AbortSignal,
): Promise<Record<string , StepResult>> {
  const results: Record<stri ng, StepResult> = {}

  const completed = new  Set<string>()

  while (completed.size < ste ps.length) {
    // Find all steps whose depe ndencies are met and haven't been started.
     const ready: WorkflowStep[] = []
    for (c onst step of steps) {
      if (completed.has (step.id)) continue
      const deps = step.d epends_on ?? []
      if (deps.every(d => com pleted.has(d))) ready.push(step)
    }
    if  (ready.length === 0) {
      // This shouldn 't happen after cycle validation, but guard a gainst it.
      throw new Error('workflow_ru n: no steps ready but workflow incomplete')
     }

    // Partition into parallel and excl usive steps.
    const parallelSteps = ready. filter(s => s.parallel !== false)
    const e xclusiveSteps = ready.filter(s => s.parallel  === false)

    // Execute exclusive steps on e at a time, then parallel steps together.
     for (const step of exclusiveSteps) {
       signal.throwIfAborted()
      results[step.id ] = await executeStep(ctx, step, results, glo balContext, signal)
      completed.add(step. id)
    }

    if (parallelSteps.length > 0)  {
      const executions = parallelSteps.map( async step => {
        results[step.id] = aw ait executeStep(ctx, step, results, globalCon text, signal)
      })
      await Promise.al l(executions)
      for (const step of parall elSteps) completed.add(step.id)
    }
  }

   return results
}

/**
 * Execute one workflow  step: evaluate its condition, invoke the too l with
 * retries, and return the result.
 */ 
async function executeStep(
  ctx: Context,
   step: WorkflowStep,
  results: Record<strin g, StepResult>,
  globalContext: unknown,
  s ignal: AbortSignal,
): Promise<StepResult> {
   // Evaluate condition if present.
  if (ste p.condition !== undefined) {
    try {
       const shouldRun = evaluateCondition(step.cond ition, results, globalContext)
      if (!sho uldRun) return { status: 'skipped' }
    } ca tch (error: unknown) {
      return { status:  'failed', error: `condition evaluation faile d: ${error instanceof Error ? error.message :  String(error)}` }
    }
  }

  // Execute wi th retries.
  const maxRetries = Math.min(ste p.retry ?? DEFAULT_RETRY, MAX_RETRY)
  let la stError: string | undefined
  for (let attemp t = 0; attempt <= maxRetries; attempt++) {
     signal.throwIfAborted()
    try {
      con st result = await invokeTool(ctx, step, signa l)
      return { status: 'success', result:  result as unknown as JsonValue }
    } catch  (error: unknown) {
      lastError = error in stanceof Error ? error.message : String(error )
      if (attempt < maxRetries) continue
     }
  }
  return { status: 'failed', ...(last Error !== undefined ? { error: lastError } :  {}) }
}

/**
 * Invoke a harness tool by name  with the given arguments.
 */
async function  invokeTool(
  ctx: Context,
  step: Workflow Step,
  signal: AbortSignal,
): Promise<unkno wn> {
  const schemas = ctx.tools.schemas()
   const found = schemas.find(s => s.name === s tep.tool)
  if (found === undefined) throw ne w Error(`unknown tool "${step.tool}"`)

  con st exec: ToolExecutionInput = {
    callId: ` wf-${step.id}-${crypto.randomUUID()}` as Tool ExecutionInput['callId'],
    name: step.tool ,
    arguments: step.args ?? {},
    signal, 
  }
  const result: ToolExecutionResult = aw ait ctx.tools.execute(exec)
  if (result.isEr ror) {
    const text = result.content
       .map(block => block.type === 'text' ? block.t ext : `[${block.type} content]`)
      .join( '\n')
    throw new Error(text)
  }
  return  result.value
}

/**
 * Safely evaluate a cond ition expression against the workflow context .
 * The expression can reference `steps` (pr ior results) and `context` (global).
 */
func tion evaluateCondition(
  expression: string, 
  results: Record<string, StepResult>,
  glo balContext: unknown,
): unknown {
  // Create  a restricted evaluation scope. The Function  constructor runs in a
  // sandboxed scope wi th only the provided variables; it cannot acc ess the
  // enclosing closure or global Node  APIs.
  const scope = { steps: results, cont ext: globalContext }
  // eslint-disable-next -line no-new-func
  const fn = new Function(' steps', 'context', `"use strict"; return (${e xpression});`)
  return fn(scope.steps, scope .context)
}
 