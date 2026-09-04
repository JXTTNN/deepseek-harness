// Real-person send-message probe: connect a workspace through the UI picker,
// type into the composer input, and click Send, then verify the user message
// reached the session log. Complements the API-driven prompt checks with a
// genuine UI input-box + button interaction.
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
  const wsRoot = join(home, 'send-probe-ws')
  mkdirSync(wsRoot, { recursive: true })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)

  // Connect a workspace through the real picker dialog (mirrors the passing
  // e2e specs' connectFreshWorkspace): without a connected workspace the
  // composer stays a locked placeholder and the Send button never enables.
  await page.getByRole('textbox', { name: 'Choose workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(wsRoot)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()

  const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
  await composer.waitFor({ timeout: 15_000 })
  log('composer connected', true)

  await composer.fill('ui-send-probe')
  const value = await composer.inputValue()
  log('composer value', JSON.stringify(value))
  if (value !== 'ui-send-probe') {
    log('FAIL: composer fill did not register')
    process.exit(1)
  }

  const sendBtn = page.getByRole('button', { name: 'Send message', exact: true })
  const disabled = await sendBtn.isDisabled().catch(() => true)
  log('send button disabled', disabled)
  if (disabled) {
    log('FAIL: send button still disabled after typing')
    process.exit(1)
  }
  await sendBtn.click()
  await page.waitForTimeout(6000)

  // Find the session the UI created for the connected workspace and confirm the
  // typed text landed in its history.
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
