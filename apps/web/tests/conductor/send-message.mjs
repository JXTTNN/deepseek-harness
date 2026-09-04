// Real-person send-message probe: connect a workspace through the UI, type into
// the composer input, and click Send, then verify the user message reached the
// session log. Complements the API-driven prompt checks with a genuine UI
// input-box + button interaction.
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

const COMPOSER = 'textarea:enabled[placeholder="Describe what you want to build"]'

async function ensureComposer() {
  const composer = page.locator(COMPOSER)
  try {
    await composer.waitFor({ timeout: 4000 })
    return composer
  } catch { /* not connected yet */ }

  // Open the workspace picker. In a fresh world the empty-state opener is a
  // textbox; with existing workspaces it renders as a button.
  const openers = [
    page.getByRole('textbox', { name: 'Choose workspace' }),
    page.getByRole('button', { name: 'Choose workspace' }),
  ]
  let opened = false
  for (const opener of openers) {
    if (await opener.count() > 0) {
      await opener.first().click().catch(() => {})
      opened = true
      break
    }
  }
  if (!opened) {
    // No picker opener: try selecting the first sidebar workspace/session row.
    const firstItem = page.locator('[role="treeitem"]').first()
    await firstItem.click().catch(() => {})
    await page.waitForTimeout(1000)
  }

  // A "Select Workspace Directory" dialog (add-a-workspace flow) may appear;
  // adopt the staged path. If a different picker/list opened instead, skip it.
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  try {
    await dialog.waitFor({ timeout: 5000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
    await pathInput.fill(join(process.env.HOME || '/home/runner', 'send-probe-ws'))
    await pathInput.press('Enter')
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  } catch { /* no add-workspace dialog; the click already connected */ }

  await composer.waitFor({ timeout: 15000 })
  return composer
}

try {
  mkdirSync(join(process.env.HOME || '/home/runner', 'send-probe-ws'), { recursive: true })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)

  const composer = await ensureComposer()
  log('composer connected', true)

  // Click first: the hero input ("Describe what you want to build") starts a
  // new session on focus/click and may be REPLACED by the live composer
  // ("Message the agent"), so re-resolve the locator after activating it.
  await composer.click().catch(() => {})
  await page.waitForTimeout(800)
  const liveComposer = page.locator('textarea:enabled').last()
  await liveComposer.fill('ui-send-probe')
  const value = await liveComposer.inputValue()
  log('composer value', JSON.stringify(value))
  if (value !== 'ui-send-probe') {
    const tas = await page.locator('textarea').evaluateAll(els => els.map(el => ({
      placeholder: el.getAttribute('placeholder'),
      disabled: el.disabled,
      readOnly: el.readOnly,
    })))
    log('DIAG textareas', JSON.stringify(tas))
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
