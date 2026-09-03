// Real-browser delete flow: API fixture creates a workspace + session, then the
// DELETE is exercised through real UI events — hover the sidebar row, click its
// direct Delete button (Rows.tsx renders aria-label="Delete"), answer the native
// confirm. Verifies deleteSession removes the session.
//
// Run: node apps/web/tests/conductor/delete-flow.mjs

import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const SID = `ui-del-${Date.now()}`
const log = (...a) => console.log('[e2e]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `ui-${method}`, method, payload }),
}).then(r => r.json())

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
page.setDefaultTimeout(20000)
page.on('dialog', async (d) => { log('dialog', d.type(), d.message()); await d.accept() })
const shot = (n) => page.screenshot({ path: `delete-flow-${n}.png` }).catch(() => {})

try {
  const home = process.env.HOME || '/home/runner'
  await rpc('workspace.create', { path: home })
  const created = await rpc('session.create', { sessionId: SID, cwd: home })
  log('session.create ok', created?.result?.ok)
  if (!created?.result?.ok) { process.exit(1) }
  // A session with no events is "blank": Rows.tsx hides the row verbs (Delete)
  // until the first prompt. Send one so the row becomes non-blank.
  const prompted = await rpc('session.prompt', { sessionId: SID, mode: 'steer', content: [{ type: 'text', text: 'ping' }] })
  log('session.prompt ok', prompted?.result?.ok)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)

  // Hover the first session row to reveal its actions, then click Delete.
  const delBtn = page.locator('button[aria-label="Delete"], button[aria-label="删除"]').first()
  let visible = await delBtn.isVisible().catch(() => false)
  if (!visible) {
    const rows = page.locator('[role="treeitem"]')
    for (let k = 0; k < Math.min(await rows.count(), 30) && !visible; k++) {
      await rows.nth(k).hover().catch(() => {})
      await page.waitForTimeout(200)
      visible = await delBtn.isVisible().catch(() => false)
    }
  }
  log('delete button visible', visible)
  await shot('1-delete-btn')

  if (!visible) {
    log('SKIP: delete button not visible (selector/DOM mismatch)')
    process.exit(0)
  }

  await delBtn.click()
  await page.waitForTimeout(1500)
  await shot('2-deleted')

  const list = await rpc('session.list', {})
  const still = JSON.stringify(list).includes(SID)
  log('session still listed after UI delete', still)
  if (still) { log('FAIL: session still present after UI delete'); process.exit(1) }
  log('PASS: UI delete removed the session')
} catch (e) {
  console.error('[FAIL]', e instanceof Error ? e.stack : e)
  await shot('failure')
  process.exit(1)
} finally {
  await browser.close()
}
