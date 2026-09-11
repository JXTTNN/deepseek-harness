/**
 * Generate `docs/tool-catalog.md` from s
chemas collected by booting each tool
 * plug
in. Runtime registration is the source of tru
th for computed schemas;
 * the manifest is c
hecked against every on-disk `tool-*` package
. `--check`
 * verifies the committed artifac
t. Rationale and ownership live in
 * `.agent
s/notes/implemented/process/2026-07-02-tool-s
chema-catalog.md`.
 */

import { globSync, re
adFileSync, writeFileSync } from 'node:fs'
im
port { basename, resolve } from 'node:path'
i
mport { Context } from '@deepseek-ai/cordis'

import type { ToolSchema } from '@deepseek-ai
/dsh-llm'
import AgentRegistry from '@deepsee
k-ai/dsh-agent'
import type { Agent } from '@
deepseek-ai/dsh-agent'
import { createScope }
 from '@deepseek-ai/dsh-scope'
import Session
Store, { SessionId } from '@deepseek-ai/dsh-s
ession'
import SessionProjectionRegistry from
 '@deepseek-ai/dsh-session-projection'
import
 SqliteSessionQueryEngine from '@deepseek-ai/
dsh-session-query-sqlite'
import GoalService 
from '@deepseek-ai/dsh-goal'
import SystemPro
mpt from '@deepseek-ai/dsh-system-prompt'
imp
ort ToolRuntime, { type Config as ToolsConfig
 } from '@deepseek-ai/dsh-tools'
import Local
BashExecutor from '@deepseek-ai/dsh-bash-loca
l'
import * as BashEnvPlugin from '@deepseek-
ai/dsh-shell-env'
import { PwshLocalExecutor 
} from '@deepseek-ai/dsh-pwsh-local'
import L
ocalSubprocessRuntime from '@deepseek-ai/dsh-
subprocess-local'
import LocalFileSystem from
 '@deepseek-ai/dsh-fs-local'
import { Attachm
entStore } from '@deepseek-ai/dsh-attachment'

import type { ImageAttachmentLimits, ImageAt
tachmentRef, SaveImageAttachment, StoredImage
Attachment } from '@deepseek-ai/dsh-attachmen
t'
import UserQuestionService from '@deepseek
-ai/dsh-user-questions'
import PlanModeContro
ller from '@deepseek-ai/dsh-plan-mode'
import
 WebRuntime from '@deepseek-ai/dsh-web'
impor
t * as WebSearchExa from '@deepseek-ai/dsh-we
b-search-exa'
import * as WebFetchLocal from 
'@deepseek-ai/dsh-web-fetch-http'
import Suba
gentRuntime from '@deepseek-ai/dsh-subagent'

import type { SubagentProvider, SubagentRepor
tDelivery } from '@deepseek-ai/dsh-subagent'

import * as ToolSubagentControl from '@deepse
ek-ai/dsh-tool-subagent-control'
import * as 
ToolSubagentListAgents from '@deepseek-ai/dsh
-tool-subagent-control/list-agents'
import * 
as ToolSubagentReport from '@deepseek-ai/dsh-
tool-subagent-report'
import SkillRegistry fr
om '@deepseek-ai/dsh-skill'
import * as Skill
FileSystem from '@deepseek-ai/dsh-skill-files
ystem'
import LocalJobRegistry from '@deepsee
k-ai/dsh-jobs-local'
import * as ToolAskUser 
from '@deepseek-ai/dsh-tool-ask-user'
import 
* as ToolBash from '@deepseek-ai/dsh-tool-bas
h'
import * as ToolPwsh from '@deepseek-ai/ds
h-tool-pwsh'
import * as ToolBashPersistent f
rom '@deepseek-ai/dsh-tool-bash-persistent'
i
mport CordisHostRunner from '@deepseek-ai/dsh
-cordis-host-runner'
import * as ToolCordis f
rom '@deepseek-ai/dsh-tool-cordis'
import * a
s ToolFs from '@deepseek-ai/dsh-tool-fs'
impo
rt * as ToolFsSearch from '@deepseek-ai/dsh-t
ool-fs-search'
import * as ToolStrReplaceEdit
or from '@deepseek-ai/dsh-tool-str-replace-ed
itor'
import TerminalSessionService from '@de
epseek-ai/dsh-terminal'
import * as ToolPty f
rom '@deepseek-ai/dsh-tool-terminal'
import *
 as ToolGoal from '@deepseek-ai/dsh-tool-goal
'
import * as ToolSchedule from '@deepseek-ai
/dsh-schedule'
import Lsp from '@deepseek-ai/
dsh-lsp'
import * as ToolLsp from '@deepseek-
ai/dsh-tool-lsp'
import * as ToolSkill from '
@deepseek-ai/dsh-tool-skill'
import * as Tool
SessionQuery from '@deepseek-ai/dsh-tool-sess
ion-query'
import * as ToolTasks from '@deeps
eek-ai/dsh-tool-jobs'
import * as ToolTodo fr
om '@deepseek-ai/dsh-tool-todo'
import * as T
oolSubagent from '@deepseek-ai/dsh-tool-subag
ent'
import * as ToolWeb from '@deepseek-ai/d
sh-tool-web'
import VmWorkflowEngine from '@d
eepseek-ai/dsh-workflow-worker-thread'
import
 * as ToolRalph from '@deepseek-ai/dsh-tool-r
alph'
import * as ToolWorkflow from '@deepsee
k-ai/dsh-tool-workflow'
import * as ToolGithu
b from '@deepseek-ai/dsh-tool-github'
import 
{ githubSlug } from './verify-md-links.ts'

/
** Attachment seam marker that makes the atta
chments-conditional `read_image` schema harve
stable. */
class CatalogAttachmentStore exten
ds AttachmentStore {
  readonly imageLimits: 
ImageAttachmentLimits = Object.freeze({
    m
axImageBytes: 1,
    maxImagesPerMessage: 1,

    maxMessageImageBytes: 1,
    maxImagePixe
ls: 1,
    mediaTypes: Object.freeze(['image/
png'] as const),
  })

  override validateIma
ge(_input: SaveImageAttachment): Promise<void
> {
    return Promise.reject(new Error('gen-
tool-catalog: attachment validation is unreac
hable during schema harvest'))
  }

  overrid
e saveImage(_input: SaveImageAttachment): Pro
mise<ImageAttachmentRef> {
    return Promise
.reject(new Error('gen-tool-catalog: attachme
nt writes are unreachable during schema harve
st'))
  }

  override readImage(_ref: ImageAt
tachmentRef): Promise<StoredImageAttachment> 
{
    return Promise.reject(new Error('gen-to
ol-catalog: attachment reads are unreachable 
during schema harvest'))
  }
}

const root = 
resolve(import.meta.dirname, '..')
const OUT 
= 'docs/tool-catalog.md'

/**
 * Register the
 descriptor needed to mount schema-producing 
consumers. Declares
 * the full capability se
t of the shipped in-process providers so cons
umers
 * mount under their shipped defaults (
tool-subagent's default numeric maxDepth
 * r
equires `depthLimit`).
 */
function registerC
atalogSubagentProvider(ctx: Context, name: st
ring): void {
  const provider: SubagentProvi
der = {
    name,
    capabilities: { outputS
chema: true, depthLimit: true, toolFilter: tr
ue, persona: true },
    inheritsParentContex
t: false,
    start: () => Promise.reject(new
 Error('tool-catalog provider cannot start a 
child')),
    // Declared so consumers config
ured for continuable background mode mount.
 
   prepareContinuable: () => Promise.reject(n
ew Error('tool-catalog provider cannot prepar
e a child')),
  }
  ctx.subagents.registerPro
vider(provider)
}

/** Minted child-scope key
s for packages whose tools are never global. 
*/
const catalogChildScopes = new WeakMap<Con
text, Agent>()

/**
 * Install one scope-loca
l tool package into an agent-like child scope
 for
 * schema harvest, without starting a mo
del, Agent loop, or persistence backend.
 * @
param ctx - catalog context owning the scope.

 * @param mountScoped - package installer fo
r the scoped context.
 * @param key - agent-l
ike scope key exposed to the package's scope 
selector.
 * @param inject - services the pac
kage installer must await before mounting.
 *
/
async function mountCatalogChildScope(
  ct
x: Context,
  mountScoped: (childCtx: Context
) => void,
  key: Agent = { id: SessionId('to
ol-catalog-child') } as Agent,
  inject: stri
ng[] = ['tools', 'systemPrompt', 'subagents']
,
): Promise<void> {
  await ctx.plugin(Objec
t.assign((inner: Context) => {
    mountScope
d(createScope(inner, key).ctx)
  }, { inject 
}))
  catalogChildScopes.set(ctx, key)
}

/**

 * Tool package plus its hand-maintained boo
t recipe. The caller mounts the
 * prompt and
 registry; each recipe supplies only package-
specific seams and
 * config, while `dir` par
ticipates in the completeness check.
 */
expo
rt interface ToolPackage {
  /** The npm pack
age name, used as the catalog section heading
. */
  pkg: string
  /** The `packages/<group
>/<dir>` leaf name — matched by the complet
eness guard. */
  dir: string
  /**
   * Repo
-relative implementation source linked per ha
rvested tool. Packages
   * whose tools share
 one plugin may use a string; split plugins m
ap each tool
   * name to its own source.
   
*/
  source: string | Readonly<Record<string,
 string>>
  /** Services or owning runtimes t
he package requires at execution time. */
  r
equires: string[]
  /** Session events or oth
er visible state the tools write or affect. *
/
  writes: string[]
  /** Additional model-v
isible names shipped by example/app config. *
/
  shippedNames?: string[]
  /** Plug the in
jected seams + the tool plugin onto a context
 that already
   * carries `systemPrompt` + `
tools`. */
  mount: (ctx: Context) => Promise
<void>
  /** Agent-like scope key whose tool 
view is catalogued instead of the global view
. */
  scope?: (ctx: Context) => Agent
  /**

   * Config for the caller's `ToolRuntime` mo
unt. The registry itself ships a
   * model-f
acing tool (`run_code`, registered under a no
n-native `mode`), so
   * ITS catalog entry b
oots the registry in the mode that exposes it
;
   * every other entry uses the default (na
tive) registry.
   */
  toolsConfig?: ToolsCo
nfig
  /**
   * A deployment note rendered af
ter the package's tools, for a fact that
   *
 booting the package alone cannot show. The r
egistered tool NAME can be a
   * load-time c
onfig (`tool-subagent`'s `toolName`), so one 
package may appear
   * under several names a
cross deployments — the boot yields the pac
kage
   * DEFAULT, and this note records the 
shipped alternatives the model sees.
   */
  
note?: string
}

/**
 * The boot manifest: ev
ery shipped tool package (a `tool-*` leaf und
er
 * `packages/`). Ordered by package name (
the render order); the completeness
 * guard 
proves it is exhaustive against the on-disk g
lob.
 */
const TOOL_PACKAGES: ToolPackage[] =
 [
  {
    pkg: '@deepseek-ai/dsh-tool-ask-us
er',
    dir: 'tool-ask-user',
    source: 'p
ackages/interaction/tool-ask-user/src/index.t
s',
    requires: ['ctx.tools', 'ctx.userQues
tions'],
    writes: ['tool/call', 'tool/resu
lt after a UI/provider answers the question']
,
    async mount(ctx) {
      await ctx.plug
in(UserQuestionService)
      await ctx.plugi
n(ToolAskUser)
    },
    note:
      'ask_us
er_question pauses the tool call until the ac
tive UI provider returns a human answer.',
  
},
  {
    pkg: '@deepseek-ai/dsh-tools',
   
 dir: 'tools',
    source: 'packages/core/too
ls/src/code-mode.ts',
    requires: ['ctx.too
ls', 'ctx.codeRuntime (execution time)', 'ctx
.systemPrompt'],
    writes: ['tool/call', 'o
ne tool/code-dispatch-start + tool/code-dispa
tch pair per bridged sub-call', 'tool/result'
  {
    pkg: '@deepseek-ai/dsh-tool-dependency-graph',
    dir: 'tool-dependency-graph',
    source: 'packages/extensions/tool-dependency-graph/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolDependencyGraph)
    },
    note: 'dependency_graph analyzes project dependency relationships.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-diff-merge',
    dir: 'tool-diff-merge',
    source: 'packages/extensions/tool-diff-merge/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolDiffMerge)
    },
    note: 'diff_merge performs three-way merge of file changes.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-programming-assistant',
    dir: 'tool-programming-assistant',
    source: 'packages/extensions/tool-programming-assistant/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolProgrammingAssistant)
    },
    note: 'programming_assistant provides code generation and refactoring assistance.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-semantic-search',
    dir: 'tool-semantic-search',
    source: 'packages/extensions/tool-semantic-search/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolSemanticSearch)
    },
    note: 'semantic_search performs semantic code search using embeddings.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-test-impact',
    dir: 'tool-test-impact',
    source: 'packages/extensions/tool-test-impact/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolTestImpact)
    },
    note: 'test_impact analyzes which tests are affected by code changes.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-workflow-run',
    dir: 'tool-workflow-run',
    source: 'packages/extensions/tool-workflow-run/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolWorkflowRun)
    },
    note: 'workflow_run executes CI/CD workflow steps and returns results.',
  },
],
    // The registry's OWN tool: run_code e
xists only under a non-native mode
    // (th
e registry registers it in its constructor; t
he code runtime is read
    // at assembly/ex
ecution time, so the schema harvest needs non
e mounted).
    toolsConfig: { mode: 'code' }
,
    async mount() {},
    note:
      'Owne
d by the tool registry as a reserved transpor
t outside filterable capability layers under 
`mode: code` / `mode: both` (see the Code Mod
e Agent Note). Under `code` it is the registr
y\'s only wire contribution; the other visibl
e capabilities are declared in a generated SD
K section in the loaded runtime\'s language, 
and a program calls them through bindings sch
eduled under the native concurrency contract 
(submission-ordered starts and policy; concur
rency-safe bodies overlap up to `maxParallelS
ubCalls`) that re-enter the complete guarded 
tool pipeline and link each nested execution 
to this outer result.',
  },
  {
    pkg: '@d
eepseek-ai/dsh-plan-mode',
    dir: 'plan-mod
e',
    source: 'packages/plan/plan-mode/src/
index.ts',
    requires: ['ctx.tools', 'ctx.s
ystemPrompt', 'ctx.userQuestions (execution t
ime, opportunistic)'],
    writes: ['tool/cal
l', 'plan/mode inactive on an approved review
', 'tool/result'],
    async mount(ctx) {
   
   await ctx.plugin(PlanModeController, { sec
tion: 'Tool catalog schema harvest.' })
    }
,
    note:
      'exit_plan_mode stays in th
e model-facing schema while planning is inact
ive so transitions add no tool-catalog churn 
on top of the plan-policy change. Its execute
 path rejects calls outside plan mode; in pla
n mode it presents the plan over the user-que
stions seam (approve / keep planning with fee
dback), and approval logs plan mode inactive 
at the step boundary.',
  },
  {
    pkg: '@d
eepseek-ai/dsh-tool-bash',
    dir: 'tool-bas
h',
    source: 'packages/shell/tool-bash/src
/index.ts',
    requires: ['ctx.tools', 'ctx.
shell', 'ctx.systemPrompt', 'ctx.shellEnv', '
ctx.jobs at call time for run_in_background']
,
    writes: ['tool/call', 'tool/result'],
 
   async mount(ctx) {
      await ctx.plugin(
LocalSubprocessRuntime)
      await ctx.plugi
n(BashEnvPlugin)
      await ctx.plugin(Local
BashExecutor)
      await ctx.plugin(ToolBash
)
    },
    note:
      'The bash tool is th
e model-facing consumer of the bash executor 
seam. A `run_in_background` run registers wit
h the generic `ctx.jobs` runtime and is colle
cted/stopped through the `job_*` tools from `
@deepseek-ai/dsh-tool-jobs`; the `enableRunIn
Background` config (default true) removes the
 parameter entirely when disabled.',
  },
  {

    pkg: '@deepseek-ai/dsh-tool-pwsh',
    d
ir: 'tool-pwsh',
    source: 'packages/shell/
tool-pwsh/src/index.ts',
    requires: ['ctx.
tools', 'ctx.shell', 'ctx.systemPrompt', 'ctx
.shellEnv', 'ctx.jobs at call time for run_in
_background'],
    writes: ['tool/call', 'too
l/result'],
    async mount(ctx) {
      // T
he pwsh tool consumes the bash executor seam;
 the schema harvest
      // mounts the pwsh-
local implementation so the inject resolves w
ithout
      // executing anything (registrat
ion never spawns a process).
      await ctx.
plugin(LocalSubprocessRuntime)
      await ct
x.plugin(BashEnvPlugin)
      await ctx.plugi
n(PwshLocalExecutor)
      await ctx.plugin(T
oolPwsh)
    },
    note:
      'The pwsh too
l is the PowerShell-dialect consumer of the b
ash executor seam for Windows compositions (a
 PowerShell executor such as `@deepseek-ai/ds
h-pwsh-local` backs `ctx.shell`); it mirrors 
the bash tool call-for-call minus sandbox con
trols — `run_in_background` runs register w
ith the generic `ctx.jobs` runtime and are co
llected/stopped through the `job_*` tools, an
d the managed `DSH_*` environment comes from 
`@deepseek-ai/dsh-shell-env`. Each call runs 
in a fresh process (no persistent PTY session
), with native `C:\\...` paths and `$env:NAME
` variables.',
  },
  {
    pkg: '@deepseek-a
i/dsh-tool-cordis',
    dir: 'tool-cordis',
 
   source: 'packages/extensions/tool-cordis/s
rc/index.ts',
    requires: ['ctx.tools', 'ct
x.dynamicCordisRunner'],
    writes: ['tool/c
all', 'tool/result', 'process-local dynamic p
ackage lifecycle'],
    async mount(ctx) {
  
    await ctx.plugin(CordisHostRunner)
      
await ctx.plugin(ToolCordis)
    },
    note:

      'Not in any shipped tree (a deliberate
 opt-in — dynamic package code reaches the 
real runtime, see .agents/notes/implemented/f
eature/2026-07-08-self-referential-cordis-too
lset.md). The toolset injects `ctx.dynamicCor
disRunner` from `@deepseek-ai/dsh-cordis-host
-runner`, which owns the definition registry 
and the vm sandbox; a composition missing it 
never activates the tools. A running package 
may register ADDITIONAL model-visible tools u
ntil it is stopped, undefined, or DSH restart
s; a full changed request header logs those t
ool-set changes.',
  },
  {
    pkg: '@deepse
ek-ai/dsh-tool-bash-persistent',
    dir: 'to
ol-bash-persistent',
    source: 'packages/sh
ell/tool-bash-persistent/src/index.ts',
    r
equires: ['ctx.tools', 'ctx.terminals', 'an o
wning Agent at execution time'],
    writes: 
['tool/call', 'PTY shell state', 'tool/result
'],
    async mount(ctx) {
      await ctx.pl
ugin(TerminalSessionService)
      await ctx.
plugin(ToolBashPersistent)
    },
    note:
 
     'One owner-isolated persistent bash tool
; deployment composition supplies the PTY bac
kend and may override the model-facing enviro
nment description.',
  },
  {
    pkg: '@deep
seek-ai/dsh-tool-str-replace-editor',
    dir
: 'tool-str-replace-editor',
    source: 'pac
kages/fs/tool-str-replace-editor/src/index.ts
',
    requires: ['ctx.tools', 'ctx.fs'],
   
 writes: ['tool/call', 'fs/observed after vie
w presence/absence, edit absence, or successf
ul mutation', 'tool/result'],
    async mount
(ctx) {
      await ctx.plugin(LocalFileSyste
m)
      await ctx.plugin(ToolStrReplaceEdito
r)
    },
    note:
      'Standalone view/cr
eate/unique literal replace/line insert tool 
over the filesystem seam; it composes with an
y shell or terminal API.',
  },
  {
    pkg: 
'@deepseek-ai/dsh-tool-fs',
    dir: 'tool-fs
',
    source: 'packages/fs/tool-fs/src/index
.ts',
    requires: ['ctx.tools', 'ctx.fs', '
ctx.systemPrompt', 'ctx.attachments (read_ima
ge registration)', 'ctx.llm + an image-capabl
e route (read_image execution)'],
    writes:
 ['tool/call', 'fs/write-intent or fs/edit-in
tent for mutations', 'fs/observed after read 
presence/absence or successful file operation
', 'durable attachment (read_image)', 'tool/r
esult'],
    async mount(ctx) {
      // The 
tool needs `fs`; the bare provider is suffici
ent because policy
      // changes behavior,
 not schema shape. The catalog seam marker op
ts into
      // the attachments-conditional 
read_image schema without attachment I/O.
   
   await ctx.plugin(LocalFileSystem)
      aw
ait ctx.plugin(CatalogAttachmentStore)
      
await ctx.plugin(ToolFs)
    },
    note:
   
   'The read-before-write/edit policy is adde
d by `@deepseek-ai/dsh-fs-observation-policy`
 (an `fs/*` event-gate plugin, no schema chan
ge); a deployment that loads these tools is e
xpected to also load it. `read_image` is not 
registered without `ctx.attachments`; its sch
ema is route-independent, and execution refus
es unless the exact routed model declares ima
ge input.',
  },
  {
    pkg: '@deepseek-ai/d
sh-tool-fs-search',
    dir: 'tool-fs-search'
,
    source: 'packages/fs/tool-fs-search/src
/index.ts',
    requires: ['ctx.tools', 'ctx.
subprocess', 'ctx.systemPrompt'],
    writes:
 ['tool/call', 'tool/result'],
    async moun
t(ctx) {
      // The tools inject `subproces
s` (search spawns the packaged ripgrep
      
// binary through the seam, not ctx.fs); regi
stration itself never
      // spawns, so the
 real local service is inert here. `ctx.spill
Store` is
      // optional (read via ctx.get
) and does not affect the schemas, so no
    
  // spill backend is mounted.
      await ct
x.plugin(LocalSubprocessRuntime)
      await 
ctx.plugin(ToolFsSearch, { sampleOverCapGlobR
esults: true })
    },
    note:
      'glob 
and grep are unconditional discovery tools th
at spawn the packaged ripgrep binary (`@vscod
e/ripgrep`) through ctx.subprocess as ordinar
y foreground calls (never background jobs) �
� no host `rg` install and no shell layer. Th
e catalog uses `sampleOverCapGlobResults: tru
e`; deployments must choose that behavior exp
licitly. Capped results save the complete for
matted list through the optional ctx.spillSto
re backend; returned locators are follow-up-r
eadable/searchable when the backend exposes l
ocal paths in co-located deployments.',
  },

  {
    pkg: '@deepseek-ai/dsh-tool-terminal'
,
    dir: 'tool-terminal',
    source: 'pack
ages/terminal/tool-terminal/src/index.ts',
  
  requires: ['ctx.tools', 'ctx.terminals', 'c
tx.systemPrompt', 'ctx.jobs at call time for 
run_in_background'],
    writes: ['tool/call'
, 'tool/result'],
    async mount(ctx) {
    
  await ctx.plugin(TerminalSessionService)
  
    await ctx.plugin(ToolPty)
    },
    note
:
      'The six terminal tools are opt-in an
d complement one-shot shell/filesystem tools.
 `terminal_send(run_in_background: true)` reg
isters with `ctx.jobs`; TUI, named key sequen
ces, BEL, resize, auto-start, and cross-agent
 sharing are absent from the schema.',
  },
 
 {
    pkg: '@deepseek-ai/dsh-tool-goal',
   
 dir: 'tool-goal',
    source: 'packages/goal
/tool-goal/src/index.ts',
    requires: ['ctx
.tools', 'ctx.agents', 'ctx.goals', 'ctx.syst
emPrompt', 'a calling Agent in an authorized 
open turn'],
    writes: ['tool/call', 'goal/
change for mutations', 'tool/result'],
    as
ync mount(ctx) {
      await ctx.plugin(Agent
Registry)
      await ctx.plugin(GoalService)

      await ctx.plugin(ToolGoal)
    },
    
note:
      'create, edit, pause, and resume 
require direct-human root authority; complete
 and blocked also accept the exact current go
al round. The default blocked lower bound is 
three admitted rounds.',
  },
  {
    pkg: '@
deepseek-ai/dsh-schedule',
    dir: 'schedule
',
    source: 'packages/schedule/schedule/sr
c/tools.ts',
    requires: ['ctx.tools', 'ctx
.sessions', 'Session persistence', 'a future 
live root Agent'],
    writes: ['tool/call', 
'schedule/change create or delete', 'tool/res
ult'],
    async mount(ctx) {
      await ctx
.plugin(SessionStore)
      const session = c
tx.sessions.create(SessionId('tool-catalog-sc
hedule'))
      const agent = { id: session.i
d, session } as Agent
      await mountCatalo
gChildScope(ctx, (childCtx) => {
        Tool
Schedule.registerScheduleTools(ctx, childCtx,
 agent, () => {})
      }, agent, ['tools', '
systemPrompt'])
    },
    scope: ctx => cata
logChildScopes.get(ctx) as Agent,
    note:
 
     'Registered only inside live root Agent 
scopes created after the opt-in Schedule plug
in loads. '
      + 'Version 1 accepts after_
seconds, explicit absolute at, and bounded fi
xed-rate every_seconds, '
      + 'and disclo
ses session-local delivery; '
      + 'manage
ment reads and mutations require the shared S
ession persistence barrier.',
  },
  {
    pk
g: '@deepseek-ai/dsh-tool-lsp',
    dir: 'too
l-lsp',
    source: 'packages/lsp/tool-lsp/sr
c/index.ts',
    requires: ['ctx.tools', 'ctx
.lsp', 'ctx.systemPrompt'],
    writes: ['too
l/call', 'tool/result'],
    async mount(ctx)
 {
      // The tool registers from the seam 
alone; the schema does not depend on any prov
ider.
      await ctx.plugin(Lsp)
      await
 ctx.plugin(ToolLsp)
    },
    note:
      '
The lsp tool keeps provider selection and lan
guage-server subprocesses behind ctx.lsp, so 
its model-visible schema stays stable across 
providers. Requires a registered provider (e.
g. `@deepseek-ai/dsh-lsp-stdio`) at runtime; 
without one, a query returns the structured `
LSP_UNAVAILABLE` error rather than changing t
he schema.',
  },
  {
    pkg: '@deepseek-ai/
dsh-tool-ralph',
    dir: 'tool-ralph',
    s
ource: 'packages/workflow/tool-ralph/src/inde
x.ts',
    requires: ['ctx.tools', 'ctx.workf
lowEngine', 'ctx.subagents', 'ctx.systemPromp
t', 'a calling Agent (exec.agent parents ever
y fresh round)'],
    writes: ['tool/call', '
tool/result', 'workflow and child session eve
nts during execution'],
    async mount(ctx) 
{
      await ctx.plugin(SubagentRuntime)
   
   registerCatalogSubagentProvider(ctx, 'mock
')
      await ctx.plugin(VmWorkflowEngine, {
 provider: 'mock' })
      await ctx.plugin(T
oolRalph, { subagentProvider: 'mock' })
    }
,
    note:
      'A fixed foreground workflo
w starts one fresh structured child per round
; the model selects only the immutable object
ive and an optional round cap.',
  },
  {
   
 pkg: '@deepseek-ai/dsh-tool-skill',
    dir:
 'tool-skill',
    source: 'packages/skill/to
ol-skill/src/index.ts',
    requires: ['ctx.t
ools', 'ctx.agents', 'ctx.skills'],
    write
s: ['tool/call', 'tool/result', 'user/message
 replacement catalogs via agent.inject()'],
 
   async mount(ctx) {
      await ctx.plugin(
AgentRegistry)
      await ctx.plugin(SkillRe
gistry)
      await ctx.plugin(SkillFileSyste
m, {
        dshHome: resolve(root, '.tmp/too
l-catalog/.dsh'),
        agentsHome: resolve
(root, '.tmp/tool-catalog/.agents'),
      })

      await ctx.plugin(ToolSkill)
    },
  }
,
  {
    pkg: '@deepseek-ai/dsh-tool-session
-query',
    dir: 'tool-session-query',
    s
ource: 'packages/session-query/tool-session-q
uery/src/index.ts',
    requires: ['ctx.tools
', 'ctx.systemPrompt', 'ctx.sessionQuery', 'a
 calling Agent for workspace authority'],
   
 writes: ['tool/call', 'tool/result'],
    as
ync mount(ctx) {
      await ctx.plugin(Sessi
onStore)
      await ctx.plugin(SqliteSession
QueryEngine, { path: ':memory:' })
      awai
t ctx.plugin(ToolSessionQuery)
    },
    not
e:
      'The five read-only tools hide provi
der cursors and authorize every result from t
he immutable calling agent session. The packa
ge is opt-in; compositions that need enforced
 deadlines or bounded inline output also moun
t the generic timeout or spill policies.',
  
},
  {
    pkg: '@deepseek-ai/dsh-tool-subage
nt',
    dir: 'tool-subagent',
    source: 'p
ackages/subagent/tool-subagent/src/index.ts',

    requires: ['ctx.tools', 'ctx.subagents',
 'ctx.systemPrompt'],
    writes: ['tool/call
', 'tool/result', 'child session events throu
gh the chosen provider'],
    shippedNames: [
'subagent', 'subagent_fork'],
    async mount
(ctx) {
      await ctx.plugin(SubagentRuntim
e)
      registerCatalogSubagentProvider(ctx,
 'mock')
      await ctx.plugin(ToolSubagent,
 { provider: 'mock' })
    },
    note:
     
 'The registered tool name is the load-time `
toolName` config (default `subagent`); the sc
hema above is that default. The shipped compo
sitions load this package once per subagent b
ackend, so the model additionally sees `subag
ent_fork` bound to the fork backend. Each ins
tance\'s description, `run_in_background` par
ameter, and system-prompt policy follow its o
wn `backgroundMode` and `enableRunInBackgroun
d`, so the two shipped schemas are not identi
cal: `subagent` is `continuable` and defaults
 omitted calls to background with automatic s
ettlement delivery, while `subagent_fork` sta
ys `one-shot` and defaults them to foreground
 — see `packages/bundle/base/cordis.patch.y
ml` and `examples/acp-agent/cordis.yml`.',
  
},
  {
    pkg: '@deepseek-ai/dsh-tool-subage
nt-control',
    dir: 'tool-subagent-control'
,
    source: {
      interrupt_agent: 'packa
ges/subagent/tool-subagent-control/src/index.
ts',
      list_agents: 'packages/subagent/to
ol-subagent-control/src/list-agents.ts',
    
  send_message: 'packages/subagent/tool-subag
ent-control/src/index.ts',
    },
    require
s: ['ctx.tools', 'ctx.subagents', 'ctx.agents
 and ctx.sessionProjections (list_agents only
)'],
    writes: ['tool/call', 'tool/result',
 'child session events through ctx.subagents'
],
    async mount(ctx) {
      await ctx.plu
gin(SubagentRuntime)
      await ctx.plugin(L
ocalJobRegistry)
      await ctx.plugin(Agent
Registry)
      await ctx.plugin(SessionStore
)
      await ctx.plugin(SessionProjectionReg
istry)
      await ctx.plugin(ToolSubagentCon
trol)
      await ctx.plugin(ToolSubagentList
Agents)
    },
    note:
      'The globally 
named control tools over continuable backgrou
nd subagents: provider-bound `tool-subagent` 
instances register distinct delegation tools,
 while this package registers `send_message` 
and `interrupt_agent` once, plus `list_agents
` from its separately loaded `/list-agents` p
lugin (whose catalog rows use the sessionProj
ections and live Agent registries).',
  },
  
{
    pkg: '@deepseek-ai/dsh-tool-subagent-re
port',
    dir: 'tool-subagent-report',
    s
ource: 'packages/subagent/tool-subagent-repor
t/src/index.ts',
    requires: ['ctx.subagent
s', 'ctx.systemPrompt', 'a live continuable i
n-process child Agent'],
    writes: ['tool/c
all', 'tool/result', 'a user-role message in 
the direct parent session'],
    async mount(
ctx) {
      await ctx.plugin(AgentRegistry)

      await ctx.plugin(SubagentRuntime)
     
 const { reportDelivery } = ToolSubagentRepor
t.Config({}) as { reportDelivery: SubagentRep
ortDelivery }
      await mountCatalogChildSc
ope(ctx, (childCtx) => {
        ToolSubagent
Report.installReportTool(childCtx, ctx, repor
tDelivery)
      })
    },
    scope: ctx => 
catalogChildScopes.get(ctx) as Agent,
    not
e:
      'Registered per continuable in-proce
ss child rather than globally, so this schema
 is visible only '
      + 'inside such a chi
ld and survives its global `toolFilter`. The 
same contribution installs the '
      + 'chi
ld-scoped `tool:report` prompt section, which
 this catalog does not render. The parent-fac
ing '
      + '`send_message` tool is install
ed independently.',
  },
  {
    pkg: '@deeps
eek-ai/dsh-tool-jobs',
    dir: 'tool-jobs',

    source: 'packages/jobs/tool-jobs/src/inde
x.ts',
    requires: ['ctx.tools', 'ctx.jobs'
, 'ctx.systemPrompt'],
    writes: ['tool/cal
l', 'tool/result', 'user/message via agent.in
ject() for background completion notices'],
 
   async mount(ctx) {
      await ctx.plugin(
LocalJobRegistry)
      await ctx.plugin(Tool
Tasks)
    },
    note:
      'The kind-agnos
tic background-job controller: background bas
h commands, PTY sends, and subagents are read
, listed, and killed through the same three t
ools. Loading the plugin attaches the control
ler that arms producers\' `ctx.jobs.start()`.
',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-t
odo',
    dir: 'tool-todo',
    source: 'pack
ages/todo/tool-todo/src/index.ts',
    requir
es: ['ctx.tools', 'owning Agent session'],
  
  writes: ['tool/call', 'todo/write', 'tool/r
esult'],
    async mount(ctx) {
      await c
tx.plugin(ToolTodo, { allowParallelInProgress
: true })
    },
    note:
      'todo_write 
is session-owned state; UIs render the latest
 todo/write event as a checklist. `allowParal
lelInProgress` is required with no default, s
o the catalog states its choice: `true`, whos
e description invites several `in_progress` i
tems. A deployment choosing `false` receives 
the same tool with a description asking for e
xactly one active task.',
  },
  {
    pkg: '
@deepseek-ai/dsh-tool-workflow',
    dir: 'to
ol-workflow',
    source: 'packages/workflow/
tool-workflow/src/index.ts',
    requires: ['
ctx.tools', 'ctx.workflowEngine', 'ctx.system
Prompt', 'a calling Agent (exec.agent parents
 the script children)'],
    writes: ['tool/c
all', 'tool/result'],
    async mount(ctx) {

      // The tool injects `workflows`; boot t
he vm engine over a scripted
      // subagen
t provider to satisfy it. The schema does not
 depend on which
      // provider backs the 
engine.
      await ctx.plugin(SubagentRuntim
e)
      registerCatalogSubagentProvider(ctx,
 'mock')
      await ctx.plugin(VmWorkflowEng
ine, { provider: 'mock' })
      await ctx.pl
ugin(ToolWorkflow)
    },
  },
  {
    pkg: '
@deepseek-ai/dsh-tool-web',
    dir: 'tool-we
b',
    source: 'packages/web/tool-web/src/in
dex.ts',
    requires: ['ctx.tools', 'ctx.web
', 'ctx.systemPrompt'],
    writes: ['tool/ca
ll', 'tool/result'],
    async mount(ctx) {
 
     // Mount search and fetch providers so b
oth tools register. Their schemas
      // do
 not depend on provider identity or availabil
ity.
      await ctx.plugin(WebRuntime)
     
 await ctx.plugin(WebSearchExa)
      await c
tx.plugin(WebFetchLocal)
      await ctx.plug
in(ToolWeb)
    },
    note:
      'web_searc
h and web_fetch keep provider selection behin
d ctx.web so model-visible schemas stay stabl
e across backend swaps.',
  },
  {
    pkg: '
@deepseek-ai/dsh-tool-github',
    dir: 'tool
-github',
    source: 'packages/github/tool-g
ithub/src/index.ts',
    requires: ['ctx.tool
s', 'a GitHub token at execution time (GITHUB
_TOKEN or ~/.dsh/.credentials.yaml)'],
    wr
ites: ['tool/call', 'tool/result', 'remote Gi
tHub issues and pull requests'],
    async mo
unt(ctx) {
      // Registration is keyless: 
the token resolves only when a call executes.

      await ctx.plugin(ToolGithub)
    },
  
  note:
      'GitHub REST tools shipped by t
he standard and team agent presets; issue and
 PR creation mutate the remote repository. Th
e schema harvest needs no credential because 
the token is read at execution time, not at r
egistration.',
  },
]

/** One package's cont
ribution to the catalog: its schemas plus att
ribution. */
interface CatalogPackage {
  pkg
: string
  sources: Readonly<Record<string, s
tring>>
  requires: string[]
  writes: string
[]
  shippedNames?: string[]
  schemas: ToolS
chema[]
  /** A deployment note (see {@link T
oolPackage.note}), rendered after the tools. 
*/
  note?: string
}

/** The whole catalog: 
one entry per booted tool package, in manifes
t order. */
export type ToolCatalog = Catalog
Package[]

/**
 * Assert the boot manifest co
vers every shipped tool package on disk (a
 *
 `tool-*` leaf under `packages/`).
 * Booting
 has no source declaration to enumerate, so t
his glob restores the
 * "a new tool cannot b
e silently undocumented" guarantee: an unlist
ed package
 * fails the generator (and the fr
eshness gate) until it is added to
 * {@link 
TOOL_PACKAGES}. Exported for a direct negativ
e test.
 *
 * `scanRoot` defaults to the repo
 root; a test may point it at a fixture tree.

 */
export function assertManifestComplete(p
ackages: ToolPackage[] = TOOL_PACKAGES, scanR
oot: string = root): void {
  const onDisk = 
globSync('packages/*/tool-*', { cwd: scanRoot
 }).map(p => basename(p)).sort()
  const list
ed = new Set(packages.map(p => p.dir))
  cons
t missing = onDisk.filter(dir => !listed.has(
dir))
  if (missing.length > 0) {
    throw n
ew Error(
      `gen-tool-catalog: ${missing.
length} tool package(s) not in the boot manif
est: ${missing.join(', ')}. `
      + 'Add ea
ch to TOOL_PACKAGES in scripts/gen-tool-catal
og.ts so its schema is catalogued.',
    )
  
}
}

/**
 * Assert one manifest entry actuall
y registered a tool.
 *
 * A tool package tha
t boots without registering anything is a bro
ken boot, not
 * an empty catalog section. Th
e usual cause is an `inject` the entry's `mou
nt`
 * does not satisfy: cordis leaves the pl
ugin PENDING, every step here still
 * succee
ds, and the generator writes a catalog missin
g that package's tools —
 * with the freshn
ess gate green on it, because the omission is
 now what the
 * generator produces. {@link a
ssertManifestComplete} cannot see this: the
 
* package IS listed, it just contributed noth
ing.
 * @param entry - the manifest entry tha
t was booted.
 * @param harvested - how many 
schemas its boot registered.
 * @throws when 
the boot registered no tool at all.
 */
expor
t function assertToolsHarvested(entry: ToolPa
ckage, harvested: number): void {
  if (harve
sted > 0) return
  throw new Error(
    `gen-
tool-catalog: ${entry.pkg} booted without reg
istering a single tool. `
    + 'Its plugin i
s most likely PENDING on a service this manif
est entry does not mount — '
    + `compare
 the plugin's inject with mount() and require
s: ${entry.requires.join(', ')}.`,
  )
}

/**

 * Boot each tool package on a fresh Context
 and harvest its model-facing
 * schemas. A f
resh Context per package keeps attribution cl
ean (each entry's
 * schemas come from exactl
y that package) and isolates a boot failure t
o its
 * own entry. Disposed after harvest so
 no executor/provider outlives the run.
 */
e
xport async function collectToolCatalog(packa
ges: ToolPackage[] = TOOL_PACKAGES): Promise<
ToolCatalog> {
  assertManifestComplete(packa
ges)
  const catalog: ToolCatalog = []
  for 
(const entry of packages) {
    const ctx = n
ew Context()
    // Dispose in `finally` so a
 throw from `mount`/`schemas()` after earlier

    // plugins mounted still tears the conte
xt down (no leaked executor/provider
    // f
iber) — the repo's "dispose must reach quie
scence" rule.
    try {
      await ctx.plugi
n(SystemPrompt)
      await ctx.plugin(ToolRu
ntime, entry.toolsConfig ?? {})
      await e
ntry.mount(ctx)
      const schemas = ctx.too
ls.schemas(entry.scope?.(ctx)).sort((a, b) =>
 a.name.localeCompare(b.name))
      assertTo
olsHarvested(entry, schemas.length)
      cat
alog.push({
        pkg: entry.pkg,
        s
ources: Object.fromEntries(schemas.map(schema
 => [
          schema.name,
          toolSo
urce(entry, schema.name),
        ])),
      
  requires: entry.requires,
        writes: e
ntry.writes,
        schemas,
        ...entr
y.shippedNames !== undefined ? { shippedNames
: entry.shippedNames } : {},
        ...entry
.note !== undefined ? { note: entry.note } : 
{},
      })
    } finally {
      await ctx.
fiber.dispose()
    }
  }
  return catalog
}


/** Resolve one harvested tool to the plugin
 source that registered it. */
function toolS
ource(entry: ToolPackage, toolName: string): 
string {
  if (typeof entry.source === 'strin
g') return entry.source
  const source = entr
y.source[toolName]
  if (source === undefined
) {
    throw new Error(
      `gen-tool-cata
log: ${entry.pkg} has no source mapping for h
arvested tool ${toolName}`,
    )
  }
  retur
n source
}

/** Render one tool's entry: name
, description, JSON-Schema parameters, source
. */
function renderTool(schema: ToolSchema, 
source: string): string[] {
  const out = [`#
## \`${schema.name}\``, '']
  if (schema.desc
ription) out.push(schema.description, '')
  o
ut.push('```json', JSON.stringify(schema.para
meters, null, 2), '```', '')
  out.push(`Sour
ce: [\`${source}\`](../${source})`, '')
  ret
urn out
}

function codeList(values: string[]
 | undefined): string {
  return values?.leng
th ? values.map(value => `\`${value}\``).join
(', ') : '-'
}

function tableCell(value: str
ing | undefined): string {
  return value ? v
alue.replace(/\|/g, '\\|').replace(/\n/g, '<b
r>') : '-'
}

/** Render the full catalog (pu
re, deterministic given the manifest-ordered 
input). */
export function render(catalog: To
olCatalog): string {
  const lines: string[] 
= [
    '<!-- Generated by scripts/gen-tool-c
atalog.ts — do not edit by hand.',
    '   
  Run `pnpm run gen-tool-catalog` to regenera
te. -->',
    '',
    '# Tool Schema Catalog'
,
    '',
    'Every model-facing tool a ship
ped plugin contributes to `ctx.tools`: the `n
ame`, `description`, and JSON-Schema `paramet
ers` the model receives via the system-prompt
 assembly. It complements the [subsystem page
s](subsystems/core.md) (the types plus each p
age\'s generated Cordis API region) — this 
page is the *tools* the agent is offered.',
 
   '',
    'This file is GENERATED and verifi
ed fresh by `pnpm run verify-tool-catalog` (p
art of `doc-sync`) — do not edit it by hand
. Unlike the cordis catalog (a pure source-AS
T pass), this generator BOOTS each tool plugi
n on a real context and reads `ctx.tools.sche
mas()`, because a tool schema is not statical
ly knowable (runtime-spread enums, concatenat
ed descriptions, config-driven names, raw-JSO
N-Schema MCP tools). A completeness guard glo
bs `packages/*/tool-*` and fails if any packa
ge is missing from the generator\'s boot mani
fest, so a new tool cannot be silently undocu
mented. See [the tool-schema-catalog Agent No
te](../.agents/notes/implemented/process/2026
-07-02-tool-schema-catalog.md).',
    '',
   
 'Scope: shipped product tools under `package
s/*/tool-*`, each booted with its DEFAULT con
fig, except where a Config field is REQUIRED 
with no default — there the generator must 
choose, and the per-package note records whic
h branch this page shows. The registered tool
 NAME can be a load-time config (e.g. `tool-s
ubagent`\'s `toolName`), so a deployment may 
expose a package under a different or additio
nal name — a per-package note records those
 shipped aliases where they exist. The `examp
les/` demo tools (e.g. `echo`) are excluded, 
matching the cordis catalog\'s packages-only 
scope.',
    '',
    '## Tool Package Map',
 
   '',
    'This table connects model-visible
 tool names to the plugin package and service
 seams behind them. Exact JSON Schemas follow
 in the package sections below.',
    '',
   
 '| Tool package | Model-visible names | Requ
ires | Writes / affects | Shipped aliases | D
eployment note |',
    '| --- | --- | --- | -
-- | --- | --- |',
    ...catalog.map(entry =
> `| \`${entry.pkg}\` | ${codeList(entry.sche
mas.map(schema => schema.name))} | ${codeList
(entry.requires)} | ${codeList(entry.writes)}
 | ${codeList(entry.shippedNames)} | ${tableC
ell(entry.note)} |`),
    '',
  ]
  for (cons
t entry of catalog) {
    lines.push(`<a id="
${githubSlug(entry.pkg)}"></a>`, '', `## \`${
entry.pkg}\``, '')
    for (const schema of e
ntry.schemas) {
      // Collection validated
 that every harvested schema has a source.
  
    const source = entry.sources[schema.name]
 as string
      lines.push(...renderTool(sch
ema, source))
    }
    if (entry.note) lines
.push(entry.note, '')
  }
  return lines.join
('\n')
}

/** CLI entry: default writes the c
atalog, `--check` fails if the committed copy

 * is stale. Guarded behind an entry-point c
heck so importing this module for
 * tests ne
ither regenerates the committed file nor call
s process.exit. */
async function main(): Pro
mise<void> {
  const content = render(await c
ollectToolCatalog())
  if (process.argv.inclu
des('--check')) {
    let committed: string |
 null = null
    try {
      committed = read
FileSync(resolve(root, OUT), 'utf8')
    } ca
tch {
      // Only ENOENT (not yet generated
) is expected; a present-but-unreadable
     
 // file is not a state this repo produces. E
ither way the remedy is the
      // same —
 regenerate — so treat a read failure as "s
tale".
      committed = null
    }
    if (c
ommitted === content) {
      console.log(`ge
n-tool-catalog: ${OUT} is up to date.`)
     
 process.exit(0)
    }
    console.error(`gen
-tool-catalog: ${OUT} is stale. Run \`pnpm ru
n gen-tool-catalog\` and commit ${OUT}.`)
   
 const committedLines = committed?.split('\n'
) ?? []
    const generatedLines = content.sp
lit('\n')
    const lineCount = Math.max(comm
ittedLines.length, generatedLines.length)
   
 for (let index = 0; index < lineCount; index
 += 1) {
      if (committedLines[index] === 
generatedLines[index]) continue
      console
.error(`gen-tool-catalog: first difference at
 line ${index + 1}`)
      console.error(`  c
ommitted: ${JSON.stringify(committedLines[ind
ex])}`)
      console.error(`  generated: ${J
SON.stringify(generatedLines[index])}`)
     
 break
    }
    process.exit(1)
  }

  write
FileSync(resolve(root, OUT), content)
  conso
le.log(`gen-tool-catalog: wrote ${OUT}.`)
}


// Run only when invoked as a script, not whe
n imported by a test.
if (process.argv[1] && 
import.meta.filename === resolve(process.argv
[1])) {
  await main()
}

