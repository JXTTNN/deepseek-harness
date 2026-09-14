/**
 * Dependency graph analysis tool: analyses project dependency graphs to
 * visualise circular dependencies, unused dependencies, and version conflicts.
 *
 * The `dependency_graph` tool supports four actions:
 *  - `"analyze"`   → return the complete dependency graph (nodes + edges)
 *  - `"cycles"`    → detect circular dependencies via DFS
 *  - `"unused"`    → detect dependencies declared but never imported
 *  - `"conflicts"` → detect version conflicts across the dependency tree
 *
 * Supported package managers: npm, pnpm, yarn (package.json), pip
 * (requirements.txt / pyproject.toml), cargo (Cargo.toml). The manager is
 * auto-detected from the lockfile / manifest present in the workspace root.
 *
 * @module @deepseek-ai/dsh-tool-dependency-graph
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool as _defineTool } from '@deepseek-ai/dsh-tools'
const defineTool = _defineTool as any

export const name = 'tool-dependency-graph'
export const inject = ['tools']

/** A graph node. */
interface GraphNode {
  name: string
  version: string
  type: 'prod' | 'dev' | 'peer'
}

/** A graph edge. */
interface GraphEdge {
  from: string
  to: string
}

/** A detected issue. */
interface GraphIssue {
  type: 'cycle' | 'unused' | 'conflict'
  description: string
  packages?: string[]
}

/** The analysis result. */
interface GraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  issues: GraphIssue[]
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo'
type Action = 'analyze' | 'cycles' | 'unused' | 'conflicts'

/**
 * Register the `dependency_graph` tool that analyses project dependency
 * graphs.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'dependency_graph',
    description:
      'Analyse project dependency graph: detect circular dependencies, unused '
      + 'dependencies, and version conflicts. Supports npm/pnpm/yarn '
      + '(package.json), pip (requirements.txt/pyproject.toml), and cargo '
      + '(Cargo.toml). Actions: "analyze" (full graph), "cycles", "unused", '
      + '"conflicts". Returns nodes, edges, and issues.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['analyze', 'cycles', 'unused', 'conflicts'],
        description: 'Analysis action to perform.',
      },
      packageManager: {
        type: 'string',
        enum: ['npm', 'pnpm', 'yarn', 'pip', 'cargo'],
        description: 'Package manager. Auto-detected if omitted.',
      },
      scope: {
        type: 'string',
        description: 'Analysis scope as a path glob. Default: entire workspace.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const action: Action = args.action
      const root = process.cwd()
      const pm: PackageManager = args.packageManager ?? detectPackageManager(root)
      const scope: string | undefined = args.scope

      const graph = buildGraph(root, pm, scope)

      switch (action) {
        case 'analyze':
          return graph
        case 'cycles':
          return { ...graph, issues: detectCycles(graph) }
        case 'unused':
          return { ...graph, issues: detectUnused(root, graph, pm, scope) }
        case 'conflicts':
          return { ...graph, issues: detectConflicts(graph) }
        default:
          return graph
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

/** Detect the package manager from lockfiles / manifests. */
function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  if (existsSync(join(root, 'package.json'))) return 'npm'
  if (existsSync(join(root, 'Cargo.lock')) || existsSync(join(root, 'Cargo.toml'))) return 'cargo'
  if (existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'pyproject.toml'))) return 'pip'
  return 'npm'
}

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

/** Build the dependency graph by scanning manifest files. */
function buildGraph(root: string, pm: PackageManager, scope: string | undefined): GraphResult {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const seenNodes = new Set<string>()

  const addNode = (name: string, version: string, type: GraphNode['type']): void => {
    const key = `${name}@${version}`
    if (!seenNodes.has(key)) {
      seenNodes.add(key)
      nodes.push({ name, version, type })
    }
  }

  if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn') {
    // Find all package.json files (workspace packages).
    const pkgFiles = findFiles(root, 'package.json', scope, ['node_modules', '.git'])
    for (const file of pkgFiles) {
      let pkg: any
      try {
        pkg = JSON.parse(readFileSync(file, 'utf-8'))
      } catch {
        continue
      }
      const pkgName: string = pkg.name ?? relative(root, dirname(file)).split(sep).join('/')
      const deps = pkg.dependencies ?? {}
      const devDeps = pkg.devDependencies ?? {}
      const peerDeps = pkg.peerDependencies ?? {}
      for (const [dep, ver] of Object.entries(deps) as [string, string][]) {
        addNode(dep, ver, 'prod')
        edges.push({ from: pkgName, to: dep })
      }
      for (const [dep, ver] of Object.entries(devDeps) as [string, string][]) {
        addNode(dep, ver, 'dev')
        edges.push({ from: pkgName, to: dep })
      }
      for (const [dep, ver] of Object.entries(peerDeps) as [string, string][]) {
        addNode(dep, ver, 'peer')
        edges.push({ from: pkgName, to: dep })
      }
    }
  } else if (pm === 'pip') {
    const reqFiles = findFiles(root, 'requirements.txt', scope, ['.git', 'venv', '__pycache__'])
    for (const file of reqFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue
        const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|!=)?\s*([0-9A-Za-z.*-]*)/)
        if (match) {
          const name = match[1]!
          const ver = match[3] ?? '*'
          addNode(name, ver, 'prod')
          edges.push({ from: relative(root, file).split(sep).join('/'), to: name })
        }
      }
    }
  } else if (pm === 'cargo') {
    const cargoFiles = findFiles(root, 'Cargo.toml', scope, ['target', '.git'])
    for (const file of cargoFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      const pkgName = relative(root, dirname(file)).split(sep).join('/')
      // Simple TOML parsing for [dependencies] section.
      let inDeps = false
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('[')) {
          inDeps = trimmed === '[dependencies]' || trimmed.startsWith('[dependencies.')
          continue
        }
        if (!inDeps || trimmed.length === 0 || trimmed.startsWith('#')) continue
        const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"?([0-9A-Za-z.*-]*)"?/)
        if (match) {
          addNode(match[1]!, match[2] ?? '*', 'prod')
          edges.push({ from: pkgName, to: match[1]! })
        }
      }
    }
  }

  return { nodes, edges, issues: [] }
}

// ---------------------------------------------------------------------------
// Issue detection
// ---------------------------------------------------------------------------

/** Detect circular dependencies via DFS. */
function detectCycles(graph: GraphResult): GraphIssue[] {
  const issues: GraphIssue[] = []
  const adj = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = adj.get(edge.from) ?? []
    list.push(edge.to)
    adj.set(edge.from, list)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const allNodes = new Set<string>()
  for (const edge of graph.edges) {
    allNodes.add(edge.from)
    allNodes.add(edge.to)
  }
  for (const node of allNodes) color.set(node, WHITE)

  const stack: string[] = []
  const dfs = (u: string): void => {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of adj.get(u) ?? []) {
      const cv = color.get(v) ?? WHITE
      if (cv === GRAY) {
        // Found a cycle: extract it from the stack.
        const idx = stack.indexOf(v)
        const cycle = stack.slice(idx)
        issues.push({
          type: 'cycle',
          description: `Circular dependency: ${cycle.join(' → ')} → ${v}`,
          packages: cycle,
        })
      } else if (cv === WHITE) {
        dfs(v)
      }
    }
    color.set(u, BLACK)
    stack.pop()
  }

  for (const node of allNodes) {
    if (color.get(node) === WHITE) dfs(node)
  }
  return issues
}

/** Detect unused dependencies by scanning source files for imports. */
function detectUnused(root: string, graph: GraphResult, pm: PackageManager, scope: string | undefined): GraphIssue[] {
  const issues: GraphIssue[] = []
  if (pm !== 'npm' && pm !== 'pnpm' && pm !== 'yarn') return issues

  // Collect all declared dependency names.
  const declared = new Set<string>()
  for (const node of graph.nodes) declared.add(node.name)

  // Scan source files for import/require statements.
  const used = new Set<string>()
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  const srcFiles = findFilesByExt(root, exts, scope, ['node_modules', '.git', 'dist', 'lib', 'build'])
  for (const file of srcFiles) {
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    // Match import ... from 'pkg' / require('pkg')
    const importRe = /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = importRe.exec(content)) !== null) {
      let pkg = match[1]!
      // Strip path: @scope/pkg/subpath → @scope/pkg
      if (pkg.startsWith('@')) {
        const parts = pkg.split('/')
        pkg = parts.slice(0, 2).join('/')
      } else {
        pkg = pkg.split('/')[0]!
      }
      used.add(pkg)
    }
  }

  for (const dep of declared) {
    if (!used.has(dep) && !dep.startsWith('@types/')) {
      issues.push({
        type: 'unused',
        description: `Dependency "${dep}" is declared but never imported in source files.`,
        packages: [dep],
      })
    }
  }
  return issues
}

/** Detect version conflicts: same package with different versions. */
function detectConflicts(graph: GraphResult): GraphIssue[] {
  const issues: GraphIssue[] = []
  const versions = new Map<string, Set<string>>()
  for (const node of graph.nodes) {
    const set = versions.get(node.name) ?? new Set<string>()
    set.add(node.version)
    versions.set(node.name, set)
  }
  for (const [name, vers] of versions) {
    if (vers.size > 1) {
      issues.push({
        type: 'conflict',
        description: `Version conflict for "${name}": ${[...vers].join(', ')}`,
        packages: [name],
      })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

/** Find files with a specific name, optionally scoped. */
function findFiles(root: string, name: string, scope: string | undefined, skipDirs: string[]): string[] {
  const result: string[] = []
  const scopePrefix = scope !== undefined ? scope.replace(/\*\*/g, '').replace(/\*/g, '') : ''
  walkFor(root, root, name, scopePrefix, skipDirs, result)
  return result
}

/** Find files by extension. */
function findFilesByExt(root: string, exts: string[], scope: string | undefined, skipDirs: string[]): string[] {
  const result: string[] = []
  const scopePrefix = scope !== undefined ? scope.replace(/\*\*/g, '').replace(/\*/g, '') : ''
  const extSet = new Set(exts)
  walkForExt(root, root, extSet, scopePrefix, skipDirs, result)
  return result
}

function walkFor(dir: string, root: string, name: string, scopePrefix: string, skipDirs: string[], result: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (skipDirs.includes(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkFor(full, root, name, scopePrefix, skipDirs, result)
    } else if (entry === name) {
      if (scopePrefix.length > 0) {
        const rel = relative(root, full).split(sep).join('/')
        if (!rel.startsWith(scopePrefix)) continue
      }
      result.push(full)
    }
  }
}

function walkForExt(dir: string, root: string, exts: Set<string>, scopePrefix: string, skipDirs: string[], result: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (skipDirs.includes(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkForExt(full, root, exts, scopePrefix, skipDirs, result)
    } else {
      const ext = entry.slice(entry.lastIndexOf('.'))
      if (!exts.has(ext)) continue
      if (scopePrefix.length > 0) {
        const rel = relative(root, full).split(sep).join('/')
        if (!rel.startsWith(scopePrefix)) continue
      }
      result.push(full)
    }
  }
}