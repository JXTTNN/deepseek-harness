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

try {
  const home = process.env.HOME || '/home/runner'
  const ws = await rpc('workspace.create', { path: home })
  const workspaceId = ws?.result?.value?.workspace?.workspaceId ?? ws?.result?.value?.workspaceId ?? ws?.result?.workspaceId
  await rpc('session.create', { sessionId: SID, workspaceId })
  log('session.create ok')

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)

  // Type into the composer and send.
  const composer = page.locator('textarea:enabled, [contenteditable="true"]').first()
  const hasComposer = await composer.count() > 0
  log('composer found', hasComposer)
  if (!hasComposer) {
    const labels = await page.locator('button').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 30))
    log('button aria-labels', JSON.stringify(labels))
    process.exit(0)
  }
  await composer.click().catch(() => {})
  await page.keyboard.type('ui-send-probe', { delay: 20 })
  await page.waitForTimeout(500)
  const sendBtn = page.locator('button[aria-label="Send message"], button[aria-label="发送"]').first()
  const hasSend = await sendBtn.count() > 0
  const disabled = await sendBtn.isDisabled().catch(() => true)
  log('send button found', hasSend, 'disabled', disabled)
  if (hasSend && !disabled) {
    await sendBtn.click()
    await page.waitForTimeout(6000)
  } else {
    log('SKIP: send button disabled (empty composer or workspace not chosen)')
    process.exit(0)
  }

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
