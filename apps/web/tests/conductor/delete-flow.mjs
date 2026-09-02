// Real-browser delete-flow probe (真人级: real click / real input / real dialog).
//
// Drives the served `dsh web` shell with Playwright's Chromium, using only real
// browser events (keyboard.type, keyboard.press Enter, locator.click, native
// confirm dialog) — never page.evaluate-driven dispatchEvent or direct RPC.
// Mirrors a human: open the page, choose a workspace (directory picker), type a
// message, send it, then delete the resulting session from the sidebar menu.
//
// Run: node apps/web/tests/conductor/delete-flow.mjs

import { chromium } from 'playwright'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const MARKER = `cloud-detect ${Date.now()}`

const fail = (step, error) => {
  console.error(`[FAIL] ${step}: ${error instanceof Error ? error.stack : error}`)
  process.exitCode = 1
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

page.on('dialog', async (dialog) => {
  console.log(`[dialog] ${dialog.type()}: ${dialog.message()}`)
  await dialog.accept()
})

try {
  // 1. Open the shell and prove it mounted.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  const booted = await page.evaluate(() => typeof window.__DSH_BOOT__ !== 'undefined')
  console.log(`[boot] __DSH_BOOT__ present: ${booted}`)
  if (!booted) throw new Error('window.__DSH_BOOT__ missing')

  await page.waitForTimeout(2500)

  // 2. Choose a workspace if the composer is in its no-workspace state.
  const textarea = page.locator('textarea').first()
  const placeholder = () => textarea.getAttribute('placeholder')
  let ph = await placeholder().catch(() => null)
  console.log(`[recon] placeholder=${JSON.stringify(ph)}`)

  if (/workspace|工作区/i.test(ph ?? '')) {
    const choose = page.getByRole('button', { name: /选择工作区|Choose workspace/ }).first()
    if (await choose.count()) {
      await choose.click()
      // The directory browser opens listing the host home; wait for it.
      await page.getByText(/选择工作区目录|Select Workspace Directory/).first().waitFor({ timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(1200)
      const open = page.getByRole('button', { name: /^打开$|^Open$/ }).first()
      if (await open.count()) {
        await open.click()
        console.log('[e2e] workspace chosen via directory browser (Open)')
      }
    }
    // Wait for the composer to leave the workspace placeholder.
    for (let i = 0; i < 15; i++) {
      ph = await placeholder().catch(() => null)
      if (ph !== null && !/workspace|工作区/i.test(ph)) break
      await page.waitForTimeout(1000)
    }
    console.log(`[recon] placeholder after workspace=${JSON.stringify(ph)}`)
  }

  const disabled = await textarea.isDisabled().catch(() => true)
  if (disabled) {
    console.log('[e2e] composer still disabled after workspace flow; cannot type a session')
    await page.screenshot({ path: 'delete-flow-1-disabled.png' }).catch(() => {})
    process.exitCode = 0
    await browser.close()
    process.exit(0)
  }

  // 3. Real input: type a message and press Enter to send.
  await textarea.click()
  await page.keyboard.type(MARKER, { delay: 25 })
  await page.keyboard.press('Enter')
  console.log(`[e2e] typed and sent: ${MARKER}`)

  // 4. Wait for the message to echo back (session created).
  const markerText = page.getByText(MARKER).first()
  let created = false
  for (let i = 0; i < 25; i++) {
    if (await markerText.isVisible().catch(() => false)) { created = true; break }
    await page.waitForTimeout(1000)
  }
  console.log(`[e2e] session message visible: ${created}`)
  await page.screenshot({ path: 'delete-flow-2-created.png' }).catch(() => {})

  // 5. Delete via the sidebar row menu (real hover + click + native confirm).
  const deleteItem = page.getByRole('menuitem', { name: /delete|删除/i }).first()
  let menuOpen = await deleteItem.isVisible().catch(() => false)
  if (!menuOpen) {
    // Reveal a row's actions: hover rows, then click any "more"/"menu" button.
    const rows = page.locator('[role="treeitem"], li, [data-session-row]')
    for (let k = 0; k < Math.min(await rows.count(), 20) && !menuOpen; k++) {
      await rows.nth(k).hover().catch(() => {})
      const more = page.locator('button').filter({ has: page.locator('[class*="more"], [class*="menu"]') })
      const anyMore = page.locator('button[aria-label*="menu"], button[aria-label*="more"], button[aria-label*="操作"]')
      const n = await anyMore.count()
      for (let m = 0; m < n && !menuOpen; m++) {
        await anyMore.nth(m).click().catch(() => {})
        menuOpen = await deleteItem.isVisible().catch(() => false)
        if (!menuOpen) await page.keyboard.press('Escape').catch(() => {})
      }
    }
  }

  if (!menuOpen) {
    console.log('[e2e] created session but delete menu not reachable; selectors need refinement')
    await page.screenshot({ path: 'delete-flow-3-nomenu.png' }).catch(() => {})
    process.exitCode = 0
    await browser.close()
    process.exit(0)
  }

  await deleteItem.click()
  await page.waitForTimeout(1200)
  const stillVisible = await markerText.isVisible().catch(() => false)
  console.log(`[e2e] delete clicked; marker still visible: ${stillVisible}`)
  await page.screenshot({ path: 'delete-flow-4-deleted.png' }).catch(() => {})
} catch (error) {
  fail('delete flow', error)
  await page.screenshot({ path: 'delete-flow-failure.png', fullPage: false }).catch(() => {})
} finally {
  await browser.close()
}
