// Direct verification of the session-delete fix: create a workspace + session
// through the HTTP API, confirm the session materializes under ~/.dsh/sessions,
// delete it via workspace.deleteSession (the fixed code path), and assert the
// on-disk session directory is gone. Complements the UI probe.
//
// Run: node apps/web/tests/conductor/delete-api-verify.mjs

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const SID = 'cloud-delete-verify'
const HOME = homedir()
const sessionsRoot = join(HOME, '.dsh', 'sessions')
const log = (...a) => console.log('[verify]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `v-${method}`, method, payload }),
}).then(r => r.json())

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function findSessionDir() {
  if (!existsSync(sessionsRoot)) return null
  for (const project of readdirSync(sessionsRoot)) {
    const direct = join(sessionsRoot, project, SID)
    if (existsSync(direct)) return direct
    // also scan for an encoded id if the raw name differs
    for (const entry of readdirSync(join(sessionsRoot, project))) {
      if (entry === SID || entry.startsWith(SID)) return join(sessionsRoot, project, entry)
    }
  }
  return null
}

try {
  await rpc('workspace.create', { path: HOME })
  const created = await rpc('session.create', { sessionId: SID, cwd: HOME })
  log('session.create ok', created?.result?.ok, 'err', JSON.stringify(created?.result?.error ?? null).slice(0, 120))
  await sleep(2500)

  let dir = findSessionDir()
  log('session dir before delete', dir)
  if (dir === null) {
    // Lazy materialization: no events yet, so no file. Prompt to force a write.
    await rpc('session.prompt', { sessionId: SID, mode: 'default', content: [{ type: 'text', text: 'ping' }] })
    await sleep(4000)
    dir = findSessionDir()
    log('session dir after prompt', dir)
  }
  if (dir === null) {
    log('FAIL: session never materialized on disk; cannot verify delete')
    process.exit(1)
  }

  const del = await rpc('workspace.deleteSession', { sessionId: SID })
  log('deleteSession ok', del?.result?.ok, 'err', JSON.stringify(del?.result?.error ?? null).slice(0, 120))
  await sleep(800)

  const after = findSessionDir()
  log('session dir after delete', after)
  if (after !== null) {
    log('FAIL: session files still on disk after delete:', after)
    process.exit(1)
  }
  log('PASS: delete removed the session files from disk')
} catch (e) {
  console.error('[verify][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
