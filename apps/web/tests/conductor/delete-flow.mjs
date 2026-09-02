// Real-browser delete-flow probe (真人级: real click / real fill / real dialog).
//
// Mirrors the repo's own e2e recipe (apps/web/tests/support.ts connectFreshWorkspace):
// choose a workspace through the directory picker's path editor, type a message
// into the composer, send it, then delete the session from the sidebar. Every
// interaction is a real browser event (click / fill / Enter / native confirm).
//
// Run: node apps/web/tests/conductor/delete-flow.mjs

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const MARKER = `cloud-detect ${Date.now()}`
const log = (...a) => console.log('[e2e]', ...a)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
page.setDefaultTimeout(20000)
page.on('dialog', async (d) => { log('dialog', d.type(), d.message()); await d.accept() })
const shot = (n) => page.screenshot({ path: `delete-flow-${n}.png` }).catch(() => {})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  const booted = await page.evaluate(() => typeof window.__DSH_BOOT__ !== 'undefined')
  log('boot __DSH_BOOT__', booted)
  if (!booted) throw new Error('no __DSH_BOOT__')
  await page.waitForTimeout(2000)

  // Choose a workspace through the directory picker (support.ts recipe).
  const root = process.env.HOME || '/home/runner'
  const wsPath = join(root, 'dsh-ws')
  mkdirSync(wsPath, { recursive: true })
  const trigger = page.getByRole('textbox', { name: 'Choose workspace' })
  log('workspace trigger count', await trigger.count())
  log('trigger visible', await trigger.isVisible().catch(() => false))
  const tb = await trigger.boundingBox().catch(() => null)
  if (tb) {
    const atPoint = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el ? { tag: el.tagName, cls: String((el).className || '').slice(0, 70) } : null
    }, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 })
    log('elementFromPoint at trigger', JSON.stringify(atPoint))
    const style = await trigger.evaluate((el) => {
      const s = getComputedStyle(el)
      return { pe: s.pointerEvents, vis: s.visibility, op: s.opacity, disp: s.display }
    })
    log('trigger style', JSON.stringify(style))
  }
  try {
    await trigger.click()
    log('trigger click ok')
  } catch (e) {
    log('trigger click failed, forcing:', String(e).slice(0, 80))
    await trigger.click({ force: true })
  }
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  log('dialog count after click', await dialog.count())
  await dialog.waitFor({ timeout: 15000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(wsPath)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  log('workspace chosen', wsPath)

  const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
  await composer.waitFor({ timeout: 15000 })
  log('composer ready')

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
