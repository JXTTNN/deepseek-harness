// Real-person send-message probe: type into the composer input and click Send,
// then verify the user message actually reached the session log. Complements the
// API-driven prompt checks with a genuine UI input-box + button interaction.
//
// Run: node apps/web/tests/conductor/send-message.mjs

import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const SID = `ui-send-${Date.now()}`
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
  const ws = await rpc('workspace.create', { path: home })
  const workspaceId = ws?.result?.value?.workspace?.workspaceId ?? ws?.result?.value?.workspaceId ?? ws?.result?.workspaceId
  const created = await rpc('session.create', { sessionId: SID, workspaceId })
  log('session.create ok', created?.result?.ok)
  if (!created?.result?.ok) process.exit(1)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)

  // Activate the session through the real sidebar UI: click its row so the
  // composer binds to it and the Send button enables. The API-created session
  // must be visible in the tree; click by aria-label match on the row.
  const row = page.locator(`[role="treeitem"]:has-text("${SID}")`).first()
  const rowCount = await row.count()
  log('session row in sidebar', rowCount > 0)
  if (rowCount > 0) {
    await row.click().catch(() => {})
    await page.waitForTimeout(1500)
  }

  // The live composer enables only once a workspace/session is chosen. Use the
  // same selector the passing e2e specs use: the enabled textarea, last (the
  // composer), filled rather than keyboard-typed so React state updates.
  const composer = page.locator('textarea:enabled').last()
  const hasComposer = await composer.count() > 0
  log('composer found', hasComposer)
  if (!hasComposer) {
    const labels = await page.locator('button').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 30))
    log('button aria-labels', JSON.stringify(labels))
    log('FAIL: no enabled composer textarea')
    process.exit(1)
  }
  await composer.fill('ui-send-probe')
  const value = await composer.inputValue()
  log('composer value', JSON.stringify(value))
  await page.waitForTimeout(300)

  const sendBtn = page.getByRole('button', { name: 'Send message', exact: true })
  const hasSend = await sendBtn.count() > 0
  const disabled = hasSend ? await sendBtn.isDisabled().catch(() => true) : true
  log('send button found', hasSend, 'disabled', disabled)
  if (!hasSend || disabled) {
    log('FAIL: send button not enabled after typing (workspace/session not activated)')
    process.exit(1)
  }
  await sendBtn.click()
  await page.waitForTimeout(6000)

  const hist = await rpc('session.history', { sessionId: SID })
  const events = hist?.result?.value?.events ?? []
  const userMsgs = events.filter(e => e.event?.type === 'user/message')
  const text = JSON.stringify(userMsgs)
  log('user/message events', userMsgs.length, text.slice(0, 200))
  if (!text.includes('ui-send-probe')) {
    log('FAIL: typed text did not reach the session log')
    process.exit(1)
  }
  log('PASS: UI input-box send reached the session log')
} catch (e) {
  console.error('[send][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
} finally {
  await browser.close()
}
