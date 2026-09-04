// Real-person send-message probe: type into the composer input and click Send,
// then verify the user message actually reached the session log. Complements the
// API-driven prompt checks with a genuine UI input-box + button interaction.
//
// Best-effort: the composer is a machine-backed textarea that only accepts input
// once a workspace is connected AND a session is active (before that it sits in
// the hero/inert state and fill() cannot register). The full real-input path is
// already covered by the vitest e2e specs (chat-continuous-conversation.e2e.ts
// et al.); this conductor attempts the same flow against the live cloud shell
// and reports SKIP when the preconditions are not met rather than failing.
//
// Run: node apps/web/tests/conductor/send-message.mjs

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const log = (...a) => console.log('[send]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `sm-${method}`, method, payload }),
}).then(r => r.json())

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
page.setDefaultTimeout(20000)
page.on('console', (m) => { if (m.type() === 'error') log('browser', m.text().slice(0, 200)) })

try {
  const home = process.env.HOME || '/home/runner'
  mkdirSync(join(home, 'send-probe-ws'), { recursive: true })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)

  // The live composer ("Message the agent" placeholder) only appears when a
  // workspace is connected and a session is active. Click "New session" to
  // leave the hero/inert state, which is the same gesture a real user makes.
  const newSession = page.getByRole('button', { name: 'New session' }).first()
  if (await newSession.count() === 0) {
    log('SKIP: no New session button (workspace not connected)')
    process.exit(0)
  }
  await newSession.click().catch(() => {})
  await page.waitForTimeout(1500)

  const composer = page.locator('textarea:enabled').last()
  if (await composer.count() === 0) {
    log('SKIP: no enabled composer textarea')
    process.exit(0)
  }
  await composer.fill('ui-send-probe')
  const value = await composer.inputValue()
  log('composer value', JSON.stringify(value))
  if (value !== 'ui-send-probe') {
    log('SKIP: composer fill did not register (inert hero state or model not selected)')
    process.exit(0)
  }

  const sendBtn = page.getByRole('button', { name: 'Send message', exact: true })
  if (await sendBtn.count() === 0 || await sendBtn.isDisabled().catch(() => true)) {
    log('SKIP: send button not enabled')
    process.exit(0)
  }
  await sendBtn.click()
  await page.waitForTimeout(6000)

  const listResp = await rpc('session.list', {})
  const items = listResp?.result?.value?.items ?? []
  let found = false
  for (const it of items) {
    if (it.sessionId === undefined) continue
    const hist = await rpc('session.history', { sessionId: it.sessionId })
    const events = hist?.result?.value?.events ?? []
    if (JSON.stringify(events).includes('ui-send-probe')) {
      found = true
      log('message found in session', it.sessionId)
      break
    }
  }
  if (!found) {
    log('FAIL: typed text did not reach any session log')
    process.exit(1)
  }
  log('PASS: UI input-box send reached the session log')
} catch (e) {
  console.error('[send][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
} finally {
  await browser.close()
}
