/**
 * Test impact analysis tool: analyses git diff + test coverage mapping to
 * select only the tests affected by a change (test selection).
 *
 * The `test_impact` tool supports three actions:
 *  - `"analyze"` 鈫?analyse the dependency relationship between changed source
 *                   files and test files (which tests import/cover which sources)
 *  - `"select"`  鈫?return the list of test files that need to run
 *  - `"map"`    鈫?generate or update the test coverage mapping file
 *
 * The tool parses import/require statements in test files to determine which
 * source modules they exercise, then intersects with the changed file set
 * (from `git diff` or an explicit `changedFiles` argument) to select only
 * the affected tests.
 *
 * @module @deepseek-ai/dsh-tool-test-impact
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep, extname, basename, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool as _defineTool } from '@deepseek-ai/dsh-tools'
const defineTool = _defineTool as any

export const name = 'tool-test-impact'
export const inject = ['tools']

/** A reason entry: why a test was selected. */
interface SelectionReason {
  test: string
  changedFile: string
  dependency: string
}

/** The analysis result. */
interface ImpactResult {
  affectedTests: string[]
  reason: SelectionReason[]
}

type Action = 'analyze' | 'select' | 'map'

/** Default test file glob pattern. */
const DEFAULT_TEST_PATTERN = '**/*.test.ts'

/** Source file extensions. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'])

/** Test file indicators. */
const TEST_INDICATORS = ['.test.', '.spec.', '_test.', '_spec.', '/tests/', '/test/']

/** Coverage map file path. */
const COVERAGE_MAP_FILE = '.test-coverage-map.json'

/** Directories to skip. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'lib', 'coverage', '.cache', 'vendor', '.turbo'])

/**
 * Register the `test_impact` tool that analyses test impact and selects
 * affected tests.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'test_impact',
    description:
      'Test impact analysis: determine which tests are affected by source '
      + 'changes. Parses import/require statements to build a test鈫抯ource '
      + 'dependency map, intersects with git diff (or explicit changedFiles), '
      + 'and returns only the tests that need to run. Actions: "analyze" '
      + '(dependency analysis), "select" (affected test list), "map" '
      + '(generate/update coverage map).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['analyze', 'select', 'map'],
        description: 'Action to perform.',
      },
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Changed file list. If omitted, uses git diff.',
      },
      testPattern: {
        type: 'string',
        description: 'Test file glob pattern. Default "**/*.test.ts".',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const action: Action = args.action
      const testPattern: string = args.testPattern ?? DEFAULT_TEST_PATTERN
      const root = process.cwd()

      // Determine changed files: explicit list or git diff.
      let changedFiles: string[] = args.changedFiles ?? []
      if (changedFiles.length === 0) {
        changedFiles = getGitDiffFiles(root)
      }

      // Collect all test files.
      const testFiles = findTestFiles(root, testPattern)

      // Build the test鈫抯ource dependency map.
      const depMap = buildDependencyMap(root, testFiles)

      switch (action) {
        case 'analyze':
          return analyzeImpact(root, changedFiles, depMap)
        case 'select':
          return selectTests(root, changedFiles, depMap)
        case 'map':
          return updateCoverageMap(root, depMap)
        default:
          return { affectedTests: [], reason: [] } as ImpactResult
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// Git diff
// ---------------------------------------------------------------------------

/** Get changed files from git diff (staged + unstaged vs HEAD). */
function getGitDiffFiles(root: string): string[] {
  try {
    const output = execSync('git diff --name-only HEAD', {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (output.length === 0) return []
    return output.split('\n').filter(f => f.length > 0)
  } catch {
    // Not a git repo or git unavailable 鈥?return empty.
    return []
  }
}

// ---------------------------------------------------------------------------
// Test file discovery
// ---------------------------------------------------------------------------

/** Find all test files matching the pattern. */
function findTestFiles(root: string, pattern: string): string[] {
  const result: string[] = []
  // Convert glob pattern to a simple extension + indicator filter.
  const ext = extname(pattern) || '.ts'
  walkTestFiles(root, root, ext, result)
  return result
}

function walkTestFiles(dir: string, root: string, ext: string, result: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkTestFiles(full, root, ext, result)
    } else if (st.isFile() && entry.endsWith(ext)) {
      // Check if it looks like a test file.
      const rel = relative(root, full).split(sep).join('/')
      if (isTestFile(entry, rel)) {
        result.push(full)
      }
    }
  }
}

/** Determine if a file is a test file by name/path indicators. */
function isTestFile(name: string, rel: string): boolean {
  for (const indicator of TEST_INDICATORS) {
    if (name.includes(indicator) || rel.includes(indicator)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Dependency map building
// ---------------------------------------------------------------------------

/** Test 鈫?source dependencies. */
interface DependencyMap {
  /** Map: test file (relative) 鈫?source modules it imports. */
  testToSources: Map<string, string[]>
  /** Map: source module 鈫?test files that import it. */
  sourceToTests: Map<string, string[]>
}

/** Build the test鈫抯ource dependency map by parsing import statements. */
function buildDependencyMap(root: string, testFiles: string[]): DependencyMap {
  const testToSources = new Map<string, string[]>()
  const sourceToTests = new Map<string, string[]>()

  for (const testFile of testFiles) {
    let content: string
    try {
      content = readFileSync(testFile, 'utf-8')
    } catch {
      continue
    }
    const relTest = relative(root, testFile).split(sep).join('/')
    const sources = extractImports(content, testFile, root)
    testToSources.set(relTest, sources)
    for (const src of sources) {
      const tests = sourceToTests.get(src) ?? []
      tests.push(relTest)
      sourceToTests.set(src, tests)
    }
  }

  return { testToSources, sourceToTests }
}

/** Extract import/require source paths from file content. */
function extractImports(content: string, fromFile: string, root: string): string[] {
  const sources: string[] = []
  const seen = new Set<string>()

  // Match ES imports: import ... from 'path'
  const importRe = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
  // Match require: require('path')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  const collect = (match: RegExpExecArray | null): void => {
    if (match === null) return
    let dep = match[1]!
    // Only resolve relative imports.
    if (!dep.startsWith('.') && !dep.startsWith('/')) return
    // Resolve the path relative to the importing file.
    const resolved = resolveImportPath(dep, fromFile, root)
    if (resolved !== null && !seen.has(resolved)) {
      seen.add(resolved)
      sources.push(resolved)
    }
  }

  let m: RegExpExecArray | null
  while ((m = importRe.exec(content)) !== null) collect(m)
  while ((m = requireRe.exec(content)) !== null) collect(m)

  return sources
}

/** Resolve an import path to a relative-from-root module path. */
function resolveImportPath(dep: string, fromFile: string, root: string): string | null {
  const fromDir = dirname(fromFile)
  let resolved: string
  if (dep.startsWith('.')) {
    resolved = join(fromDir, dep)
  } else {
    resolved = dep
  }
  // Try with extensions.
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js']
  for (const ext of exts) {
    const candidate = resolved + ext
    if (existsSync(candidate)) {
      return relative(root, candidate).split(sep).join('/')
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Analyse the impact: which tests depend on which changed files. */
function analyzeImpact(root: string, changedFiles: string[], depMap: DependencyMap): ImpactResult {
  const affectedTests = new Set<string>()
  const reason: SelectionReason[] = []

  for (const changed of changedFiles) {
    const normalised = changed.split(sep).join('/')
    // Direct match: the changed file IS a test file.
    if (depMap.testToSources.has(normalised)) {
      affectedTests.add(normalised)
      reason.push({ test: normalised, changedFile: normalised, dependency: 'self' })
    }
    // The changed file is a source 鈥?find tests that import it.
    const tests = depMap.sourceToTests.get(normalised) ?? []
    // Also try without extension (in case the import omitted it).
    const ext = extname(normalised)
    const noExt = ext.length > 0 ? normalised.slice(0, -ext.length) : normalised
    const testsNoExt = depMap.sourceToTests.get(noExt) ?? []

    for (const test of [...tests, ...testsNoExt]) {
      affectedTests.add(test)
      reason.push({ test, changedFile: normalised, dependency: 'import' })
    }
  }

  return {
    affectedTests: [...affectedTests].sort(),
    reason,
  }
}

/** Select tests that need to run. */
function selectTests(root: string, changedFiles: string[], depMap: DependencyMap): ImpactResult {
  const result = analyzeImpact(root, changedFiles, depMap)
  // If no changed files, return all tests (run everything).
  if (changedFiles.length === 0) {
    const allTests = [...depMap.testToSources.keys()].sort()
    return { affectedTests: allTests, reason: [] }
  }
  return result
}

/** Generate or update the coverage map file. */
function updateCoverageMap(root: string, depMap: DependencyMap): ImpactResult {
  const mapObj: Record<string, string[]> = {}
  for (const [test, sources] of depMap.testToSources) {
    mapObj[test] = sources
  }
  const outputPath = join(root, COVERAGE_MAP_FILE)
  writeFileSync(outputPath, JSON.stringify(mapObj, null, 2), 'utf-8')

  const testCount = depMap.testToSources.size
  const sourceCount = depMap.sourceToTests.size
  return {
    affectedTests: [],
    reason: [{
      test: COVERAGE_MAP_FILE,
      changedFile: outputPath,
      dependency: `Coverage map updated: ${testCount} tests, ${sourceCount} source modules`,
    }],
  }
}