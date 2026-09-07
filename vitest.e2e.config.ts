import tsconfigPaths from 'vite-tsconfig-paths'
import { configDefaults, defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Real-API suite, separate because it spends tokens. Each test self-skips without
// its provider credential for keyless CI; credentialed workflows preflight the
// secrets they require. Values may come from the environment or gitignored root
// `.env`, with provider-specific endpoint overrides where supported.
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

const DEFAULT_E2E_MAX_WORKERS = 4

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const e2eMaxWorkers = positiveIntFromEnv('DSH_E2E_MAX_WORKERS', DEFAULT_E2E_MAX_WORKERS)

/**
 * Suites in this list assert behavior only the OFFICIAL DeepSeek API
 * guarantees: fixed v4-flash/v4-pro model ids, thinking-effort mappings,
 * prefix-cache hit accounting, or CLI bridges pinned to the official base
 * URL (the claude-code suite throws on any other URL). A custom
 * $DEEPSEEK_BASE_URL (e.g. a gateway with aliased models and no cache
 * accounting) makes those assertions unsatisfiable, so the suites are
 * skipped rather than red on a forked deployment. Generic agent-flow e2e
 * (fs, shell, headless, web) keeps running against whatever endpoint is
 * configured.
 */
const OFFICIAL_BASE_URL = 'https://api.deepseek.com'
const configuredBaseUrl = (process.env.DEEPSEEK_BASE_URL ?? OFFICIAL_BASE_URL).replace(/\/+$/, '')
const isOfficialEndpoint = configuredBaseUrl === OFFICIAL_BASE_URL
const OFFICIAL_ONLY_SUITES = [
  'packages/llm/llm-deepseek/tests/adapter.e2e.ts',
  'packages/llm/llm-pi-ai/tests/adapter.e2e.ts',
  'packages/core/agent-loop/tests/request-cache.e2e.ts',
  'packages/subagent/subagent-claude-code/tests/real-deepseek.e2e.ts',
  'packages/subagent/subagent-codex/tests/real-deepseek.e2e.ts',
]
if (!isOfficialEndpoint) {
  console.warn(
    `[e2e] DEEPSEEK_BASE_URL=${configuredBaseUrl} is not the official API;`
    + ` skipping official-only suites: ${OFFICIAL_ONLY_SUITES.join(', ')}`,
  )
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the tsconfig.base.json paths facade (no include = match-all, so
  // client-package sources get mapping too — dropping /client subpath imports
  // onto package exports would load browser dist bundles into node).
  // Built-artifact e2e suites are unaffected: their built-ness lives in
  // subprocesses and createRequire lookups, which bypass vite resolution
  // entirely.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    // apps/cli only, not apps/*: apps/web/tests/*.e2e.ts needs the built
    // frontend dist and runs under vitest.web.config.ts (the test:web job).
    include: ['packages/*/*/tests/**/*.e2e.ts', 'apps/cli/tests/**/*.e2e.ts', 'examples/*/tests/**/*.e2e.ts'],
    exclude: [...configDefaults.exclude, ...(isOfficialEndpoint ? [] : OFFICIAL_ONLY_SUITES)],
    // Real model calls: generous timeouts, and retries for transient flakes
    // (the shared internal key hits concurrency quotas). No coverage — the
    // unit suites own the coverage gate.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 2,
    // Run files in a bounded pool: enough lower-level parallelism to keep CI
    // and local with-key runs moving, while leaving a resource knob for shared
    // API quotas (`DSH_E2E_MAX_WORKERS=1` restores serial execution).
    fileParallelism: e2eMaxWorkers > 1,
    maxWorkers: e2eMaxWorkers,
  },
})
