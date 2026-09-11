/**
 * Generate `docs/tool-catalog.md` from s

chemas collected by booting each tool
 * plu
g
in. Runtime registration is the source of t
ru
th for computed schemas;
 * the manifest i
s c
hecked against every on-disk `tool-*` pac
kage
. `--check`
 * verifies the committed ar
tifac
t. Rationale and ownership live in
 * `
.agent
s/notes/implemented/process/2026-07-02
-tool-s
chema-catalog.md`.
 */

import { glob
Sync, re
adFileSync, writeFileSync } from 'no
de:fs'
im
port { basename, resolve } from 'no
de:path'
i
mport { Context } from '@deepseek-
ai/cordis'

import type { ToolSchema } from '
@deepseek-ai
/dsh-llm'
import AgentRegistry f
rom '@deepsee
k-ai/dsh-agent'
import type { A
gent } from '@
deepseek-ai/dsh-agent'
import 
{ createScope }
 from '@deepseek-ai/dsh-scope
'
import Session
Store, { SessionId } from '@
deepseek-ai/dsh-s
ession'
import SessionProje
ctionRegistry from
 '@deepseek-ai/dsh-session
-projection'
import
 SqliteSessionQueryEngine
 from '@deepseek-ai/
dsh-session-query-sqlite
'
import GoalService 
from '@deepseek-ai/dsh-
goal'
import SystemPro
mpt from '@deepseek-ai
/dsh-system-prompt'
imp
ort ToolRuntime, { ty
pe Config as ToolsConfig
 } from '@deepseek-a
i/dsh-tools'
import Local
BashExecutor from '
@deepseek-ai/dsh-bash-loca
l'
import * as Bas
hEnvPlugin from '@deepseek-
ai/dsh-shell-env'

import { PwshLocalExecutor 
} from '@deepsee
k-ai/dsh-pwsh-local'
import L
ocalSubprocessR
untime from '@deepseek-ai/dsh-
subprocess-loc
al'
import LocalFileSystem from
 '@deepseek-a
i/dsh-fs-local'
import { Attachm
entStore } f
rom '@deepseek-ai/dsh-attachment'

import typ
e { ImageAttachmentLimits, ImageAt
tachmentRe
f, SaveImageAttachment, StoredImage
Attachmen
t } from '@deepseek-ai/dsh-attachmen
t'
impor
t UserQuestionService from '@deepseek
-ai/dsh
-user-questions'
import PlanModeContro
ller f
rom '@deepseek-ai/dsh-plan-mode'
import
 WebR
untime from '@deepseek-ai/dsh-web'
impor
t * 
as WebSearchExa from '@deepseek-ai/dsh-we
b-s
earch-exa'
import * as WebFetchLocal from 
'@
deepseek-ai/dsh-web-fetch-http'
import Suba
g
entRuntime from '@deepseek-ai/dsh-subagent'


import type { SubagentProvider, SubagentRepor

tDelivery } from '@deepseek-ai/dsh-subagent'


import * as ToolSubagentControl from '@deep
se
ek-ai/dsh-tool-subagent-control'
import * 
as 
ToolSubagentListAgents from '@deepseek-ai
/dsh
-tool-subagent-control/list-agents'
impo
rt * 
as ToolSubagentReport from '@deepseek-a
i/dsh-
tool-subagent-report'
import SkillRegi
stry fr
om '@deepseek-ai/dsh-skill'
import * 
as Skill
FileSystem from '@deepseek-ai/dsh-sk
ill-files
ystem'
import LocalJobRegistry from
 '@deepsee
k-ai/dsh-jobs-local'
import * as T
oolAskUser 
from '@deepseek-ai/dsh-tool-ask-u
ser'
import 
* as ToolBash from '@deepseek-ai
/dsh-tool-bas
h'
import * as ToolPwsh from '@
deepseek-ai/ds
h-tool-pwsh'
import * as ToolB
ashPersistent f
rom '@deepseek-ai/dsh-tool-ba
sh-persistent'
i
mport CordisHostRunner from 
'@deepseek-ai/dsh
-cordis-host-runner'
import
 * as ToolCordis f
rom '@deepseek-ai/dsh-tool
-cordis'
import * a
s ToolFs from '@deepseek-
ai/dsh-tool-fs'
impo
rt * as ToolFsSearch fro
m '@deepseek-ai/dsh-t
ool-fs-search'
import *
 as ToolStrReplaceEdit
or from '@deepseek-ai/
dsh-tool-str-replace-ed
itor'
import Terminal
SessionService from '@de
epseek-ai/dsh-termin
al'
import * as ToolPty f
rom '@deepseek-ai/d
sh-tool-terminal'
import *
 as ToolGoal from 
'@deepseek-ai/dsh-tool-goal
'
import * as Too
lSchedule from '@deepseek-ai
/dsh-schedule'
i
mport Lsp from '@deepseek-ai/
dsh-lsp'
import
 * as ToolLsp from '@deepseek-
ai/dsh-tool-ls
p'
import * as ToolSkill from '
@deepseek-ai/
dsh-tool-skill'
import * as Tool
SessionQuery
 from '@deepseek-ai/dsh-tool-sess
ion-query'

import * as ToolTasks from '@deeps
eek-ai/dsh
-tool-jobs'
import * as ToolTodo fr
om '@deep
seek-ai/dsh-tool-todo'
import * as T
oolSubag
ent from '@deepseek-ai/dsh-tool-subag
ent'
im
port * as ToolWeb from '@deepseek-ai/d
sh-too
l-web'
import VmWorkflowEngine from '@d
eepse
ek-ai/dsh-workflow-worker-thread'
import
 * a
s ToolRalph from '@deepseek-ai/dsh-tool-r
alp
h'
import * as ToolWorkflow from '@deepsee
k-
ai/dsh-tool-workflow'
import * as ToolGithu
b
 from '@deepseek-ai/dsh-tool-github'
import 

{ githubSlug } from './verify-md-links.ts'

/

** Attachment seam marker that makes the att
a
chments-conditional `read_image` schema har
ve
stable. */
class CatalogAttachmentStore ex
ten
ds AttachmentStore {
  readonly imageLimi
ts: 
ImageAttachmentLimits = Object.freeze({

    m
axImageBytes: 1,
    maxImagesPerMessag
e: 1,

    maxMessageImageBytes: 1,
    maxIm
agePixe
ls: 1,
    mediaTypes: Object.freeze(
['image/
png'] as const),
  })

  override va
lidateIma
ge(_input: SaveImageAttachment): Pr
omise<void
> {
    return Promise.reject(new 
Error('gen-
tool-catalog: attachment validati
on is unreac
hable during schema harvest'))
 
 }

  overrid
e saveImage(_input: SaveImageAt
tachment): Pro
mise<ImageAttachmentRef> {
   
 return Promise
.reject(new Error('gen-tool-c
atalog: attachme
nt writes are unreachable du
ring schema harve
st'))
  }

  override readI
mage(_ref: ImageAt
tachmentRef): Promise<Stor
edImageAttachment> 
{
    return Promise.reje
ct(new Error('gen-to
ol-catalog: attachment r
eads are unreachable 
during schema harvest')
)
  }
}

const root = 
resolve(import.meta.di
rname, '..')
const OUT 
= 'docs/tool-catalog.
md'

/**
 * Register the
 descriptor needed t
o mount schema-producing 
consumers. Declares

 * the full capability se
t of the shipped i
n-process providers so cons
umers
 * mount un
der their shipped defaults (
tool-subagent's 
default numeric maxDepth
 * r
equires `depthL
imit`).
 */
function registerC
atalogSubagent
Provider(ctx: Context, name: st
ring): void {

  const provider: SubagentProvi
der = {
    
name,
    capabilities: { outputS
chema: true
, depthLimit: true, toolFilter: tr
ue, person
a: true },
    inheritsParentContex
t: false,

    start: () => Promise.reject(new
 Error('
tool-catalog provider cannot start a 
child')
),
    // Declared so consumers config
ured f
or continuable background mode mount.
 
   pr
epareContinuable: () => Promise.reject(n
ew E
rror('tool-catalog provider cannot prepar
e a
 child')),
  }
  ctx.subagents.registerPro
vi
der(provider)
}

/** Minted child-scope key
s
 for packages whose tools are never global. 

*/
const catalogChildScopes = new WeakMap<Con

text, Agent>()

/**
 * Install one scope-loc
a
l tool package into an agent-like child sco
pe
 for
 * schema harvest, without starting a
 mo
del, Agent loop, or persistence backend.

 * @
param ctx - catalog context owning the s
cope.

 * @param mountScoped - package instal
ler fo
r the scoped context.
 * @param key - 
agent-l
ike scope key exposed to the package'
s scope 
selector.
 * @param inject - service
s the pac
kage installer must await before mo
unting.
 *
/
async function mountCatalogChild
Scope(
  ct
x: Context,
  mountScoped: (child
Ctx: Context
) => void,
  key: Agent = { id: 
SessionId('to
ol-catalog-child') } as Agent,

  inject: stri
ng[] = ['tools', 'systemPrompt
', 'subagents']
,
): Promise<void> {
  await 
ctx.plugin(Objec
t.assign((inner: Context) =>
 {
    mountScope
d(createScope(inner, key).c
tx)
  }, { inject 
}))
  catalogChildScopes.s
et(ctx, key)
}

/**

 * Tool package plus its
 hand-maintained boo
t recipe. The caller mou
nts the
 * prompt and
 registry; each recipe 
supplies only package-
specific seams and
 * 
config, while `dir` par
ticipates in the comp
leteness check.
 */
expo
rt interface ToolPac
kage {
  /** The npm pack
age name, used as t
he catalog section heading
. */
  pkg: string

  /** The `packages/<group
>/<dir>` leaf nam
e — matched by the complet
eness guard. */

  dir: string
  /**
   * Repo
-relative imple
mentation source linked per ha
rvested tool. 
Packages
   * whose tools share
 one plugin m
ay use a string; split plugins m
ap each tool

   * name to its own source.
   
*/
  source
: string | Readonly<Record<string,
 string>>

  /** Services or owning runtimes t
he packag
e requires at execution time. */
  r
equires:
 string[]
  /** Session events or oth
er visi
ble state the tools write or affect. *
/
  wr
ites: string[]
  /** Additional model-v
isibl
e names shipped by example/app config. *
/
  
shippedNames?: string[]
  /** Plug the in
jec
ted seams + the tool plugin onto a context
 t
hat already
   * carries `systemPrompt` + `
t
ools`. */
  mount: (ctx: Context) => Promise

<void>
  /** Agent-like scope key whose tool 

view is catalogued instead of the global vie
w
. */
  scope?: (ctx: Context) => Agent
  /*
*

   * Config for the caller's `ToolRuntime`
 mo
unt. The registry itself ships a
   * mod
el-f
acing tool (`run_code`, registered under
 a no
n-native `mode`), so
   * ITS catalog e
ntry b
oots the registry in the mode that exp
oses it
;
   * every other entry uses the def
ault (na
tive) registry.
   */
  toolsConfig?
: ToolsCo
nfig
  /**
   * A deployment note r
endered af
ter the package's tools, for a fac
t that
   *
 booting the package alone cannot
 show. The r
egistered tool NAME can be a
   
* load-time c
onfig (`tool-subagent`'s `toolN
ame`), so one 
package may appear
   * under 
several names a
cross deployments — the boo
t yields the pac
kage
   * DEFAULT, and this 
note records the 
shipped alternatives the mo
del sees.
   */
  
note?: string
}

/**
 * Th
e boot manifest: ev
ery shipped tool package 
(a `tool-*` leaf und
er
 * `packages/`). Orde
red by package name (
the render order); the 
completeness
 * guard 
proves it is exhaustiv
e against the on-disk g
lob.
 */
const TOOL_P
ACKAGES: ToolPackage[] =
 [
  {
    pkg: '@de
epseek-ai/dsh-tool-ask-us
er',
    dir: 'tool
-ask-user',
    source: 'p
ackages/interactio
n/tool-ask-user/src/index.t
s',
    requires:
 ['ctx.tools', 'ctx.userQues
tions'],
    wri
tes: ['tool/call', 'tool/resu
lt after a UI/p
rovider answers the question']
,
    async mo
unt(ctx) {
      await ctx.plug
in(UserQuesti
onService)
      await ctx.plugi
n(ToolAskUse
r)
    },
    note:
      'ask_us
er_question
 pauses the tool call until the ac
tive UI pr
ovider returns a human answer.',
  
},
  {
  
  pkg: '@deepseek-ai/dsh-tools',
   
 dir: 't
ools',
    source: 'packages/core/too
ls/src/
code-mode.ts',
    requires: ['ctx.too
ls', '
ctx.codeRuntime (execution time)', 'ctx
.syst
emPrompt'],
    writes: ['tool/call', 'o
ne t
ool/code-dispatch-start + tool/code-dispa
tch
 pair per bridged sub-call', 'tool/result'
  
{
    pkg: '@deepseek-ai/dsh-tool-dependency-
graph',
    dir: 'tool-dependency-graph',
   
 source: 'packages/extensions/tool-dependency
-graph/src/index.ts',
    requires: ['ctx.too
ls'],
    writes: ['tool/call', 'tool/result'
],
    async mount(ctx) {
      await ctx.plu
gin(ToolDependencyGraph)
    },
    note: 'de
pendency_graph analyzes project dependency re
lationships.',
  },
  {
    pkg: '@deepseek-a
i/dsh-tool-diff-merge',
    dir: 'tool-diff-m
erge',
    source: 'packages/extensions/tool-
diff-merge/src/index.ts',
    requires: ['ctx
.tools'],
    writes: ['tool/call', 'tool/res
ult'],
    async mount(ctx) {
      await ctx
.plugin(ToolDiffMerge)
    },
    note: 'diff
_merge performs three-way merge of file chang
es.',
  },
  {
    pkg: '@deepseek-ai/dsh-too
l-programming-assistant',
    dir: 'tool-prog
ramming-assistant',
    source: 'packages/ext
ensions/tool-programming-assistant/src/index.
ts',
    requires: ['ctx.tools'],
    writes:
 ['tool/call', 'tool/result'],
    async moun
t(ctx) {
      await ctx.plugin(ToolProgrammi
ngAssistant)
    },
    note: 'programming_as
sistant provides code generation and refactor
ing assistance.',
  },
  {
    pkg: '@deepsee
k-ai/dsh-tool-semantic-search',
    dir: 'too
l-semantic-search',
    source: 'packages/ext
ensions/tool-semantic-search/src/index.ts',
 
   requires: ['ctx.tools'],
    writes: ['too
l/call', 'tool/result'],
    async mount(ctx)
 {
      await ctx.plugin(ToolSemanticSearch)

    },
    note: 'semantic_search performs s
emantic code search using embeddings.',
  },

  {
    pkg: '@deepseek-ai/dsh-tool-test-impa
ct',
    dir: 'tool-test-impact',
    source:
 'packages/extensions/tool-test-impact/src/in
dex.ts',
    requires: ['ctx.tools'],
    wri
tes: ['tool/call', 'tool/result'],
    async 
mount(ctx) {
      await ctx.plugin(ToolTestI
mpact)
    },
    note: 'test_impact analyzes
 which tests are affected by code changes.',

  },
  {
    pkg: '@deepseek-ai/dsh-tool-work
flow-run',
    dir: 'tool-workflow-run',
    
source: 'packages/extensions/tool-workflow-ru
n/src/index.ts',
    requires: ['ctx.tools'],

    writes: ['tool/call', 'tool/result'],
  
  async mount(ctx) {
      await ctx.plugin(T
oolWorkflowRun)
    },
    note: 'workflow_ru
n executes CI/CD workflow steps and returns r
esults.',
  },
],
    // The registry's OWN t
ool: run_code e
xists only under a non-native
 mode
    // (th
e registry registers it in i
ts constructor; t
he code runtime is read
   
 // at assembly/ex
ecution time, so the schem
a harvest needs non
e mounted).
    toolsConf
ig: { mode: 'code' }
,
    async mount() {},

    note:
      'Owne
d by the tool registry 
as a reserved transpor
t outside filterable c
apability layers under 
`mode: code` / `mode:
 both` (see the Code Mod
e Agent Note). Under
 `code` it is the registr
y\'s only wire cont
ribution; the other visibl
e capabilities are
 declared in a generated SD
K section in the 
loaded runtime\'s language, 
and a program ca
lls them through bindings sch
eduled under th
e native concurrency contract 
(submission-or
dered starts and policy; concur
rency-safe bo
dies overlap up to `maxParallelS
ubCalls`) th
at re-enter the complete guarded 
tool pipeli
ne and link each nested execution 
to this ou
ter result.',
  },
  {
    pkg: '@d
eepseek-a
i/dsh-plan-mode',
    dir: 'plan-mod
e',
    
source: 'packages/plan/plan-mode/src/
index.t
s',
    requires: ['ctx.tools', 'ctx.s
ystemP
rompt', 'ctx.userQuestions (execution t
ime, 
opportunistic)'],
    writes: ['tool/cal
l', 
'plan/mode inactive on an approved review
', 
'tool/result'],
    async mount(ctx) {
   
  
 await ctx.plugin(PlanModeController, { sec
t
ion: 'Tool catalog schema harvest.' })
    }

,
    note:
      'exit_plan_mode stays in th

e model-facing schema while planning is inac
t
ive so transitions add no tool-catalog chur
n 
on top of the plan-policy change. Its exec
ute
 path rejects calls outside plan mode; in
 pla
n mode it presents the plan over the use
r-que
stions seam (approve / keep planning wi
th fee
dback), and approval logs plan mode in
active 
at the step boundary.',
  },
  {
    
pkg: '@d
eepseek-ai/dsh-tool-bash',
    dir: 
'tool-bas
h',
    source: 'packages/shell/too
l-bash/src
/index.ts',
    requires: ['ctx.to
ols', 'ctx.
shell', 'ctx.systemPrompt', 'ctx.
shellEnv', '
ctx.jobs at call time for run_in
_background']
,
    writes: ['tool/call', 'to
ol/result'],
 
   async mount(ctx) {
      aw
ait ctx.plugin(
LocalSubprocessRuntime)
     
 await ctx.plugi
n(BashEnvPlugin)
      await
 ctx.plugin(Local
BashExecutor)
      await c
tx.plugin(ToolBash
)
    },
    note:
      '
The bash tool is th
e model-facing consumer o
f the bash executor 
seam. A `run_in_backgrou
nd` run registers wit
h the generic `ctx.jobs
` runtime and is colle
cted/stopped through t
he `job_*` tools from `
@deepseek-ai/dsh-tool
-jobs`; the `enableRunIn
Background` config (
default true) removes the
 parameter entirely
 when disabled.',
  },
  {

    pkg: '@deepse
ek-ai/dsh-tool-pwsh',
    d
ir: 'tool-pwsh',

    source: 'packages/shell/
tool-pwsh/src/in
dex.ts',
    requires: ['ctx.
tools', 'ctx.sh
ell', 'ctx.systemPrompt', 'ctx
.shellEnv', 'c
tx.jobs at call time for run_in
_background']
,
    writes: ['tool/call', 'too
l/result'],

    async mount(ctx) {
      // T
he pwsh too
l consumes the bash executor seam;
 the schem
a harvest
      // mounts the pwsh-
local imp
lementation so the inject resolves w
ithout
 
     // executing anything (registrat
ion nev
er spawns a process).
      await ctx.
plugin
(LocalSubprocessRuntime)
      await ct
x.plu
gin(BashEnvPlugin)
      await ctx.plugi
n(Pw
shLocalExecutor)
      await ctx.plugin(T
ool
Pwsh)
    },
    note:
      'The pwsh too
l 
is the PowerShell-dialect consumer of the b
a
sh executor seam for Windows compositions (a

 PowerShell executor such as `@deepseek-ai/ds

h-pwsh-local` backs `ctx.shell`); it mirrors
 
the bash tool call-for-call minus sandbox c
on
trols — `run_in_background` runs registe
r w
ith the generic `ctx.jobs` runtime and ar
e co
llected/stopped through the `job_*` tool
s, an
d the managed `DSH_*` environment comes
 from 
`@deepseek-ai/dsh-shell-env`. Each cal
l runs 
in a fresh process (no persistent PTY
 session
), with native `C:\\...` paths and `
$env:NAME
` variables.',
  },
  {
    pkg: '@
deepseek-a
i/dsh-tool-cordis',
    dir: 'tool
-cordis',
 
   source: 'packages/extensions/t
ool-cordis/s
rc/index.ts',
    requires: ['ct
x.tools', 'ct
x.dynamicCordisRunner'],
    wr
ites: ['tool/c
all', 'tool/result', 'process-
local dynamic p
ackage lifecycle'],
    async
 mount(ctx) {
  
    await ctx.plugin(CordisH
ostRunner)
      
await ctx.plugin(ToolCordis
)
    },
    note:

      'Not in any shipped
 tree (a deliberate
 opt-in — dynamic packa
ge code reaches the 
real runtime, see .agent
s/notes/implemented/f
eature/2026-07-08-self-
referential-cordis-too
lset.md). The toolset 
injects `ctx.dynamicCor
disRunner` from `@dee
pseek-ai/dsh-cordis-host
-runner`, which owns
 the definition registry 
and the vm sandbox;
 a composition missing it 
never activates th
e tools. A running package 
may register ADDI
TIONAL model-visible tools u
ntil it is stopp
ed, undefined, or DSH restart
s; a full chang
ed request header logs those t
ool-set change
s.',
  },
  {
    pkg: '@deepse
ek-ai/dsh-too
l-bash-persistent',
    dir: 'to
ol-bash-pers
istent',
    source: 'packages/sh
ell/tool-ba
sh-persistent/src/index.ts',
    r
equires: [
'ctx.tools', 'ctx.terminals', 'an o
wning Age
nt at execution time'],
    writes: 
['tool/c
all', 'PTY shell state', 'tool/result
'],
   
 async mount(ctx) {
      await ctx.pl
ugin(T
erminalSessionService)
      await ctx.
plugi
n(ToolBashPersistent)
    },
    note:
 
    
 'One owner-isolated persistent bash tool
; d
eployment composition supplies the PTY bac
ke
nd and may override the model-facing enviro
n
ment description.',
  },
  {
    pkg: '@deep

seek-ai/dsh-tool-str-replace-editor',
    dir

: 'tool-str-replace-editor',
    source: 'pa
c
kages/fs/tool-str-replace-editor/src/index.
ts
',
    requires: ['ctx.tools', 'ctx.fs'],

   
 writes: ['tool/call', 'fs/observed after
 vie
w presence/absence, edit absence, or suc
cessf
ul mutation', 'tool/result'],
    async
 mount
(ctx) {
      await ctx.plugin(LocalFi
leSyste
m)
      await ctx.plugin(ToolStrRepl
aceEdito
r)
    },
    note:
      'Standalon
e view/cr
eate/unique literal replace/line in
sert tool 
over the filesystem seam; it compo
ses with an
y shell or terminal API.',
  },
 
 {
    pkg: 
'@deepseek-ai/dsh-tool-fs',
    
dir: 'tool-fs
',
    source: 'packages/fs/too
l-fs/src/index
.ts',
    requires: ['ctx.tool
s', 'ctx.fs', '
ctx.systemPrompt', 'ctx.attac
hments (read_ima
ge registration)', 'ctx.llm 
+ an image-capabl
e route (read_image executi
on)'],
    writes:
 ['tool/call', 'fs/write-i
ntent or fs/edit-in
tent for mutations', 'fs/
observed after read 
presence/absence or succ
essful file operation
', 'durable attachment 
(read_image)', 'tool/r
esult'],
    async mou
nt(ctx) {
      // The 
tool needs `fs`; the 
bare provider is suffici
ent because policy
 
     // changes behavior,
 not schema shape. 
The catalog seam marker op
ts into
      // t
he attachments-conditional 
read_image schema
 without attachment I/O.
   
   await ctx.plu
gin(LocalFileSystem)
      aw
ait ctx.plugin(
CatalogAttachmentStore)
      
await ctx.plug
in(ToolFs)
    },
    note:
   
   'The read-
before-write/edit policy is adde
d by `@deeps
eek-ai/dsh-fs-observation-policy`
 (an `fs/*`
 event-gate plugin, no schema chan
ge); a dep
loyment that loads these tools is e
xpected t
o also load it. `read_image` is not 
register
ed without `ctx.attachments`; its sch
ema is 
route-independent, and execution refus
es unl
ess the exact routed model declares ima
ge in
put.',
  },
  {
    pkg: '@deepseek-ai/d
sh-t
ool-fs-search',
    dir: 'tool-fs-search'
,
 
   source: 'packages/fs/tool-fs-search/src
/i
ndex.ts',
    requires: ['ctx.tools', 'ctx.
s
ubprocess', 'ctx.systemPrompt'],
    writes:

 ['tool/call', 'tool/result'],
    async moun

t(ctx) {
      // The tools inject `subproce
s
s` (search spawns the packaged ripgrep
    
  
// binary through the seam, not ctx.fs); r
egi
stration itself never
      // spawns, so
 the
 real local service is inert here. `ctx.
spill
Store` is
      // optional (read via c
tx.get
) and does not affect the schemas, so 
no
    
  // spill backend is mounted.
      
await ct
x.plugin(LocalSubprocessRuntime)
   
   await 
ctx.plugin(ToolFsSearch, { sampleOv
erCapGlobR
esults: true })
    },
    note:
 
     'glob 
and grep are unconditional discov
ery tools th
at spawn the packaged ripgrep bi
nary (`@vscod
e/ripgrep`) through ctx.subproc
ess as ordinar
y foreground calls (never back
ground jobs) �
� no host `rg` install and
 no shell layer. Th
e catalog uses `sampleOve
rCapGlobResults: tru
e`; deployments must cho
ose that behavior exp
licitly. Capped results
 save the complete for
matted list through th
e optional ctx.spillSto
re backend; returned 
locators are follow-up-r
eadable/searchable w
hen the backend exposes l
ocal paths in co-lo
cated deployments.',
  },

  {
    pkg: '@dee
pseek-ai/dsh-tool-terminal'
,
    dir: 'tool-
terminal',
    source: 'pack
ages/terminal/to
ol-terminal/src/index.ts',
  
  requires: ['c
tx.tools', 'ctx.terminals', 'c
tx.systemPromp
t', 'ctx.jobs at call time for 
run_in_backgr
ound'],
    writes: ['tool/call'
, 'tool/resu
lt'],
    async mount(ctx) {
    
  await ctx
.plugin(TerminalSessionService)
  
    await 
ctx.plugin(ToolPty)
    },
    note
:
      '
The six terminal tools are opt-in an
d comple
ment one-shot shell/filesystem tools.
 `termi
nal_send(run_in_background: true)` reg
isters
 with `ctx.jobs`; TUI, named key sequen
ces, 
BEL, resize, auto-start, and cross-agent
 sha
ring are absent from the schema.',
  },
 
 {

    pkg: '@deepseek-ai/dsh-tool-goal',
   
 d
ir: 'tool-goal',
    source: 'packages/goal
/
tool-goal/src/index.ts',
    requires: ['ctx

.tools', 'ctx.agents', 'ctx.goals', 'ctx.syst

emPrompt', 'a calling Agent in an authorized
 
open turn'],
    writes: ['tool/call', 'goa
l/
change for mutations', 'tool/result'],
   
 as
ync mount(ctx) {
      await ctx.plugin(A
gent
Registry)
      await ctx.plugin(GoalSer
vice)

      await ctx.plugin(ToolGoal)
    }
,
    
note:
      'create, edit, pause, and 
resume 
require direct-human root authority; 
complete
 and blocked also accept the exact c
urrent go
al round. The default blocked lower
 bound is 
three admitted rounds.',
  },
  {

    pkg: '@
deepseek-ai/dsh-schedule',
    di
r: 'schedule
',
    source: 'packages/schedul
e/schedule/sr
c/tools.ts',
    requires: ['ct
x.tools', 'ctx
.sessions', 'Session persisten
ce', 'a future 
live root Agent'],
    writes
: ['tool/call', 
'schedule/change create or d
elete', 'tool/res
ult'],
    async mount(ctx)
 {
      await ctx
.plugin(SessionStore)
    
  const session = c
tx.sessions.create(Sessio
nId('tool-catalog-sc
hedule'))
      const ag
ent = { id: session.i
d, session } as Agent
 
     await mountCatalo
gChildScope(ctx, (chil
dCtx) => {
        Tool
Schedule.registerSche
duleTools(ctx, childCtx,
 agent, () => {})
  
    }, agent, ['tools', '
systemPrompt'])
   
 },
    scope: ctx => cata
logChildScopes.get
(ctx) as Agent,
    note:
 
     'Registered 
only inside live root Agent 
scopes created a
fter the opt-in Schedule plug
in loads. '
   
   + 'Version 1 accepts after_
seconds, expli
cit absolute at, and bounded fi
xed-rate ever
y_seconds, '
      + 'and disclo
ses session-
local delivery; '
      + 'manage
ment reads 
and mutations require the shared S
ession per
sistence barrier.',
  },
  {
    pk
g: '@deep
seek-ai/dsh-tool-lsp',
    dir: 'too
l-lsp',

    source: 'packages/lsp/tool-lsp/sr
c/index
.ts',
    requires: ['ctx.tools', 'ctx
.lsp',
 'ctx.systemPrompt'],
    writes: ['too
l/cal
l', 'tool/result'],
    async mount(ctx)
 {
 
     // The tool registers from the seam 
alo
ne; the schema does not depend on any prov
id
er.
      await ctx.plugin(Lsp)
      await
 
ctx.plugin(ToolLsp)
    },
    note:
      '

The lsp tool keeps provider selection and lan

guage-server subprocesses behind ctx.lsp, so
 
its model-visible schema stays stable acros
s 
providers. Requires a registered provider 
(e.
g. `@deepseek-ai/dsh-lsp-stdio`) at runti
me; 
without one, a query returns the structu
red `
LSP_UNAVAILABLE` error rather than chan
ging t
he schema.',
  },
  {
    pkg: '@deeps
eek-ai/
dsh-tool-ralph',
    dir: 'tool-ralph
',
    s
ource: 'packages/workflow/tool-ralph
/src/inde
x.ts',
    requires: ['ctx.tools', 
'ctx.workf
lowEngine', 'ctx.subagents', 'ctx.
systemPromp
t', 'a calling Agent (exec.agent 
parents ever
y fresh round)'],
    writes: ['
tool/call', '
tool/result', 'workflow and chi
ld session eve
nts during execution'],
    as
ync mount(ctx) 
{
      await ctx.plugin(Suba
gentRuntime)
   
   registerCatalogSubagentPr
ovider(ctx, 'mock
')
      await ctx.plugin(V
mWorkflowEngine, {
 provider: 'mock' })
     
 await ctx.plugin(T
oolRalph, { subagentProvi
der: 'mock' })
    }
,
    note:
      'A fix
ed foreground workflo
w starts one fresh stru
ctured child per round
; the model selects on
ly the immutable object
ive and an optional r
ound cap.',
  },
  {
   
 pkg: '@deepseek-ai/
dsh-tool-skill',
    dir:
 'tool-skill',
    
source: 'packages/skill/to
ol-skill/src/index
.ts',
    requires: ['ctx.t
ools', 'ctx.agent
s', 'ctx.skills'],
    write
s: ['tool/call',
 'tool/result', 'user/message
 replacement ca
talogs via agent.inject()'],
 
   async mount
(ctx) {
      await ctx.plugin(
AgentRegistry
)
      await ctx.plugin(SkillRe
gistry)
    
  await ctx.plugin(SkillFileSyste
m, {
      
  dshHome: resolve(root, '.tmp/too
l-catalog/
.dsh'),
        agentsHome: resolve
(root, '.
tmp/tool-catalog/.agents'),
      })

      a
wait ctx.plugin(ToolSkill)
    },
  }
,
  {
 
   pkg: '@deepseek-ai/dsh-tool-session
-query
',
    dir: 'tool-session-query',
    s
ource
: 'packages/session-query/tool-session-q
uery
/src/index.ts',
    requires: ['ctx.tools
', 
'ctx.systemPrompt', 'ctx.sessionQuery', 'a
 c
alling Agent for workspace authority'],
   
 
writes: ['tool/call', 'tool/result'],
    as

ync mount(ctx) {
      await ctx.plugin(Sessi

onStore)
      await ctx.plugin(SqliteSessio
n
QueryEngine, { path: ':memory:' })
      aw
ai
t ctx.plugin(ToolSessionQuery)
    },
    
not
e:
      'The five read-only tools hide p
rovi
der cursors and authorize every result f
rom t
he immutable calling agent session. The
 packa
ge is opt-in; compositions that need e
nforced
 deadlines or bounded inline output a
lso moun
t the generic timeout or spill polic
ies.',
  
},
  {
    pkg: '@deepseek-ai/dsh-t
ool-subage
nt',
    dir: 'tool-subagent',
   
 source: 'p
ackages/subagent/tool-subagent/sr
c/index.ts',

    requires: ['ctx.tools', 'ct
x.subagents',
 'ctx.systemPrompt'],
    write
s: ['tool/call
', 'tool/result', 'child sessi
on events throu
gh the chosen provider'],
   
 shippedNames: [
'subagent', 'subagent_fork']
,
    async mount
(ctx) {
      await ctx.plu
gin(SubagentRuntim
e)
      registerCatalogSu
bagentProvider(ctx,
 'mock')
      await ctx.
plugin(ToolSubagent,
 { provider: 'mock' })
 
   },
    note:
     
 'The registered tool n
ame is the load-time `
toolName` config (defa
ult `subagent`); the sc
hema above is that de
fault. The shipped compo
sitions load this pa
ckage once per subagent b
ackend, so the mode
l additionally sees `subag
ent_fork` bound to
 the fork backend. Each ins
tance\'s descript
ion, `run_in_background` par
ameter, and syst
em-prompt policy follow its o
wn `backgroundM
ode` and `enableRunInBackgroun
d`, so the two
 shipped schemas are not identi
cal: `subagen
t` is `continuable` and defaults
 omitted cal
ls to background with automatic s
ettlement d
elivery, while `subagent_fork` sta
ys `one-sh
ot` and defaults them to foreground
 — see 
`packages/bundle/base/cordis.patch.y
ml` and 
`examples/acp-agent/cordis.yml`.',
  
},
  {

    pkg: '@deepseek-ai/dsh-tool-subage
nt-con
trol',
    dir: 'tool-subagent-control'
,
   
 source: {
      interrupt_agent: 'packa
ges/
subagent/tool-subagent-control/src/index.
ts'
,
      list_agents: 'packages/subagent/to
ol
-subagent-control/src/list-agents.ts',
    
 
 send_message: 'packages/subagent/tool-subag

ent-control/src/index.ts',
    },
    require

s: ['ctx.tools', 'ctx.subagents', 'ctx.agent
s
 and ctx.sessionProjections (list_agents on
ly
)'],
    writes: ['tool/call', 'tool/resul
t',
 'child session events through ctx.subage
nts'
],
    async mount(ctx) {
      await ct
x.plu
gin(SubagentRuntime)
      await ctx.pl
ugin(L
ocalJobRegistry)
      await ctx.plugi
n(Agent
Registry)
      await ctx.plugin(Sess
ionStore
)
      await ctx.plugin(SessionProj
ectionReg
istry)
      await ctx.plugin(ToolS
ubagentCon
trol)
      await ctx.plugin(ToolS
ubagentList
Agents)
    },
    note:
      'T
he globally 
named control tools over continu
able backgrou
nd subagents: provider-bound `t
ool-subagent` 
instances register distinct de
legation tools,
 while this package registers
 `send_message` 
and `interrupt_agent` once, 
plus `list_agents
` from its separately loade
d `/list-agents` p
lugin (whose catalog rows 
use the sessionProj
ections and live Agent re
gistries).',
  },
  
{
    pkg: '@deepseek-ai
/dsh-tool-subagent-re
port',
    dir: 'tool-s
ubagent-report',
    s
ource: 'packages/subag
ent/tool-subagent-repor
t/src/index.ts',
    
requires: ['ctx.subagent
s', 'ctx.systemPromp
t', 'a live continuable i
n-process child Age
nt'],
    writes: ['tool/c
all', 'tool/result
', 'a user-role message in 
the direct parent
 session'],
    async mount(
ctx) {
      awa
it ctx.plugin(AgentRegistry)

      await ctx
.plugin(SubagentRuntime)
     
 const { repor
tDelivery } = ToolSubagentRepor
t.Config({}) 
as { reportDelivery: SubagentRep
ortDelivery 
}
      await mountCatalogChildSc
ope(ctx, (c
hildCtx) => {
        ToolSubagent
Report.ins
tallReportTool(childCtx, ctx, repor
tDelivery
)
      })
    },
    scope: ctx => 
catalogC
hildScopes.get(ctx) as Agent,
    not
e:
    
  'Registered per continuable in-proce
ss chi
ld rather than globally, so this schema
 is v
isible only '
      + 'inside such a chi
ld a
nd survives its global `toolFilter`. The 
sam
e contribution installs the '
      + 'chi
ld
-scoped `tool:report` prompt section, which
 
this catalog does not render. The parent-fac

ing '
      + '`send_message` tool is install

ed independently.',
  },
  {
    pkg: '@deep
s
eek-ai/dsh-tool-jobs',
    dir: 'tool-jobs'
,

    source: 'packages/jobs/tool-jobs/src/i
nde
x.ts',
    requires: ['ctx.tools', 'ctx.j
obs'
, 'ctx.systemPrompt'],
    writes: ['too
l/cal
l', 'tool/result', 'user/message via ag
ent.in
ject() for background completion notic
es'],
 
   async mount(ctx) {
      await ctx
.plugin(
LocalJobRegistry)
      await ctx.pl
ugin(Tool
Tasks)
    },
    note:
      'The 
kind-agnos
tic background-job controller: bac
kground bas
h commands, PTY sends, and subage
nts are read
, listed, and killed through the
 same three t
ools. Loading the plugin attach
es the control
ler that arms producers\' `ctx
.jobs.start()`.
',
  },
  {
    pkg: '@deepse
ek-ai/dsh-tool-t
odo',
    dir: 'tool-todo',

    source: 'pack
ages/todo/tool-todo/src/ind
ex.ts',
    requir
es: ['ctx.tools', 'owning 
Agent session'],
  
  writes: ['tool/call', '
todo/write', 'tool/r
esult'],
    async mount
(ctx) {
      await c
tx.plugin(ToolTodo, { a
llowParallelInProgress
: true })
    },
    n
ote:
      'todo_write 
is session-owned stat
e; UIs render the latest
 todo/write event as
 a checklist. `allowParal
lelInProgress` is r
equired with no default, s
o the catalog stat
es its choice: `true`, whos
e description inv
ites several `in_progress` i
tems. A deployme
nt choosing `false` receives 
the same tool w
ith a description asking for e
xactly one act
ive task.',
  },
  {
    pkg: '
@deepseek-ai/
dsh-tool-workflow',
    dir: 'to
ol-workflow'
,
    source: 'packages/workflow/
tool-workfl
ow/src/index.ts',
    requires: ['
ctx.tools'
, 'ctx.workflowEngine', 'ctx.system
Prompt', 
'a calling Agent (exec.agent parents
 the scr
ipt children)'],
    writes: ['tool/c
all', '
tool/result'],
    async mount(ctx) {

      
// The tool injects `workflows`; boot t
he vm
 engine over a scripted
      // subagen
t pr
ovider to satisfy it. The schema does not
 de
pend on which
      // provider backs the 
en
gine.
      await ctx.plugin(SubagentRuntim
e
)
      registerCatalogSubagentProvider(ctx,

 'mock')
      await ctx.plugin(VmWorkflowEng

ine, { provider: 'mock' })
      await ctx.p
l
ugin(ToolWorkflow)
    },
  },
  {
    pkg:
 '
@deepseek-ai/dsh-tool-web',
    dir: 'tool
-we
b',
    source: 'packages/web/tool-web/sr
c/in
dex.ts',
    requires: ['ctx.tools', 'ct
x.web
', 'ctx.systemPrompt'],
    writes: ['t
ool/ca
ll', 'tool/result'],
    async mount(c
tx) {
 
     // Mount search and fetch provid
ers so b
oth tools register. Their schemas
  
    // do
 not depend on provider identity or
 availabil
ity.
      await ctx.plugin(WebRun
time)
     
 await ctx.plugin(WebSearchExa)
 
     await c
tx.plugin(WebFetchLocal)
      a
wait ctx.plug
in(ToolWeb)
    },
    note:
  
    'web_searc
h and web_fetch keep provider 
selection behin
d ctx.web so model-visible sc
hemas stay stabl
e across backend swaps.',
  
},
  {
    pkg: '
@deepseek-ai/dsh-tool-githu
b',
    dir: 'tool
-github',
    source: 'pac
kages/github/tool-g
ithub/src/index.ts',
    
requires: ['ctx.tool
s', 'a GitHub token at e
xecution time (GITHUB
_TOKEN or ~/.dsh/.crede
ntials.yaml)'],
    wr
ites: ['tool/call', 't
ool/result', 'remote Gi
tHub issues and pull 
requests'],
    async mo
unt(ctx) {
      // 
Registration is keyless: 
the token resolves 
only when a call executes.

      await ctx.p
lugin(ToolGithub)
    },
  
  note:
      'Gi
tHub REST tools shipped by t
he standard and 
team agent presets; issue and
 PR creation mu
tate the remote repository. Th
e schema harve
st needs no credential because 
the token is 
read at execution time, not at r
egistration.
',
  },
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
]

/** One package's cont
ribution to
 the catalog: its schemas plus att
ribution. 
*/
interface CatalogPackage {
  pkg
: string

  sources: Readonly<Record<string, s
tring>>

  requires: string[]
  writes: string
[]
  sh
ippedNames?: string[]
  schemas: ToolS
chema[
]
  /** A deployment note (see {@link T
oolPa
ckage.note}), rendered after the tools. 
*/
 
 note?: string
}

/** The whole catalog: 
one
 entry per booted tool package, in manifes
t 
order. */
export type ToolCatalog = Catalog
P
ackage[]

/**
 * Assert the boot manifest co

vers every shipped tool package on disk (a
 *

 `tool-*` leaf under `packages/`).
 * Bootin
g
 has no source declaration to enumerate, so
 t
his glob restores the
 * "a new tool canno
t b
e silently undocumented" guarantee: an un
list
ed package
 * fails the generator (and t
he fr
eshness gate) until it is added to
 * {
@link 
TOOL_PACKAGES}. Exported for a direct 
negativ
e test.
 *
 * `scanRoot` defaults to 
the repo
 root; a test may point it at a fixt
ure tree.

 */
export function assertManifest
Complete(p
ackages: ToolPackage[] = TOOL_PACK
AGES, scanR
oot: string = root): void {
  con
st onDisk = 
globSync('packages/*/tool-*', { 
cwd: scanRoot
 }).map(p => basename(p)).sort(
)
  const list
ed = new Set(packages.map(p =>
 p.dir))
  cons
t missing = onDisk.filter(dir
 => !listed.has(
dir))
  if (missing.length >
 0) {
    throw n
ew Error(
      `gen-tool-c
atalog: ${missing.
length} tool package(s) no
t in the boot manif
est: ${missing.join(', ')
}. `
      + 'Add ea
ch to TOOL_PACKAGES in s
cripts/gen-tool-catal
og.ts so its schema is 
catalogued.',
    )
  
}
}

/**
 * Assert one
 manifest entry actuall
y registered a tool.

 *
 * A tool package tha
t boots without regi
stering anything is a bro
ken boot, not
 * an
 empty catalog section. Th
e usual cause is a
n `inject` the entry's `mou
nt`
 * does not s
atisfy: cordis leaves the pl
ugin PENDING, ev
ery step here still
 * succee
ds, and the gen
erator writes a catalog missin
g that package
's tools —
 * with the freshn
ess gate gree
n on it, because the omission is
 now what th
e
 * generator produces. {@link a
ssertManife
stComplete} cannot see this: the
 
* package 
IS listed, it just contributed noth
ing.
 * @
param entry - the manifest entry tha
t was bo
oted.
 * @param harvested - how many 
schemas
 its boot registered.
 * @throws when 
the bo
ot registered no tool at all.
 */
expor
t fun
ction assertToolsHarvested(entry: ToolPa
ckag
e, harvested: number): void {
  if (harve
ste
d > 0) return
  throw new Error(
    `gen-
to
ol-catalog: ${entry.pkg} booted without reg
i
stering a single tool. `
    + 'Its plugin i

s most likely PENDING on a service this manif

est entry does not mount — '
    + `compar
e
 the plugin's inject with mount() and requi
re
s: ${entry.requires.join(', ')}.`,
  )
}


/**

 * Boot each tool package on a fresh Con
text
 and harvest its model-facing
 * schemas
. A f
resh Context per package keeps attribut
ion cl
ean (each entry's
 * schemas come from
 exactl
y that package) and isolates a boot f
ailure t
o its
 * own entry. Disposed after h
arvest so
 no executor/provider outlives the 
run.
 */
e
xport async function collectToolCa
talog(packa
ges: ToolPackage[] = TOOL_PACKAGE
S): Promise<
ToolCatalog> {
  assertManifestC
omplete(packa
ges)
  const catalog: ToolCatal
og = []
  for 
(const entry of packages) {
  
  const ctx = n
ew Context()
    // Dispose i
n `finally` so a
 throw from `mount`/`schemas
()` after earlier

    // plugins mounted sti
ll tears the conte
xt down (no leaked executo
r/provider
    // f
iber) — the repo's "dis
pose must reach quie
scence" rule.
    try {

      await ctx.plugi
n(SystemPrompt)
      a
wait ctx.plugin(ToolRu
ntime, entry.toolsConf
ig ?? {})
      await e
ntry.mount(ctx)
     
 const schemas = ctx.too
ls.schemas(entry.sco
pe?.(ctx)).sort((a, b) =>
 a.name.localeCompa
re(b.name))
      assertTo
olsHarvested(entry
, schemas.length)
      cat
alog.push({
     
   pkg: entry.pkg,
        s
ources: Object.f
romEntries(schemas.map(schema
 => [
         
 schema.name,
          toolSo
urce(entry, sc
hema.name),
        ])),
      
  requires: e
ntry.requires,
        writes: e
ntry.writes,

        schemas,
        ...entr
y.shippedNa
mes !== undefined ? { shippedNames
: entry.sh
ippedNames } : {},
        ...entry
.note !==
 undefined ? { note: entry.note } : 
{},
    
  })
    } finally {
      await ctx.
fiber.d
ispose()
    }
  }
  return catalog
}


/** R
esolve one harvested tool to the plugin
 sour
ce that registered it. */
function toolS
ourc
e(entry: ToolPackage, toolName: string): 
str
ing {
  if (typeof entry.source === 'strin
g'
) return entry.source
  const source = entr
y
.source[toolName]
  if (source === undefined

) {
    throw new Error(
      `gen-tool-cata

log: ${entry.pkg} has no source mapping for 
h
arvested tool ${toolName}`,
    )
  }
  ret
ur
n source
}

/** Render one tool's entry: n
ame
, description, JSON-Schema parameters, so
urce
. */
function renderTool(schema: ToolSch
ema, 
source: string): string[] {
  const out
 = [`#
## \`${schema.name}\``, '']
  if (sche
ma.desc
ription) out.push(schema.description,
 '')
  o
ut.push('```json', JSON.stringify(sc
hema.para
meters, null, 2), '```', '')
  out.
push(`Sour
ce: [\`${source}\`](../${source})`
, '')
  ret
urn out
}

function codeList(valu
es: string[]
 | undefined): string {
  return
 values?.leng
th ? values.map(value => `\`${v
alue}\``).join
(', ') : '-'
}

function table
Cell(value: str
ing | undefined): string {
  
return value ? v
alue.replace(/\|/g, '\\|').r
eplace(/\n/g, '<b
r>') : '-'
}

/** Render th
e full catalog (pu
re, deterministic given th
e manifest-ordered 
input). */
export functio
n render(catalog: To
olCatalog): string {
  c
onst lines: string[] 
= [
    '<!-- Generated
 by scripts/gen-tool-c
atalog.ts — do not e
dit by hand.',
    '   
  Run `pnpm run gen-t
ool-catalog` to regenera
te. -->',
    '',
  
  '# Tool Schema Catalog'
,
    '',
    'Ever
y model-facing tool a ship
ped plugin contrib
utes to `ctx.tools`: the `n
ame`, `descriptio
n`, and JSON-Schema `paramet
ers` the model r
eceives via the system-prompt
 assembly. It c
omplements the [subsystem page
s](subsystems/
core.md) (the types plus each p
age\'s genera
ted Cordis API region) — this 
page is the 
*tools* the agent is offered.',
 
   '',
    
'This file is GENERATED and verifi
ed fresh b
y `pnpm run verify-tool-catalog` (p
art of `d
oc-sync`) — do not edit it by hand
. Unlike
 the cordis catalog (a pure source-AS
T pass)
, this generator BOOTS each tool plugi
n on a
 real context and reads `ctx.tools.sche
mas()
`, because a tool schema is not statical
ly k
nowable (runtime-spread enums, concatenat
ed 
descriptions, config-driven names, raw-JSO
N-
Schema MCP tools). A completeness guard glo
b
s `packages/*/tool-*` and fails if any packa

ge is missing from the generator\'s boot mani

fest, so a new tool cannot be silently undoc
u
mented. See [the tool-schema-catalog Agent 
No
te](../.agents/notes/implemented/process/2
026
-07-02-tool-schema-catalog.md).',
    '',

   
 'Scope: shipped product tools under `pa
ckage
s/*/tool-*`, each booted with its DEFAU
LT con
fig, except where a Config field is RE
QUIRED 
with no default — there the generat
or must 
choose, and the per-package note rec
ords whic
h branch this page shows. The regis
tered tool
 NAME can be a load-time config (e
.g. `tool-s
ubagent`\'s `toolName`), so a dep
loyment may 
expose a package under a differe
nt or additio
nal name — a per-package note
 records those
 shipped aliases where they ex
ist. The `examp
les/` demo tools (e.g. `echo`
) are excluded, 
matching the cordis catalog\
's packages-only 
scope.',
    '',
    '## To
ol Package Map',
 
   '',
    'This table con
nects model-visible
 tool names to the plugin
 package and service
 seams behind them. Exac
t JSON Schemas follow
 in the package section
s below.',
    '',
   
 '| Tool package | Mod
el-visible names | Requ
ires | Writes / affec
ts | Shipped aliases | D
eployment note |',
 
   '| --- | --- | --- | -
-- | --- | --- |',

    ...catalog.map(entry =
> `| \`${entry.pkg
}\` | ${codeList(entry.sche
mas.map(schema =>
 schema.name))} | ${codeList
(entry.requires)
} | ${codeList(entry.writes)}
 | ${codeList(e
ntry.shippedNames)} | ${tableC
ell(entry.note
)} |`),
    '',
  ]
  for (cons
t entry of ca
talog) {
    lines.push(`<a id="
${githubSlug
(entry.pkg)}"></a>`, '', `## \`${
entry.pkg}\
``, '')
    for (const schema of e
ntry.schem
as) {
      // Collection validated
 that eve
ry harvested schema has a source.
  
    cons
t source = entry.sources[schema.name]
 as str
ing
      lines.push(...renderTool(sch
ema, s
ource))
    }
    if (entry.note) lines
.push
(entry.note, '')
  }
  return lines.join
('\n
')
}

/** CLI entry: default writes the c
ata
log, `--check` fails if the committed copy

 
* is stale. Guarded behind an entry-point c
h
eck so importing this module for
 * tests ne

ither regenerates the committed file nor call

s process.exit. */
async function main(): Pr
o
mise<void> {
  const content = render(await
 c
ollectToolCatalog())
  if (process.argv.in
clu
des('--check')) {
    let committed: stri
ng |
 null = null
    try {
      committed =
 read
FileSync(resolve(root, OUT), 'utf8')
  
  } ca
tch {
      // Only ENOENT (not yet ge
nerated
) is expected; a present-but-unreadab
le
     
 // file is not a state this repo pr
oduces. E
ither way the remedy is the
      /
/ same —
 regenerate — so treat a read fa
ilure as "s
tale".
      committed = null
   
 }
    if (c
ommitted === content) {
      co
nsole.log(`ge
n-tool-catalog: ${OUT} is up to
 date.`)
     
 process.exit(0)
    }
    con
sole.error(`gen
-tool-catalog: ${OUT} is stal
e. Run \`pnpm ru
n gen-tool-catalog\` and com
mit ${OUT}.`)
   
 const committedLines = com
mitted?.split('\n'
) ?? []
    const generate
dLines = content.sp
lit('\n')
    const lineC
ount = Math.max(comm
ittedLines.length, gener
atedLines.length)
   
 for (let index = 0; in
dex < lineCount; index
 += 1) {
      if (com
mittedLines[index] === 
generatedLines[index]
) continue
      console
.error(`gen-tool-cat
alog: first difference at
 line ${index + 1}`
)
      console.error(`  c
ommitted: ${JSON.s
tringify(committedLines[ind
ex])}`)
      con
sole.error(`  generated: ${J
SON.stringify(ge
neratedLines[index])}`)
     
 break
    }
  
  process.exit(1)
  }

  write
FileSync(resol
ve(root, OUT), content)
  conso
le.log(`gen-t
ool-catalog: wrote ${OUT}.`)
}


// Run only 
when invoked as a script, not whe
n imported 
by a test.
if (process.argv[1] && 
import.met
a.filename === resolve(process.argv
[1])) {
 
 await main()
}


