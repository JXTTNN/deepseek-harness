/**
 * Generate `THIRD_PARTY_NOTICES.md` from  the workspace manifests: every
 * external d ependency named by a workspace `package.json` , the vendored-package
 * manifest in `vendor /README.md`, the Python `pyproject.toml` file s, and the
 * pnpm patch list. License and re pository metadata come from the installed
 *  store, so the tree must be installed. `--chec k` verifies the committed
 * artifact. Tier p olicy and ownership live in
 * `.agents/notes /implemented/process/2026-07-30-generated-thi rd-party-notices.md`.
 */

import { existsSyn c, globSync, readdirSync, readFileSync, write FileSync } from 'node:fs'
import { resolve }  from 'node:path'
import * as yaml from 'js-ya ml'
import { parse as parseToml, type TomlTab leWithoutBigInt, type TomlValueWithoutBigInt  } from 'smol-toml'
import parseSpdx from 'spd x-expression-parse'

const root = resolve(imp ort.meta.dirname, '..')
const OUT = 'THIRD_PA RTY_NOTICES.md'

/** Dependency-declaration k inds a consumer resolves at runtime. */
const  RUNTIME_KINDS = ['dependencies', 'optionalDe pendencies'] as const
/** All manifest sectio ns that name an external package this file mu st disclose. */
const ALL_KINDS = ['dependenc ies', 'devDependencies', 'optionalDependencie s', 'peerDependencies'] as const

/**
 * Work space areas that never reach a user: reposito ry tooling and gates (the
 * root manifest),  test infrastructure, the documentation site,  the runnable
 * demo leaves, and the native l auncher's build workspace. A runtime
 * decla ration by anything outside these areas is a d isclosure-relevant
 * runtime dependency beca use any plugin package can be mounted from a  user's
 * `cordis.yml`.
 */
const DEV_ONLY_AR EAS = [
  'package.json',
  'packages/test-su pport/',
  'packages/test-support/client-runt ime/',
  'website/',
  'examples/',
  'native /',
] as const

/** First-party public native  packages: reachable at runtime but not third -party. */
const FIRST_PARTY = new Set([
  '@ deepseek-ai/node-addon-landlock-run',
  '@dee pseek-ai/node-addon-landlock-run-linux-arm64' ,
  '@deepseek-ai/node-addon-landlock-run-lin ux-x64',
])

/** Official SDK identity covere d by the project's narrow owner authorization . */
export const CLAUDE_AGENT_SDK_PACKAGE =  '@anthropic-ai/claude-agent-sdk'
const CLAUDE _PLATFORM_PACKAGE_PREFIX = `${CLAUDE_AGENT_SD K_PACKAGE}-`
const CLAUDE_PLATFORM_DECLARED_L ICENSE = 'SEE LICENSE IN LICENSE.md'

/**
 *  Whether a non-permissive runtime declaration  has an identity-scoped owner
 * authorization . This does not reclassify its terms as permi ssive.
 * @param name - exact npm package ide ntity.
 * @returns true only for the official  Claude Agent SDK package.
 */
export functio n isOwnerAuthorizedRuntime(name: string): boo lean {
  return name === CLAUDE_AGENT_SDK_PAC KAGE
}

/**
 * Metadata overrides where the i nstalled manifest is wrong or unreachable.
 *  Each entry documents why the store cannot an swer.
 */
const OVERRIDES: Record<string, { l icense?: string; repo?: string }> = {
  // Ru st workspaces publishing npm bins without `li cense` in package.json.
  'oxlint': { license : 'MIT', repo: 'https://github.com/oxc-projec t/oxc' },
  'oxlint-tsgolint': { license: 'MI T', repo: 'https://github.com/oxc-project/tsg olint' },
  // `license: SEE LICENSE IN LICEN SE`: the servers repo is mid MIT→Apache-2.0 
  // relicensing, so the effective terms are  per-contribution.
  '@modelcontextprotocol/s erver-everything': { license: 'MIT / Apache-2 .0', repo: 'https://github.com/modelcontextpr otocol/servers' },
  '@modelcontextprotocol/s erver-filesystem': { license: 'MIT / Apache-2 .0', repo: 'https://github.com/modelcontextpr otocol/servers' },
  // No repository field i n the published manifest.
  'node-addon-requi re-builtin': { repo: 'https://www.npmjs.com/p ackage/node-addon-require-builtin' },
}

/**
  * Python dependencies are few and named dire ctly in `pyproject.toml` files
 * without ins talled metadata to harvest, so license/repo a re recorded here and
 * the generator fails w hen a manifest names a package this map misse s.
 */
const PYTHON_METADATA: Record<string,  { license: string; repo: string; role: string  }> = {
  pydantic: { license: 'MIT', repo: ' https://github.com/pydantic/pydantic', role:  'runtime dependency of `deepseek-harness-sdk` ' },
  hatchling: { license: 'MIT', repo: 'ht tps://github.com/pypa/hatch', role: 'build ba ckend' },
  pytest: { license: 'MIT', repo: ' https://github.com/pytest-dev/pytest', role:  'test-only' },
}

type PythonMetadata = typeo f PYTHON_METADATA

/** Tools fetched by scrip ts at build time, keyed by the pin the script  owns. */
const BUILD_TIME_TOOLS = [
  {
     name: '@yao-pkg/pkg',
    license: 'MIT',
     repo: 'https://github.com/yao-pkg/pkg',
     role: 'invoked by `scripts/build-exe-for-pyth on-sdk.ts` to assemble the single-file SDK ru ntime executable',
    pinSource: 'scripts/bu ild-exe-for-python-sdk.ts',
  },
]

/** The ` package.json` fields this generator reads. */ 
export interface Manifest {
  name?: string
   version?: string
  private?: boolean
  lice nse?: string
  dependencies?: Record<string,  string>
  devDependencies?: Record<string, st ring>
  optionalDependencies?: Record<string,  string>
  peerDependencies?: Record<string,  string>
}

/** One disclosed external npm dep endency. */
interface ExternalDep {
  name: s tring
  license: string
  repo: string
  /**  True when some shipped workspace consumer rea ches it through runtime dependency edges. */
   runtime: boolean
}

/** Read and parse a wo rkspace-relative `package.json`. */
function  readManifest(rel: string): Manifest {
  retur n JSON.parse(readFileSync(resolve(root, rel),  'utf8')) as Manifest
}

/**
 * Manifest glob s, derived from the workspace declarations ra ther than listed
 * here, so a new member are a (`tools/*`) is read the day it is declared. 
 * @returns one glob per manifest-bearing lo cation, repository-relative.
 */
export funct ion manifestPatterns(rootMembers: readonly st ring[]): string[] {
  return [
    'package.j son',
    ...rootMembers.map(member => `${mem ber}/package.json`),
    // The demo leaves j oin the workspace through `examples/package.j son`, so
    // their own manifests are membe rs of nothing and no glob above reaches them. 
    'examples/*/package.json',
  ]
}

/** Th e `packages:` member globs declared by one pn pm workspace file. */
function workspaceMembe rs(rel: string): string[] {
  const declared  = (yaml.load(readFileSync(resolve(root, rel),  'utf8')) as { packages?: unknown }).packages 
  if (!Array.isArray(declared) || declared.l ength === 0) {
    throw new Error(`gen-third -party-notices: ${rel} declares no workspace  members; the manifest set cannot be derived.` )
  }
  return declared.map(member => String( member))
}

/**
 * Every workspace manifest,  keyed by repository-relative path, plus the s et of
 * workspace package names. Paths are n ormalized to `/` at ingestion: Node's
 * `fs. globSync` returns OS-native separators, and t he area matching in
 * `tierExternalDeps` com pares `/`-suffixed prefixes, so Windows backs lashes
 * would silently push dev-area manife sts into the runtime tier.
 */
function loadW orkspaceManifests(): { manifests: Map<string,  Manifest>; names: Set<string> } {
  const pa tterns = manifestPatterns(workspaceMembers('p npm-workspace.yaml'))
  const manifests = new  Map<string, Manifest>()
  const names = new  Set<string>()
  for (const pattern of pattern s) {
    for (const path of globSync(pattern,  { cwd: root })) {
      const normalized = p ath.replaceAll('\\', '/')
      const manifes t = readManifest(normalized)
      manifests. set(normalized, manifest)
      if (manifest. name !== undefined) names.add(manifest.name)
     }
  }
  if (manifests.size < 100) throw n ew Error(`gen-third-party-notices: only ${man ifests.size} workspace manifests found; the g lob set is stale.`)
  return { manifests, nam es }
}

type VirtualManifest = Manifest & {
   claudeCodeVersion?: string
  license?: strin g
  repository?: string | { url?: string }
   homepage?: string
}

/** One platform payload  declared by the official Claude Agent SDK. * /
export interface ClaudePlatformPayload {
   readonly name: string
  readonly version: str ing
}

/** Current SDK and CLI distribution f acts derived from the installed SDK manifest.  */
export interface ClaudeDistribution {
  r eadonly sdkVersion: string
  readonly claudeC odeVersion: string
  readonly payloads: Claud ePlatformPayload[]
}

function requiredManife stString(
  value: string | undefined,
  fiel d: string,
): string {
  if (value === undefi ned || value.length === 0) {
    throw new Er ror(`gen-third-party-notices: ${CLAUDE_AGENT_ SDK_PACKAGE} has no ${field}.`)
  }
  return  value
}

/**
 * Derive the official platform  payload set without a version or platform
 *  allowlist. Only identities in the SDK's own p ackage namespace are covered.
 * @param manif est - installed official SDK manifest.
 * @re turns current SDK, CLI, and optional platform  payload facts.
 */
export function claudeDis tributionFromManifest(
  manifest: VirtualMan ifest,
): ClaudeDistribution {
  if (manifest .name !== CLAUDE_AGENT_SDK_PACKAGE) {
    thr ow new Error(
      `gen-third-party-notices:  expected ${CLAUDE_AGENT_SDK_PACKAGE} manifes t, got ${JSON.stringify(manifest.name)}.`,
     )
  }
  const sdkVersion = requiredManifest String(manifest.version, 'version')
  const c laudeCodeVersion = requiredManifestString(
     manifest.claudeCodeVersion,
    'claudeCode Version',
  )
  const entries = Object.entrie s(manifest.optionalDependencies ?? {})
  if ( entries.length === 0) {
    throw new Error(
       `gen-third-party-notices: ${CLAUDE_AGEN T_SDK_PACKAGE} declares no optional platform  payloads.`,
    )
  }
  const payloads = entr ies.map(([name, version]) => {
    if (!name. startsWith(CLAUDE_PLATFORM_PACKAGE_PREFIX)) { 
      throw new Error(
        `gen-third-pa rty-notices: ${CLAUDE_AGENT_SDK_PACKAGE} opti onal dependency ${name} is outside its author ized platform-payload identity.`,
      )
     }
    return {
      name,
      version: re quiredManifestString(version, `${name} option al dependency version`),
    }
  }).sort((lef t, right) => left.name.localeCompare(right.na me))
  return { sdkVersion, claudeCodeVersion , payloads }
}

/**
 * Resolve one package's  manifest inside a pnpm virtual store. The pre fix scan
 * matches ordinary `@scope+name@ver sion` directory names; pnpm 11 truncates
 * l ong names (a peer-suffixed name past the leng th limit becomes
 * `<prefix>_<hash>`), so a  content scan falls back over the whole store  when
 * the prefix misses.
 *
 * @param virtu al - the `.pnpm` virtual store directory to s can.
 * @param name - the external package na me, exactly as `node_modules` spells it.
 * @ returns the parsed manifest, or `undefined` w hen neither the prefix match
 *   nor the con tent scan finds the package's `package.json`. 
 */
export function virtualManifest(virtual:  string, name: string): VirtualManifest | und efined {
  const prefix = `${name.replace('/' , '+')}@`
  const entry = readdirSync(virtual ).find(dir => dir.startsWith(prefix))
  if (e ntry !== undefined) {
    return JSON.parse(r eadFileSync(resolve(virtual, entry, 'node_mod ules', name, 'package.json'), 'utf8')) as Vir tualManifest
  }
  for (const dir of readdirS ync(virtual)) {
    const candidate = resolve (virtual, dir, 'node_modules', name, 'package .json')
    if (existsSync(candidate)) {
       return JSON.parse(readFileSync(candidate, ' utf8')) as VirtualManifest
    }
  }
  return  undefined
}

/** Resolve one installed exter nal package manifest from either pnpm store.  */
function installedManifest(name: string):  VirtualManifest | undefined {
  let manifest:  (Manifest & { license?: string; repository?:  string | { url?: string }; homepage?: string  }) | undefined
  // Workspace-local link far ms can expose a dependency that is not linked  at
  // the repository root; both are backed  by the root workspace's lockfile.
  for (con st store of ['node_modules', 'native/landlock -run/node_modules']) {
    const direct = res olve(root, store, name, 'package.json')
    i f (existsSync(direct)) {
      manifest = JSO N.parse(readFileSync(direct, 'utf8')) as type of manifest
      break
    }
    const virtu al = resolve(root, store, '.pnpm')
    if (!e xistsSync(virtual)) continue
    manifest = v irtualManifest(virtual, name)
    if (manifes t !== undefined) break
  }
  return manifest
 }

/** License and repository URL for an inst alled external package, from the pnpm store.  */
function installedMetadata(name: string):  { license: string; repo: string } {
  const o verride = OVERRIDES[name]
  const manifest =  installedManifest(name)
  const license = ove rride?.license ?? manifest?.license
  const r awRepo = typeof manifest?.repository === 'str ing' ? manifest.repository : manifest?.reposi tory?.url ?? manifest?.homepage
  const repo  = override?.repo ?? normalizeRepo(rawRepo)
   if (license === undefined || repo === undefin ed) {
    throw new Error(`gen-third-party-no tices: cannot resolve ${license === undefined  ? 'license' : 'repository'} for ${name}; run  \`pnpm install\`, or add an OVERRIDES entry. `)
  }
  return { license, repo }
}

function  collectClaudeDistribution(): ClaudeDistribut ion {
  const manifest = installedManifest(CL AUDE_AGENT_SDK_PACKAGE)
  if (manifest === un defined) {
    throw new Error(
      `gen-th ird-party-notices: cannot resolve ${CLAUDE_AG ENT_SDK_PACKAGE}; run \`pnpm install\`.`,
     )
  }
  const distribution = claudeDistribut ionFromManifest(manifest)
  let installedPayl oads = 0
  for (const payload of distribution .payloads) {
    const installed = installedM anifest(payload.name)
    if (installed === u ndefined) continue
    installedPayloads += 1 
    if (
      installed.name !== payload.na me
      || installed.version !== payload.ver sion
      || installed.license !== CLAUDE_PL ATFORM_DECLARED_LICENSE
    ) {
      throw n ew Error(
        `gen-third-party-notices: i nstalled ${payload.name} does not match its S DK-declared version and ${CLAUDE_PLATFORM_DEC LARED_LICENSE} license field.`,
      )
    } 
  }
  if (installedPayloads === 0) {
    thr ow new Error(
      'gen-third-party-notices:  no SDK-declared Claude platform payload is i nstalled; install optional dependencies befor e regenerating.',
    )
  }
  return distribu tion
}

/** Normalize a manifest repository/h omepage value to a browsable https URL. */
fu nction normalizeRepo(raw: string | undefined) : string | undefined {
  if (raw === undefine d || raw === '') return undefined
  let url =  raw
    .replace(/^git\+ssh:\/\/git@/, 'http s://')
    .replace(/^git\+/, '')
    .replac e(/^git:\/\//, 'https://')
    .replace(/^git hub:/, 'https://github.com/')
    .replace(/\ .git$/, '')
  if (!url.startsWith('http')) ur l = `https://github.com/${url}`
  return url
 }

/**
 * External npm dependencies, tiered b y which workspace area declares them at
 * ru ntime: a package is runtime when any manifest  outside `DEV_ONLY_AREAS`
 * names it in `dep endencies`/`optionalDependencies`. A package  declared only
 * by tooling, test infrastruct ure, the website, or the demo leaves — what ever
 * the declaring section is called — i s development-only.
 */
function collectNpmDe ps(): ExternalDep[] {
  const { manifests, na mes } = loadWorkspaceManifests()
  return [.. .tierExternalDeps(manifests, names)]
    .fil ter(([name]) => !FIRST_PARTY.has(name))
    . sort(([a], [b]) => a.localeCompare(b))
    .m ap(([name, runtime]) => ({ name, ...installed Metadata(name), runtime }))
}

/**
 * Tier ev ery external dependency the workspace declare s.
 * @param manifests - workspace manifests  keyed by repository-relative path.
 * @param  names - every workspace package name, which n ever counts as external.
 * @returns each ext ernal package mapped to whether it is a runti me dependency.
 */
export function tierExtern alDeps(manifests: Map<string, Manifest>, name s: Set<string>): Map<string, boolean> {
  con st tiers = new Map<string, boolean>()
  // `t sx` is runtime by fiat: the root source-run s cripts execute through its ESM hook.
  tiers. set('tsx', true)
  for (const [path, manifest ] of manifests) {
    const devOnly = DEV_ONL Y_AREAS.some(area => (area.endsWith('/') ? pa th.startsWith(area) : path === area))
    for  (const kind of ALL_KINDS) {
      for (const  [dep, range] of Object.entries(manifest[kind ] ?? {})) {
        if (names.has(dep) || ran ge.startsWith('workspace:')) continue
         const runtime = !devOnly && (RUNTIME_KINDS a s readonly string[]).includes(kind)
        t iers.set(dep, (tiers.get(dep) ?? false) || ru ntime)
      }
    }
  }
  return tiers
}

/* * A vendored package row parsed out of the `v endor/README.md` manifest table. */
export in terface VendoredRow {
  npmName: string
  /**  The name this package carries upstream; MIT  attribution names the fork's origin, not our  scope. */
  upstreamName: string
  upstream:  string
}

/**
 * Parse the vendored-package m anifest table out of `vendor/README.md`.
 * @ param text - the complete `vendor/README.md`  contents.
 * @returns one row per manifest-ta ble entry, in table order.
 */
export functio n parseVendoredRows(text: string): VendoredRo w[] {
  const rows: VendoredRow[] = []
  for  (const line of text.split('\n')) {
    const  match = new RegExp(String.raw`^\| \x60\S+\/\x 60 \| \x60([^\x60]+)\x60 \| \x60([^\x60]+)\x6 0 \| \S+ \| `
      + String.raw`(https:\/\/\ S+?)(?: \([^)]*\))? \| \x60[0-9a-f]+\x60 \|$` ).exec(line)
    if (match === null) continue 
    const [, npmName, upstreamName, upstream ] = match
    if (npmName === undefined || up streamName === undefined || upstream === unde fined) continue
    rows.push({ npmName, upst reamName, upstream })
  }
  return rows
}

/* *
 * Parse the vendored manifest table and co nfirm it accounts for every vendored
 * direc tory. The `vendor/` tree — not the table � � is the set that must be
 * disclosed, so a  row that stops matching the table format is a  hard error
 * rather than a package that qui etly vanishes from the notices.
 */
function  collectVendored(): VendoredRow[] {
  const ro ws = parseVendoredRows(readFileSync(resolve(r oot, 'vendor/README.md'), 'utf8'))
  const on Disk = new Map<string, string>()
  for (const  entry of readdirSync(resolve(root, 'vendor') , { withFileTypes: true })) {
    if (!entry. isDirectory()) continue
    const manifest =  readManifest(`vendor/${entry.name}/package.js on`)
    if (manifest.name !== undefined) onD isk.set(manifest.name, entry.name)
  }

  con st parsed = new Set(rows.map(row => row.npmNa me))
  const missing = [...onDisk.keys()].fil ter(name => !parsed.has(name))
  if (missing. length > 0) {
    throw new Error(`gen-third- party-notices: vendor/README.md has no manife st-table row for ${missing.join(', ')}; its t able format changed or the sync is incomplete .`)
  }
  for (const row of rows) {
    const  dir = onDisk.get(row.npmName)
    if (dir == = undefined) throw new Error(`gen-third-party -notices: vendored package ${row.npmName} fro m vendor/README.md has no vendor/ directory.` )
    const license = readManifest(`vendor/${ dir}/package.json`).license
    if (license ! == 'MIT') {
      throw new Error(`gen-third- party-notices: vendored ${row.npmName} declar es license ${JSON.stringify(license)}; the ve ndored section assumes MIT throughout.`)
     }
  }
  return rows
}

/** Whether a parsed T OML value is a table rather than an array or  scalar. */
function isTomlTable(value: TomlVa lueWithoutBigInt | undefined): value is TomlT ableWithoutBigInt {
  return value !== undefi ned && typeof value === 'object' && !Array.is Array(value)
}

/** Parse one PEP 508 require ment string into its distribution name. */
fu nction parsePythonRequirement(requirement: st ring): string {
  const name = /^\s*([a-zA-Z] [a-zA-Z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=! ~;@].*)?$/.exec(requirement)?.[1]
  if (name  === undefined) {
    throw new Error(`gen-thi rd-party-notices: cannot read a distribution  name from the requirement ${JSON.stringify(re quirement)}.`)
  }
  return name
}

/** Add t he string requirements from one parsed TOML a rray. */
function collectPythonRequirementArr ay(
  names: string[],
  value: TomlValueWith outBigInt | undefined,
  location: string,
   allowGroupIncludes = false,
): void {
  if (v alue === undefined) return
  if (!Array.isArr ay(value)) {
    throw new Error(`gen-third-p arty-notices: ${location} must be an array.`) 
  }
  for (const item of value) {
    if (ty peof item === 'string') {
      names.push(pa rsePythonRequirement(item))
      continue
     }
    if (allowGroupIncludes && isTomlTable (item) && typeof item['include-group'] === 's tring' && Object.keys(item).length === 1) {
       continue
    }
    throw new Error(`gen- third-party-notices: ${location} contains an  unsupported requirement entry.`)
  }
}

/** R ead an optional TOML table and reject a prese nt non-table value. */
function optionalTomlT able(value: TomlValueWithoutBigInt | undefine d, location: string): TomlTableWithoutBigInt  | undefined {
  if (value === undefined || is TomlTable(value)) return value
  throw new Er ror(`gen-third-party-notices: ${location} mus t be a table.`)
}

/**
 * Parse a `pyproject. toml` project identity and every requirement  it declares:
 * `requires` under
 * `[build-s ystem]`, `dependencies` under `[project]`, an d every key under
 * `[project.optional-depen dencies]` and `[dependency-groups]`. A TOML p arser
 * owns comments, quoted keys, escapes,  and array boundaries; unsupported
 * require ment forms fail instead of disappearing from  the notices.
 * @param text - the complete `p yproject.toml` contents.
 * @returns the loca l project name and declared requirement names .
 */
function parsePyproject(text: string):  { projectName?: string; requirements: string[ ] } {
  const names: string[] = []
  const do cument = parseToml(text, { integersAsBigInt:  false })
  const buildSystem = optionalTomlTa ble(document['build-system'], '[build-system] ')
  const project = optionalTomlTable(docume nt.project, '[project]')
  const projectName  = project?.name
  if (projectName !== undefin ed && typeof projectName !== 'string') {
     throw new Error('gen-third-party-notices: [pr oject].name must be a string.')
  }
  collect PythonRequirementArray(names, buildSystem?.re quires, '[build-system].requires')
  collectP ythonRequirementArray(names, project?.depende ncies, '[project].dependencies')

  const opt ional = optionalTomlTable(project?.['optional -dependencies'], '[project.optional-dependenc ies]')
  for (const [group, requirements] of  Object.entries(optional ?? {})) {
    collect PythonRequirementArray(names, requirements, ` [project.optional-dependencies].${group}`)
   }

  const groups = optionalTomlTable(documen t['dependency-groups'], '[dependency-groups]' )
  for (const [group, requirements] of Objec t.entries(groups ?? {})) {
    collectPythonR equirementArray(names, requirements, `[depend ency-groups].${group}`, true)
  }
  return pr ojectName === undefined
    ? { requirements:  names }
    : { projectName, requirements: n ames }
}

/**
 * Read every requirement name  declared by one `pyproject.toml`.
 * @param t ext - the complete `pyproject.toml` contents. 
 * @returns each declared requirement's dist ribution name, in file order.
 */
export func tion parsePyprojectRequirements(text: string) : string[] {
  return parsePyproject(text).re quirements
}

/** Normalize a Python distribu tion name according to the packaging name rul e. */
function normalizePythonDistributionNam e(name: string): string {
  return name.toLow erCase().replace(/[-_.]+/g, '-')
}

/**
 * Re solve external Python dependencies after excl uding local project names.
 * @param pyprojec ts - complete local `pyproject.toml` contents .
 * @param metadata - disclosure metadata fo r every external dependency.
 * @returns disc losed dependencies in normalized name order.
  */
export function collectPythonDependencies (
  pyprojects: string[],
  metadata: PythonM etadata = PYTHON_METADATA,
): { name: string;  license: string; repo: string; role: string  }[] {
  const parsed = pyprojects.map(parsePy project)
  const firstParty = new Set(parsed. flatMap(({ projectName }) => (
    projectNam e === undefined ? [] : [normalizePythonDistri butionName(projectName)]
  )))
  const found  = new Set(parsed
    .flatMap(({ requirements  }) => requirements.map(normalizePythonDistri butionName))
    .filter(name => !firstParty. has(name)))
  return [...found].sort((a, b) = > a.localeCompare(b)).map((name) => {
    con st entry = metadata[name]
    if (entry === u ndefined) throw new Error(`gen-third-party-no tices: python dependency ${name} is missing f rom PYTHON_METADATA.`)
    return { name, ... entry }
  })
}

/** Direct Python dependencie s named by the `pyproject.toml` manifests und er `python/`. */
function collectPython(): {  name: string; license: string; repo: string;  role: string }[] {
  const manifests = globSy nc('python/*/pyproject.toml', { cwd: root })
   if (manifests.length === 0) throw new Error ('gen-third-party-notices: no python/*/pyproj ect.toml found; the Python tree moved.')
  re turn collectPythonDependencies(manifests.map( path => readFileSync(resolve(root, path), 'ut f8')))
}

/** pnpm-patched external packages,  from `pnpm-workspace.yaml`. */
function coll ectPatched(): { spec: string; patch: string } [] {
  const workspace = yaml.load(readFileSy nc(resolve(root, 'pnpm-workspace.yaml'), 'utf 8')) as { patchedDependencies?: Record<string , string> }
  return Object.entries(workspace .patchedDependencies ?? {}).map(([spec, patch ]) => ({ spec, patch }))
}

/** Verify each b uild-time tool pin still appears in its ownin g script. */
function verifyBuildTimePins():  void {
  for (const tool of BUILD_TIME_TOOLS)  {
    const text = readFileSync(resolve(root , tool.pinSource), 'utf8')
    if (!text.incl udes(tool.name)) {
      throw new Error(`gen -third-party-notices: ${tool.pinSource} no lo nger references ${tool.name}; update BUILD_TI ME_TOOLS.`)
    }
  }
}

/** SPDX identifiers  this project may ship without further review . */
const PERMISSIVE_LICENSES = new Set(['MI T', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'A pache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', ' BlueOak-1.0.0', 'Python-2.0'])

/** Evaluate  a parsed SPDX expression under the repository 's license policy. */
function isPermissiveSp dx(expression: ReturnType<typeof parseSpdx>):  boolean {
  if ('conjunction' in expression)  {
    return expression.conjunction === 'and '
      ? isPermissiveSpdx(expression.left) & & isPermissiveSpdx(expression.right)
      :  isPermissiveSpdx(expression.left) || isPermis siveSpdx(expression.right)
  }
  return expre ssion.plus !== true
    && expression.excepti on === undefined
    && PERMISSIVE_LICENSES.h as(expression.license)
}

/**
 * Whether an S PDX expression grants terms this project may  ship under.
 * `OR` needs one permissive alte rnative, because the consumer chooses; `AND`
  * needs all of them, because every obligatio n applies. Anything that is not a
 * recogniz ed permissive identifier — copyleft, an exc eption clause, or a
 * license this list has  never seen — evaluates to false, so an unfa miliar
 * expression fails closed rather than  passing on a partial match.
 * @param licens e - the SPDX expression from the package mani fest.
 * @returns true when the expression's  obligations are all permissive.
 */
export fu nction isPermissive(license: string): boolean  {
  // Some npm manifests use a slash for a  choice despite SPDX requiring `OR`.
  const n ormalized = license.replace(/\s*\/\s*/g, ' OR  ').trim()
  try {
    return isPermissiveSpd x(parseSpdx(normalized))
  } catch {
    retu rn false
  }
}

/**
 * Render the sentence th at isolates non-permissive development toolin g, or
 * nothing at all when every developmen t dependency is permissive.
 * @param deps -  development dependencies whose license is not  permissive.
 * @returns the paragraph to pla ce after the development table.
 */
function  renderNonPermissiveNote(deps: ExternalDep[]):  string {
  if (deps.length === 0) return ''
   const named = deps.map(dep => `\`${dep.name }\` (${dep.license})`)
  const subject = name d.length === 1 ? named[0] : `${named.slice(0,  -1).join(', ')} and ${named.at(-1)}`
  retur n `\n${subject} ${named.length === 1 ? 'runs'  : 'run'} only as development tooling; their  code is not linked into or distributed with a ny DeepSeek Harness artifact.\n`
}

/** Rende r one npm dependency table. */
function rende rNpmTable(deps: ExternalDep[]): string {
  co nst lines = ['| Package | License |', '| ---  | --- |']
  for (const dep of deps) lines.pus h(`| [\`${dep.name}\`](${dep.repo}) | ${dep.l icense} |`)
  return lines.join('\n')
}

func tion renderClaudeDistribution(
  distribution : ClaudeDistribution | undefined,
): string { 
  if (distribution === undefined) return ''
   const rows = distribution.payloads.map(payl oad =>
    `| [\`${payload.name}\`](https://w ww.npmjs.com/package/${payload.name}) | ${pay load.version} | ${CLAUDE_PLATFORM_DECLARED_LI CENSE} |`,
  )
  return `
## Official Claude  Code platform payloads

The project owner aut horizes distribution of every version of the  official \`${CLAUDE_AGENT_SDK_PACKAGE}\` pack age and the official Claude Code CLI/platform  payloads that each version declares through  \`optionalDependencies\`. This identity-scope d authorization does not classify their decla red terms as permissive and does not cover an y unrelated runtime package; version, declare d-license, and payload-set changes still requ ire the ordinary dependency, lockfile, compat ibility, terms, and notices review.

The inst alled SDK ${distribution.sdkVersion} declares  the following optional platform packages. Ea ch carries the official Claude Code ${distrib ution.claudeCodeVersion} executable; the pack age identities and versions come from the SDK  manifest, while the declared license field i s verified against the platform payload insta lled for the current host.

| Optional platfo rm package | Version | Declared license |
| - -- | --- | --- |
${rows.join('\n')}
`
}

/**
  * Render the complete notices document.
 * @ returns the exact bytes `THIRD_PARTY_NOTICES. md` must hold.
 */
export function render():  string {
  verifyBuildTimePins()
  const npm  = collectNpmDeps()
  const runtimeDeps = npm. filter(dep => dep.runtime)
  const devDeps =  npm.filter(dep => !dep.runtime)
  const vendo red = collectVendored()
  const python = coll ectPython()
  const patched = collectPatched( )
  const claudeDistribution = runtimeDeps.so me(
    dep => dep.name === CLAUDE_AGENT_SDK_ PACKAGE,
  )
    ? collectClaudeDistribution( )
    : undefined

  const nonPermissiveDev =  devDeps.filter(dep => !isPermissive(dep.lice nse))
  // A copyleft license reaching a ship ped surface is a distribution decision,
  //  not a rendering detail; the notices cannot qu ietly absorb it.
  const nonPermissiveRuntime  = runtimeDeps.filter(dep =>
    !isPermissiv e(dep.license)
    && !isOwnerAuthorizedRunti me(dep.name),
  )
  if (nonPermissiveRuntime. length > 0) {
    throw new Error(`gen-third- party-notices: runtime ${nonPermissiveRuntime .map(dep => `${dep.name} (${dep.license})`).j oin(', ')} is not a permissive license; revie w the distribution terms and record the decis ion before regenerating.`)
  }
  const patche dLines = patched.map(({ spec, patch }) => `-  \`${spec}\` — [\`${patch}\`](${patch})`)

   return `<!-- Generated by scripts/gen-third- party-notices.ts — do not edit by hand.
      Run \`pnpm run gen-third-party-notices\` to  regenerate. -->

# Third-Party Notices

Deep Seek Harness is licensed under [MIT](LICENSE) . It depends on the third-party software list ed below. Each project remains under its own  license; nothing in this file changes those t erms.

This file lists **direct** dependencie s declared by the workspace and the explicitl y disclosed official Claude platform payload  closure. It is generated from the workspace m anifests by \`scripts/gen-third-party-notices .ts\`: a pre-commit hook regenerates it whene ver a staged file changes one of its inputs,  and \`scripts/gen-third-party-notices.spec.ts \` asserts in the test lane that the committe d bytes match. Deleting a manifest runs no ho ok, so that case is caught by the assertion i nstead. Run \`pnpm run verify-third-party-not ices\` for the standalone check.

The complet e npm transitive closure, including the Landl ock launcher workspace, is recorded with exac t pinned versions in [\`pnpm-lock.yaml\`](pnp m-lock.yaml) — inspect it with \`pnpm licen ses list\`. The Python closure is recorded se parately in [\`python/sdk/uv.lock\`](python/s dk/uv.lock).

## Vendored source (\`vendor/\` )

The Cordis framework and its foundation li braries are source-vendored into this reposit ory rather than consumed from npm, and republ ished under the \`@deepseek-ai\` scope. All a re MIT-licensed; each directory preserves its  upstream \`LICENSE\` file. Exact upstream co mmits and local modifications are recorded in  [\`vendor/README.md\`](vendor/README.md).

|  Package | Upstream name | Upstream | License  |
| --- | --- | --- | --- |
${vendored.map(r ow => `| \`${row.npmName}\` | \`${row.upstrea mName}\` | [${row.upstream.replace('https://' , '')}](${row.upstream}) | MIT |`).join('\n') }

## Runtime npm dependencies

External pack ages that a workspace package resolves at run time. The tier covers every plugin a user can  mount from \`cordis.yml\` — not only what  the \`dsh\` CLI, Web UI, and Python SDK runti me load by default.

${renderNpmTable(runtime Deps)}

pnpm applies local patches to the fol lowing packages at install time, so shipped a rtifacts carry modified copies; each patch fi le is the complete record of the modification :

${patchedLines.join('\n')}
${renderClaudeD istribution(claudeDistribution)}

## Developm ent-only npm dependencies

External packages  **directly declared** only by repository tool ing, test infrastructure, the documentation s ite, the demo leaves, or the native launcher' s build workspace. No shipped surface names t hem itself. A package here may still be pulle d in transitively by a runtime dependency —  \`pnpm-lock.yaml\` is the authority on the f ull closure — so this tier records who decl ares a package, not what a build ultimately b undles.

${renderNpmTable(devDeps)}
${renderN onPermissiveNote(nonPermissiveDev)}
## Python  SDK dependencies (\`python/\`)

Direct depen dencies of the \`pyproject.toml\` manifests,  plus \`uv\` as the development workflow tool. 

| Package | License | Role |
| --- | --- |  --- |
${python.map(dep => `| [\`${dep.name}\` ](${dep.repo}) | ${dep.license} | ${dep.role}  |`).join('\n')}
| [\`uv\`](https://github.co m/astral-sh/uv) | MIT / Apache-2.0 | developm ent workflow tool |

## Fetched at build time 

| Package | License | Role |
| --- | --- |  --- |
${BUILD_TIME_TOOLS.map(tool => `| [\`${ tool.name}\`](${tool.repo}) | ${tool.license}  | ${tool.role} |`).join('\n')}

## First-par ty native packages

\`@deepseek-ai/node-addon -landlock-run\` (and its platform packages) i s built and released from this repository und er BSD 3-Clause. It is listed here for comple teness; it is first-party, not third-party.
` 
}

/** CLI entry: default writes the notices , `--check` fails if the committed copy
 * is  stale. Guarded behind an entry-point check s o importing this module for
 * tests neither  regenerates the committed file nor calls proc ess.exit. */
function main(): void {
  const  content = render()
  if (process.argv.include s('--check')) {
    let committed: string | n ull = null
    try {
      committed = readFi leSync(resolve(root, OUT), 'utf8')
    } catc h {
      // Only ENOENT (not yet generated)  is expected; a present-but-unreadable
      / / file is not a state this repo produces, and  the remedy is the same.
      committed = nu ll
    }
    if (committed === content) {
       console.log(`gen-third-party-notices: ${OU T} is up to date.`)
      process.exit(0)
     }
    console.error(`gen-third-party-notices : ${OUT} is stale. Run \`pnpm run gen-third-p arty-notices\` and commit ${OUT}.`)
    proce ss.exit(1)
  }

  writeFileSync(resolve(root,  OUT), content)
  console.log(`gen-third-part y-notices: wrote ${OUT}.`)
}

// Run only whe n invoked as a script, not when imported by a  test.
if (process.argv[1] !== undefined && i mport.meta.filename === resolve(process.argv[ 1])) {
  main()
}
 