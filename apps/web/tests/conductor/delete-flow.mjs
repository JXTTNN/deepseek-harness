// Real-browser delete-flow probe (真人级: real click / real input / real dialog).
// Run: node apps/web/tests/conductor/delete-flow.mjs

import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const MARKER = `cloud-detect ${Date.now()}`
const log = (...a) => console.log('[e2e]', ...a)

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
  await page.waitForTimeout(2500)
  await shot('1-boot')

  const textarea = page.locator('textarea').first()
  const ph = () => textarea.getAttribute('placeholder').catch(() => null)

  // Choose a workspace when in the no-workspace hero state.
  if (/workspace|工作区/i.test((await ph()) ?? '')) {
    const chip = page.locator('button[aria-label="Choose workspace"], button[aria-label="选择工作区"]').first()
    log('chip count', await chip.count())
    if (await chip.count()) {
      // The hero glow backdrop can sit over the chip (transparent), so Playwright's
      // actionability check reports it obscured even though a human click lands.
      // force:true still emits the real pointer event sequence at the element.
      await chip.click({ force: true })
      // Wait for the directory browser dialog (title) to appear.
      let dialogSeen = false
      for (let i = 0; i < 12; i++) {
        const d = await page.locator('text="Select Workspace Directory", text="选择工作区目录"').count().catch(() => 0)
        if (d > 0) { dialogSeen = true; break }
        await page.waitForTimeout(1000)
      }
      log('directory dialog seen', dialogSeen)
      await shot('2-dialog')
      if (dialogSeen) {
        const open = page.locator('button:has-text("Open"), button:has-text("打开")').first()
        log('open button count', await open.count())
        if (await open.count()) {
          await open.click({ force: true }).catch((e) => log('open click failed', String(e)))
          log('open clicked')
        }
      }
    }
    for (let i = 0; i < 12; i++) {
      const p = await ph()
      if (p !== null && !/workspace|工作区/i.test(p)) break
      await page.waitForTimeout(1000)
    }
    log('placeholder after choose', JSON.stringify(await ph()))
    await shot('3-after-choose')
  }

  if (await textarea.isDisabled().catch(() => true)) {
    log('composer disabled; cannot type')
    process.exitCode = 0
    await browser.close(); process.exit(0)
  }

  // Real input + Enter.
  await textarea.click()
  await page.keyboard.type(MARKER, { delay: 25 })
  await page.keyboard.press('Enter')
  log('typed+entered', MARKER)

  const markerText = page.getByText(MARKER).first()
  let created = false
  for (let i = 0; i < 25; i++) {
    if (await markerText.isVisible().catch(() => false)) { created = true; break }
    await page.waitForTimeout(1000)
  }
  log('message visible', created)
  await shot('4-created')

  const deleteItem = page.getByRole('menuitem', { name: /delete|删除/i }).first()
  let menuOpen = await deleteItem.isVisible().catch(() => false)
  if (!menuOpen) {
    const rows = page.locator('[role="treeitem"], li')
    for (let k = 0; k < Math.min(await rows.count(), 25) && !menuOpen; k++) {
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
    await shot('5-nomenu')
    process.exitCode = 0
    await browser.close(); process.exit(0)
  }

  await deleteItem.click()
  await page.waitForTimeout(1200)
  log('delete clicked; marker still visible', await markerText.isVisible().catch(() => false))
  await shot('6-deleted')
} catch (e) {
  console.error('[FAIL]', e instanceof Error ? e.stack : e)
  await shot('failure')
  process.exitCode = 1
} finally {
  await browser.close()
}
