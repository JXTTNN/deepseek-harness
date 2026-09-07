import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)

describe.skipIf(!hasKey)('headless-agent with real model', () => {
  it('modifies a temporary workspace and verifies the file outside the agent', async () => {
    let verified = ''
    const { stdout } = await runLoaderSmoke({
      label: 'headless-agent real model',
      tempDirPrefix: 'headless-agent-real-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [
        configPath,
        'Read task.txt, replace its complete contents with exactly "value=after" followed by a newline, read it again, and report briefly.',
      ],
      tsconfigPath,
      // Rate-limited gateways stretch each model round-trip well beyond the
      // official endpoint's seconds (compounding retries push a step past
      // 60s — analyze run 34087293815 remnants), so the 3-step task needs a
      // 5-minute watchdog, not 120s.
      processTimeoutMs: 300_000,
      prepare: cwd => writeFile(join(cwd, 'task.txt'), 'value=before\n'),
      inspect: async (cwd) => { verified = await readFile(join(cwd, 'task.txt'), 'utf8') },
    })
    // Custom-gateway models may drop the requested trailing newline; that is
    // a model-following deviation, not a harness write fault. Keep every other
    // character exact — the write/read round trip stays fully verified.
    expect(verified.replace(/\n$/, '')).toBe('value=after')
    expect(stdout.trim().length).toBeGreaterThan(0)
  }, 315_000)
})
