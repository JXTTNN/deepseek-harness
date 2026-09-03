// Cross-process lock verification for the team-comm withFileLock fix.
// Replicates the exact lock logic (wx atomic create + stale-only break, no
// wall-clock deadline) and proves N processes appending concurrently lose
// nothing. Multi-method verification for the data-loss fix.
//
// Run: node apps/web/tests/conductor/lock-test.mjs

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const N = 4
const M = 20
const FILE_LOCK_STALE_MS = 10_000
const SCRIPT = fileURLToPath(import.meta.url)

async function withFileLock(file, fn) {
  mkdirSync(dirname(file), { recursive: true })
  const lockPath = `${file}.lock`
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
      break
    } catch (err) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code)) throw err
      let stale = false
      try { stale = Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS } catch { /* vanished */ }
      if (stale) { try { rmSync(lockPath, { force: true }) } catch { /* raced */ }; continue }
      await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)))
    }
  }
  try { fn() } finally { try { rmSync(lockPath, { force: true }) } catch { /* best-effort */ } }
}

if (process.env.LOCK_CHILD === '1') {
  const file = process.argv[2]
  const id = process.argv[3]
  for (let i = 0; i < M; i++) {
    await withFileLock(file, () => { writeFileSync(file, `${id}-${i}\n`, { flag: 'a' }) })
  }
} else {
  const dir = mkdtempSync(join(tmpdir(), 'team-lock-'))
  const file = join(dir, 'inbox.jsonl')
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, file, `p${i}`], {
      env: { ...process.env, LOCK_CHILD: '1' },
      stdio: 'ignore',
    })
    child.on('exit', resolve)
  })))
  const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
  const expected = new Set(Array.from({ length: N }, (_, i) => Array.from({ length: M }, (_, j) => `p${i}-${j}`)).flat())
  const got = new Set(lines)
  const missing = [...expected].filter((x) => !got.has(x))
  console.log(`[lock] ${lines.length}/${N * M} lines, missing ${missing.length}`)
  if (missing.length) { console.log('[lock] FAIL: lost lines', missing); process.exit(1) }
  console.log('[lock] PASS: no data loss under 4-process contention')
}
