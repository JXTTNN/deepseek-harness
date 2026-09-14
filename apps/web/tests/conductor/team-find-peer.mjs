// Reproduce the team "find peer" (找同伴) mechanism: create two team-preset
// sessions in one workspace, then assert each wrote its presence file — the
// discovery substrate that team_list/team_send read. No LLM calls.
//
// Run: node apps/web/tests/conductor/team-find-peer.mjs

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const HOME = homedir()
const presenceDir = join(HOME, '.team', 'presence')
const log = (...a) => console.log('[team]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `t-${method}`, method, payload }),
}).then(r => r.json())

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

try {
  await rpc('workspace.create', { path: HOME })
  for (const id of ['team-c1', 'team-c2']) {
    const r = await rpc('session.create', { cwd: HOME, sessionId: id, agentPreset: 'team' })
    log(`session.create ${id} ok`, r?.result?.ok, 'err', JSON.stringify(r?.result?.error ?? null).slice(0, 140))
  }
  await sleep(3000)

  if (!existsSync(presenceDir)) {
    log('FAIL: no .team/presence directory — peer presence was never written')
    process.exit(1)
  }
  const files = readdirSync(presenceDir).filter(f => f.endsWith('.json'))
  log('presence files', JSON.stringify(files))
  const c1 = files.some(f => f.startsWith('team-c1'))
  const c2 = files.some(f => f.startsWith('team-c2'))
  log('team-c1 present', c1, 'team-c2 present', c2)

  if (c1 && c2) {
    log('PASS: both team sessions wrote presence — peer discovery works')
  } else {
    log('FAIL: peer discovery broken — not every team session wrote its presence file')
    process.exit(1)
  }
} catch (e) {
  console.error('[team][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
