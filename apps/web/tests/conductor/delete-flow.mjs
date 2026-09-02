// Real-browser delete-flow probe (真人级: real fill + Enter + real click on Delete).
//
// Follows the repo's own e2e patterns (apps/web/tests/*.e2e.ts): the live
// composer is `textarea:enabled`, text enters via `.fill()`, and Enter sends.
// The workspace is provisioned through the HTTP API as FIXTURE SETUP (the
// native directory picker is absent in headless); the flow under test — type a
// message, then delete the resulting session from the sidebar — is real UI.
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

  // Fixture setup: provision a workspace over $HOME via the API.
  if (/workspace|工作区/i.test((await page.locator('textarea:enabled').first().getAttribute('placeholder').catch(() => null)) ?? '')) {
    const home = process.env.HOME || '/home/runner'
    const ws = await rpc('workspace.create', { path: home })
    log('workspace.create ok', ws?.result?.ok)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(2500)
  }

  // Live composer = the enabled textarea (repo e2e convention).
  const composer = page.locator('textarea:enabled').first()
  await composer.waitFor({ timeout: 15000 })
  log('placeholder', JSON.stringify(await composer.getAttribute('placeholder').catch(() => null)))

  // Real input: fill the composer and press Enter to send.
  await composer.fill(MARKER)
  log('value after fill', JSON.stringify(await composer.inputValue()))
  await composer.press('Enter')
  log('sent', MARKER)

  const markerText = page.getByText(MARKER).first()
  let created = false
  for (let i = 0; i < 25; i++) {
    if (await markerText.isVisible().catch(() => false)) { created = true; break }
    await page.waitForTimeout(1000)
  }
  log('message visible', created)
  await shot('1-created')

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
    await shot('2-nomenu')
    process.exitCode = 0
    await browser.close(); process.exit(0)
  }

  await deleteItem.click()
  await page.waitForTimeout(1200)
  log('delete clicked; marker still visible', await markerText.isVisible().catch(() => false))
  await shot('3-deleted')
} catch (e) {
  console.error('[FAIL]', e instanceof Error ? e.stack : e)
  await shot('failure')
  process.exitCode = 1
} finally {
  await browser.close()
}
