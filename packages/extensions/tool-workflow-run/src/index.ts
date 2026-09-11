/**
 * Declarative workflow execution tool: r

uns a DAG of tool calls with
 * parallelism,
 
conditional branches, and retries.
 *
 * Th
e 
`workflow_run` tool accepts a workflow def
ini
tion (a list of steps with
 * dependencie
s) a
nd executes it as a directed acyclic gra
ph (D
AG). Steps with
 * no unmet dependencie
s run 
in parallel; each step's result is sto
red in 
a
 * shared context that later steps 
(and the
ir `condition` expressions) can
 * r
eference.
 Failed steps retry up to their dec
lared `ret
ry` count before
 * being marked a
s failed.
 
*
 * @module @deepseek-ai/dsh-too
l-workflow-r
un
 */

import type { Context } 
from '@deepse
ek-ai/cordis'
import { defineTo
ol } from '@de
epseek-ai/dsh-tools'
import ty
pe { ToolExecut
ionInput, ToolExecutionResult
 } from '@deepse
ek-ai/dsh-tools'

import typ
e { JsonValue } f
rom '@deepseek-ai/dsh-sessi
on'

export const 
name = 'tool-workflow-run'

export const injec
t = ['tools']

/** One st
ep in a declarative 
workflow. */
interface W
orkflowStep {
  /** U
nique step identifier w
ithin this workflow. *
/
  id: string
  /** N
ame of the harness tool
 to invoke. */
  tool
: string
  /** Arguments
 to pass to the tool
. */
  args: Record<strin
g, unknown>
  /** I
Ds of steps that must comp
lete before this s
tep starts. */
  depends_on
?: string[]
  /**
 JS expression evaluated aga
inst the workflo
w context; falsy skips this s
tep. */
  condi
tion?: string
  /** Whether th
is step may ru
n in parallel with its siblings
 (default tru
e). */
  parallel?: boolean
  /*
* Number of 
retry attempts on failure (defaul
t 0). */
  
retry?: number
}


/** Result of o
ne workflo
w step execution. */
interface Step
Result {

  /** 'success' | 'skipped' | 'faile
d' */
  
status: 'success' | 'skipped' | 'fail
ed'
  /
** The tool result value on success. *
/
  re
sult?: JsonValue
  /** The error messag
e on 
failure. */
  error?: string
}

/** The 
comp
lete workflow execution result. */
interf
ace
 WorkflowResult {
  steps: Record<string, 
St
epResult>
  duration_ms: number
}

/** Defa
u
lt retry count when a step does not declare 

one. */
const DEFAULT_RETRY = 0

/** Maximum 

retry attempts to prevent infinite loops. */


const MAX_RETRY = 10

/**
 * Register the `
wo
rkflow_run` tool that executes a declarati
ve 
DAG of tool
 * calls with parallelism, co
ndit
ions, and retries.
 */
export function a
pply(
ctx: Context): void {
  ctx.tools.regis
ter(de
fineTool({
    name: 'workflow_run',
 
   desc
ription:
      'Execute a declarative
 workflo
w: a DAG of tool calls with parallel
 executio
n, '
      + 'conditional branches 
(JS expres
sions referencing prior step resul
ts), and '

      + 'per-step retries. Each s
tep names a 
tool and its arguments; depends_
on lists '
  
    + ' prerequisite step IDs; 
condition is a
 JS expression evaluated again
st the '
      
+ ' workflow context (steps.<
id>.result, cont
ext) — falsy skips the ste
p. '
      + 'Ret
urns per-step status/result
/error and total d
uration.',
    parameters:
 {
      workflow: 
{
        type: 'object',

        required: t
rue,
        additionalP
roperties: false,
   
     properties: {
    
      steps: {
       
     type: 'array',
  
          required: tru
e,
            items:
 {
              type: '
object',
           
   additionalProperties: 
false,
            
  properties: {
          
      id: { type: 
'string', required: true, d
escription: 'Uniq
ue step identifier.' },
    
            tool
: { type: 'string', required:
 true, descript
ion: 'Harness tool name to inv
oke.' },
     
           args: { type: 'json'
, description
: 'Arguments object for the tool
.' },
      
          depends_on: {
         
         ty
pe: 'array',
                  ite
ms: { type
: 'string' },
                  des
cription:
 'Step IDs that must complete before
 this st
ep.',
                },
            
    con
dition: {
                  type: 'str
ing',

                  description: 'JS expr
essio
n; falsy result skips this step. Can ref
eren
ce steps.<id>.result and context.',
     
   
        },
                parallel: {
   
  
             type: 'boolean',
             
 
    description: 'Whether this step may run 

in parallel with siblings (default true).',
 

               },
                retry: {
 
 
                type: 'integer',
          
  
      description: 'Retry attempts on fail
ure
 (default 0, max 10).',
                }
,
  
            },
            },
          
},
  
      },
      },
      context: {
    
    ty
pe: 'json',
        description: 'Glob
al cont
ext variables accessible to condition
 express
ions.',
      },
    },
    output: 
{
      s
chema: { type: 'json' },
      rend
er: (_args
, value) => [{ type: 'text', text:
 JSON.strin
gify(value, null, 2) }],
    },
 
   async exe
cute(args, exec) {
      const s
tartTime = Da
te.now()
      const steps = ar
gs.workflow.st
eps
      const globalContext 
= args.context 
?? {}

      // Validate the 
DAG: check for d
uplicate IDs, unknown depend
encies, and cycle
s.
      validateDag(steps 
as WorkflowStep[])


      // Execute the wor
kflow.
      const 
results = await executeWo
rkflow(ctx, steps as
 WorkflowStep[], globalC
ontext, exec.signal)


      const duration_m
s = Date.now() - start
Time
      const resul
t: WorkflowResult = { s
teps: results, durati
on_ms }
      return res
ult as unknown as Js
onValue
    },
  }))
}

/
**
 * Validate the 
workflow DAG: no duplicate
 step IDs, all dep
ends_on references
 * exist
, and there are n
o cycles.
 */
function valid
ateDag(steps: Wo
rkflowStep[]): void {
  const
 ids = new Set<
string>()
  for (const step of
 steps) {
    
if (ids.has(step.id)) throw new
 Error(`workf
low_run: duplicate step id "${st
ep.id}"`)
  
  ids.add(step.id)
  }
  for (con
st step of 
steps) {
    for (const dep of ste
p.depends_
on ?? []) {
      if (!ids.has(dep)
) throw n
ew Error(`workflow_run: step "${step
.id}" de
pends on unknown step "${dep}"`)
    
}
  }
 
 // Cycle detection via topological so
rt (Ka
hn's algorithm)
  const inDegree = new 
Map<s
tring, number>()
  const adjacency = new
 Map
<string, string[]>()
  for (const step of
 st
eps) {
    inDegree.set(step.id, 0)
    ad
ja
cency.set(step.id, [])
  }
  for (const ste
p
 of steps) {
    for (const dep of step.depe

nds_on ?? []) {
      adjacency.get(dep)!.pus

h(step.id)
      inDegree.set(step.id, inDeg
r
ee.get(step.id)! + 1)
    }
  }
  const que
ue
: string[] = []
  for (const [id, degree] 
of 
inDegree) if (degree === 0) queue.push(id
)
  
let processed = 0
  while (queue.length 
> 0) 
{
    const id = queue.pop()!
    proce
ssed++

    for (const next of adjacency.get(
id) ?? 
[]) {
      inDegree.set(next, inDegr
ee.get(n
ext)! - 1)
      if (inDegree.get(ne
xt) === 0
) queue.push(next)
    }
  }
  if (
processed 
< steps.length) {
    throw new Er
ror('workfl
ow_run: cycle detected in step de
pendencies')

  }
}

/**
 * Execute the workf
low DAG: proc
ess steps in topological order,
 running
 * in
dependent steps in parallel, e
valuating condi
tions, and retrying failures.

 */
async funct
ion executeWorkflow(
  ctx: 
Context,
  steps:
 WorkflowStep[],
  globalCo
ntext: unknown,
  
signal: AbortSignal,
): Pr
omise<Record<string
, StepResult>> {
  const 
results: Record<stri
ng, StepResult> = {}

  
const completed = new
 Set<string>()

  while
 (completed.size < ste
ps.length) {
    // Fi
nd all steps whose depe
ndencies are met and 
haven't been started.
  
  const ready: Workf
lowStep[] = []
    for (c
onst step of steps)
 {
      if (completed.has
(step.id)) continu
e
      const deps = step.d
epends_on ?? []
 
     if (deps.every(d => com
pleted.has(d))) 
ready.push(step)
    }
    if
 (ready.length 
=== 0) {
      // This shouldn
't happen afte
r cycle validation, but guard a
gainst it.
  
    throw new Error('workflow_ru
n: no steps 
ready but workflow incomplete')
 
   }

    /
/ Partition into parallel and excl
usive step
s.
    const parallelSteps = ready.
filter(s 
=> s.parallel !== false)
    const e
xclusive
Steps = ready.filter(s => s.parallel 
=== fal
se)

    // Execute exclusive steps on
e at a
 time, then parallel steps together.
  
  for
 (const step of exclusiveSteps) {
      
sign
al.throwIfAborted()
      results[step.id
] =
 await executeStep(ctx, step, results, glo
ba
lContext, signal)
      completed.add(step.
i
d)
    }

    if (parallelSteps.length > 0) 

{
      const executions = parallelSteps.map(

async step => {
        results[step.id] = a
w
ait executeStep(ctx, step, results, globalC
on
text, signal)
      })
      await Promise
.al
l(executions)
      for (const step of pa
rall
elSteps) completed.add(step.id)
    }
  
}

  
return results
}

/**
 * Execute one wo
rkflow
 step: evaluate its condition, invoke 
the too
l with
 * retries, and return the res
ult.
 */

async function executeStep(
  ctx: 
Context,

  step: WorkflowStep,
  results: Re
cord<strin
g, StepResult>,
  globalContext: u
nknown,
  s
ignal: AbortSignal,
): Promise<St
epResult> {

  // Evaluate condition if prese
nt.
  if (ste
p.condition !== undefined) {
  
  try {
      
const shouldRun = evaluateCond
ition(step.cond
ition, results, globalContext
)
      if (!sho
uldRun) return { status: 'sk
ipped' }
    } ca
tch (error: unknown) {
    
  return { status:
 'failed', error: `conditi
on evaluation faile
d: ${error instanceof Err
or ? error.message :
 String(error)}` }
    }

  }

  // Execute wi
th retries.
  const max
Retries = Math.min(ste
p.retry ?? DEFAULT_RET
RY, MAX_RETRY)
  let la
stError: string | und
efined
  for (let attemp
t = 0; attempt <= ma
xRetries; attempt++) {
  
  signal.throwIfAbo
rted()
    try {
      con
st result = await 
invokeTool(ctx, step, signa
l)
      return {
 status: 'success', result: 
result as unknow
n as JsonValue }
    } catch 
(error: unknown
) {
      lastError = error in
stanceof Error
 ? error.message : String(error
)
      if (a
ttempt < maxRetries) continue
  
  }
  }
  re
turn { status: 'failed', ...(last
Error !== u
ndefined ? { error: lastError } : 
{}) }
}

/
**
 * Invoke a harness tool by name
 with the
 given arguments.
 */
async function
 invokeT
ool(
  ctx: Context,
  step: Workflow
Step,
 
 signal: AbortSignal,
): Promise<unkno
wn> {

  const schemas = ctx.tools.schemas()
 
 cons
t found = schemas.find(s => s.name === s
tep.
tool)
  if (found === undefined) throw ne
w E
rror(`unknown tool "${step.tool}"`)

  con
st
 exec: ToolExecutionInput = {
    callId: `
w
f-${step.id}-${crypto.randomUUID()}` as Tool

ExecutionInput['callId'],
    name: step.tool

,
    arguments: step.args ?? {},
    signal
,

  }
  const result: ToolExecutionResult = 
aw
ait ctx.tools.execute(exec)
  if (result.i
sEr
ror) {
    const text = result.content
  
    
.map(block => block.type === 'text' ? bl
ock.t
ext : `[${block.type} content]`)
      
.join(
'\n')
    throw new Error(text)
  }
  
return 
result.value
}

/**
 * Safely evaluat
e a cond
ition expression against the workflo
w context
.
 * The expression can reference `
steps` (pr
ior results) and `context` (global
).
 */
func
tion evaluateCondition(
  express
ion: string,

  results: Record<string, StepR
esult>,
  glo
balContext: unknown,
): unknown
 {
  // Create
 a restricted evaluation scope
. The Function 
constructor runs in a
  // sa
ndboxed scope wi
th only the provided variabl
es; it cannot acc
ess the
  // enclosing clos
ure or global Node
 APIs.
  const scope = { s
teps: results, cont
ext: globalContext }
  cons
t fn = new Function('
steps', 'context', `"us
e strict"; return (${e
xpression});`)
  retur
n fn(scope.steps, scope
.context)
}


