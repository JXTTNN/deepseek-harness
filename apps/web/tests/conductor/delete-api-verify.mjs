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

/**
 * One RPC call. The carrier answers HTTP 200 for business errors, so a non-2xx
 * means the carrier itself rejected us (404 unknown method, 415 bad media
 * type, 400 non-JSON body, 500 handler crash).
 */
async function rpc(method, payload) {
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `v-${method}`, method, payload }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${method}: carrier HTTP ${response.status} ${detail}`.trim())
  }
  return response.json()
}

/**
 * RPC that must succeed. Asserting here is the substantive part of this fix:
 * the previous version printed `ok` without checking it, so an invalid payload
 * surfaced much later as "session never materialized on disk".
 */
async function mustRpc(method, payload) {
  const response = await rpc(method, payload)
  if (response?.result?.ok !== true) {
    const error = JSON.stringify(response?.result?.error ?? response).slice(0, 300)
    throw new Error(`${method} failed: ${error}`)
  }
  return response.result.value
}

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
  await mustRpc('workspace.create', { path: HOME })
  await mustRpc('session.create', { sessionId: SID, cwd: HOME })
  log('session.create ok')
  await sleep(2500)

  let dir = findSessionDir()
  log('session dir before delete', dir)
  if (dir === null) {
    // Lazy materialization: no events yet, so no file. Prompt to force a write.
    // The wire schema pins mode to 'queue' | 'steer'; 'default' is rejected.
    await mustRpc('session.prompt', {
      sessionId: SID,
      mode: 'queue',
      content: [{ type: 'text', text: 'ping' }],
    })
    await sleep(4000)
    dir = findSessionDir()
    log('session dir after prompt', dir)
  }
  if (dir === null) {
    log('FAIL: session never materialized on disk; cannot verify delete')
    process.exit(1)
  }

  await mustRpc('workspace.deleteSession', { sessionId: SID })
  log('workspace.deleteSession ok')
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
