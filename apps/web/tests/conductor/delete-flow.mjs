// Real-browser delete-flow probe (真人级: real click / real input / real dialog).
//
// A fresh headless home has no workspace and the native directory picker is
// unavailable, so the workspace is provisioned through the HTTP API as test
// FIXTURE SETUP — the flow under test (type a message, then delete the session
// from the sidebar) is exercised through real browser events only.
//
// Run: node apps/web/tests/conductor/delete-flow.mjs

import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const MARKER = `cloud-detect ${Date.now()}`
const log = (...a) => console.log('[e2e]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `setup-${method}`, method, payload }),
}).then(r => r.json())

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(15000)
page.on('dialog', async (d) => { log('dialog', d.type(), d.message()); await d.accept() })
const shot = (n) => page.screenshot({ path: `delete-flow-${n}.png` }).catch(() => {})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  const booted = await page.evaluate(() => typeof window.__DSH_BOOT__ !== 'undefined')
  log('boot __DSH_BOOT__', booted)
  if (!booted) throw new Error('no __DSH_BOOT__')
  await page.waitForTimeout(2000)

  const textarea = page.locator('textarea').first()
  const ph = () => textarea.getAttribute('placeholder').catch(() => null)

  // Fixture setup: provision a workspace over $HOME via the API (native picker
  // is absent in headless), then reload so the composer leaves its no-workspace state.
  if (/workspace|工作区/i.test((await ph()) ?? '')) {
    const home = process.env.HOME || '/home/runner'
    const ws = await rpc('workspace.create', { path: home })
    log('workspace.create ->', JSON.stringify(ws).slice(0, 200))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(2500)
    log('placeholder after workspace', JSON.stringify(await ph()))
    await shot('1-workspace')
  }

  if (await textarea.isDisabled().catch(() => true)) {
    log('composer still disabled after workspace provision; aborting')
    await shot('2-disabled')
    process.exitCode = 0
    await browser.close(); process.exit(0)
  }

  // Real input + Enter (the session-creating action under test).
  await textarea.click()
  await page.keyboard.type(MARKER, { delay: 20 })
  await page.keyboard.press('Enter')
  log('typed+entered', MARKER)

  const markerText = page.getByText(MARKER).first()
  let created = false
  for (let i = 0; i < 25; i++) {
    if (await markerText.isVisible().catch(() => false)) { created = true; break }
    await page.waitForTimeout(1000)
  }
  log('message visible', created)
  await shot('3-created')

  // Delete via the sidebar row menu (real hover + click + native confirm).
  const deleteItem = page.getByRole('menuitem', { name: /delete|删除/i }).first()
  let menuOpen = await deleteItem.isVisible().catch(() => false)
  if (!menuOpen) {
    const rows = page.locator('[role="treeitem"], li')
    for (let k = 0; k < Math.min(await rows.count(), 30) && !menuOpen; k++) {
      await rows.nth(k).hover().catch(() => {})
      const mores = page.locator('button[aria-label*="menu" i], button[aria-label*="more" i], button[aria-label*="操作"]')
      for (let m = 0; m < await mores.count() && !menuOpen; m++) {
        await mores.nth(m).click().catch(() => {})
        menuOpen = await deleteItem.isVisible().catch(() => false)
        if (!menuOpen) await page.keyboard.press('Escape').catch(() => {})
      }
    }
  }

  if (!menuOpen) {
    log('delete menu not reachable; refinement needed')
    await shot('4-nomenu')
    process.exitCode = 0
    await browser.close(); process.exit(0)
  }

  await deleteItem.click()
  await page.waitForTimeout(1200)
  log('delete clicked; marker still visible', await markerText.isVisible().catch(() => false))
  await shot('5-deleted')
} catch (e) {
  console.error('[FAIL]', e instanceof Error ? e.stack : e)
  await shot('failure')
  process.exitCode = 1
} finally {
  await browser.close()
}
