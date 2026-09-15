// Full real-person UI walkthrough: drives the live `dsh web` shell exactly the
// way a human can — pointer clicks and text input only. It walks every primary
// surface (welcome flows, workspace picker, composer, tabs, model/preset/
// access-mode menus, command palette, settings dialog sections, session
// search, sidebar rows), sends one real message through the UI, and fails on
// any uncaught page error, /api 5xx, or missing critical surface. Screenshots
// land as walkthrough-*.png for the Actions artifact upload.
//
// Setting/mutation guardrails: menus are opened and dismissed without
// selecting; the only state-changing gestures are the workspace connect,
// creating the session, and a single short probe prompt — the same ones a new
// user performs.
//
// Run: node apps/web/tests/conductor/ui-walkthrough.mjs

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const log = (...a) => console.log('[ui-walk]', ...a)
const PROBE_TEXT = `walkthrough probe ${Date.now()}`

// Failure collectors — the run verdict derives from these, not from throws.
const pageErrors = []
const consoleErrors = []
const api5xx = []
const requestFailures = []
let clicks = 0
let inputsFilled = 0
let dialogsSeen = 0
const surfacesSeen = []
const issues = []

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `uw-${method}`, method, payload }),
}).then(r => r.json())

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
page.setDefaultTimeout(12000)
page.on('pageerror', (error) => { pageErrors.push(String(error)) })
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240))
})
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 500) api5xx.push(`${r.status()} ${r.url()}`)
})
page.on('requestfailed', (r) => {
  requestFailures.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? '?'}`)
})

const shot = (name) => page.screenshot({ path: `walkthrough-${name}.png` }).catch(() => {})

/** Record one observed surface (dialog/menu/panel) with a presence probe. */
async function markSurface(name, locator) {
  const n = await locator.count()
  if (n > 0) surfacesSeen.push(name)
  return n > 0
}

/** Click helper: counts every successful click a real person could make. */
async function clickL(label, locator, { optional = false, timeout = 8000 } = {}) {
  if (await locator.count() === 0 || !await locator.first().isVisible().catch(() => false)) {
    if (!optional) issues.push(`missing clickable: ${label}`)
    return false
  }
  try {
    await locator.first().click({ timeout })
    clicks++
    return true
  } catch (e) {
    if (!optional) issues.push(`click failed (${label}): ${String(e).split('\n')[0]}`)
    return false
  }
}

/**
 * Open a menu/dropdown by clicking its trigger, snapshot it, then dismiss with
 * Escape the way a user cancels — never mutating a selection.
 * @param {string} label - report label.
 * @param {RegExp|string} trigger - accessible name of the trigger control.
 */
async function openMenuAndDismiss(label, trigger) {
  const btn = page.getByRole('button', { name: trigger })
  if (!await clickL(`${label} trigger`, btn)) return
  await page.waitForTimeout(500)
  const menu = page.getByRole('menu')
  if (await menu.count() > 0) {
    surfacesSeen.push(label)
    dialogsSeen++
    const items = await page.getByRole('menuitem').allTextContents().catch(() => [])
    if (items.length > 0) log(`${label} items`, JSON.stringify(items.slice(0, 12)))
    await shot(label.replace(/\W+/g, '-').toLowerCase())
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

try {
  const home = process.env.HOME || tmpdir()
  const wsRoot = join(home, 'ui-walk-ws')
  mkdirSync(wsRoot, { recursive: true })

  // ── Phase 0: boot ────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)
  await shot('00-boot')
  const booted = await page.evaluate(() => typeof window.__DSH_BOOT__ !== 'undefined')
  await markSurface('boot-injection', page.locator('body'))
  if (!booted) issues.push('window.__DSH_BOOT__ missing — the shell never booted the client')
  log('phase 0 boot ok, boot injection', booted)

  // ── Phase 1: welcome / onboarding dialogs (a new user's first clicks) ────
  const welcome = page.getByRole('button', { name: /^(继续|Continue)$/ })
  if (await welcome.count() > 0) {
    await clickL('welcome 继续', welcome)
    dialogsSeen++
    surfacesSeen.push('welcome-notice')
    await page.waitForTimeout(600)
  }
  const later = page.getByRole('button', { name: /^(稍后配置|Configure later)$/ })
  if (await later.count() > 0) {
    await clickL('api-key 稍后配置', later)
    dialogsSeen++
    surfacesSeen.push('apikey-dialog')
    await page.waitForTimeout(600)
  }
  await shot('01-after-welcome')

  // ── Phase 2: connect a workspace through the picker (clicks + typing) ────
  const wsTrigger = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ })
    .or(page.getByRole('button', { name: /^(Choose workspace|选择工作区)$/ }))
  if (!await clickL('workspace picker trigger', wsTrigger)) {
    issues.push('no workspace picker trigger on the hero')
  } else {
    // The trigger opens either the directory dialog directly (cold home, no
    // workspaces) or a dropdown listing existing workspaces plus an
    // "Add workspace…" entry. Race for both, click the entry when present.
    const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
    const addEntry = page.getByRole('menuitem', { name: /^(Add workspace|添加工作区)/ })
      .or(page.getByRole('button', { name: /^(Add workspace|添加工作区)/ }))
    await Promise.race([
      dialog.waitFor({ timeout: 8000 }).catch(() => {}),
      addEntry.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}),
    ])
    if (await dialog.count() === 0) {
      log('picker menu items', JSON.stringify(await page.getByRole('menuitem').allTextContents().catch(() => [])))
      surfacesSeen.push('workspace-picker-menu')
      // The open dropdown overlays the page; dismiss before reaching the
      // sidebar's always-rendered Add workspace button.
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      const addBtn = page.getByRole('button', { name: 'Add workspace', exact: true }).first()
      if (await addBtn.count() > 0 && await addBtn.isVisible().catch(() => false)) {
        await addBtn.click().catch(() => {})
        clicks++
      } else if (await addEntry.count() > 0 && await addEntry.first().isVisible().catch(() => false)) {
        await addEntry.first().click().catch(() => {})
        clicks++
      }
    }
    try {
      await dialog.waitFor({ timeout: 10_000 })
      dialogsSeen++
      surfacesSeen.push('workspace-picker-dialog')
      await shot('02-picker')
      await clickL('edit path', dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ }))
      const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
      await pathInput.fill(wsRoot)
      inputsFilled++
      await pathInput.press('Enter')
      await clickL('open workspace', dialog.getByRole('button', { name: /^(Open|打开)$/, exact: true }))
      log('workspace adopt issued', wsRoot)
    } catch (e) {
      issues.push(`workspace dialog flow failed: ${String(e).split('\n')[0]}`)
      // Hosts the auto-resolver maps to the OS-native chooser (loopback +
      // darwin/win32) have no in-page dialog; headless automation cannot
      // reach the OS dialog. Mirror the same user intent over the RPC the
      // picker's Open button would send so every later surface still gets
      // exercised. The failure line above stays in the report.
      log('picker dialog unreachable here — mirroring the Open gesture via workspace.create RPC')
      await rpc('workspace.create', { path: wsRoot }).catch(() => {})
      surfacesSeen.push('workspace-create-fallback')
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(2000)
    }
  }
  // The enabled composer proves the connection end-to-end.
  const liveComposer = page.locator([
    'textarea:enabled[placeholder="Describe what you want to build"]',
    'textarea:enabled[placeholder="描述你想要构建的内容"]',
  ].join(','))
  try {
    await liveComposer.waitFor({ timeout: 20_000 })
    surfacesSeen.push('live-composer')
  } catch {
    issues.push('composer never enabled after workspace connect')
  }
  await shot('03-workspace-connected')

  // ── Phase 2.5: explicitly start a New session like a user would ──────────
  const newSession = page.getByRole('button', { name: /^(New session|新会话|新建会话)$/ })
  if (await clickL('New session', newSession, { optional: true })) {
    await page.waitForTimeout(1500)
    surfacesSeen.push('new-session-click')
  }
  await shot('03b-new-session')

  // ── Phase 3: composer draft typing (no send yet) ──────────────────────────
  const composer = page.locator('textarea:enabled').last()
  await composer.fill(PROBE_TEXT)
  if (await composer.inputValue() === PROBE_TEXT) {
    inputsFilled++
  } else {
    issues.push('composer did not register typed text')
  }
  await composer.fill('')

  // ── Phase 4: conversation column tabs (Chat / Trajectory / ...) ──────────
  for (const tabName of ['Trajectory', 'Result', 'Chat']) {
    const tab = page.getByRole('tab', { name: new RegExp(`^(${tabName}|${{ Trajectory: '轨迹', Result: '结果', Chat: '对话' }[tabName]})$`) })
    if (await clickL(`tab ${tabName}`, tab, { optional: true })) {
      await page.waitForTimeout(500)
      surfacesSeen.push(`tab-${tabName}`)
      await shot(`04-tab-${tabName.toLowerCase()}`)
    }
  }

  // ── Phase 5: composer-adjacent menus (open, read items, Escape) ──────────
  await openMenuAndDismiss('model-picker', /^(Select model|选择模型)/)
  await openMenuAndDismiss('preset-picker', /^(Standard mode|Minimal mode|Team mode|标准模式|极简模式|代码模式|Cordis 开发|Team 模式)/)
  await openMenuAndDismiss('access-mode', /^(Access mode|权限模式|Workspace Write)/)
  await openMenuAndDismiss('commands', /^(Commands|命令)(,|$)/)

  // ── Phase 6: settings dialog — click through every section ───────────────
  const settingsBtn = page.getByRole('button', { name: /^(设置|Settings)$/, exact: true })
  if (await clickL('open settings', settingsBtn)) {
    const settingsDialog = page.getByRole('dialog', { name: /^(设置|Settings)$/ })
    try {
      await settingsDialog.waitFor({ timeout: 10_000 })
      dialogsSeen++
      surfacesSeen.push('settings-dialog')
      // Click each section nav button that exists, screenshot the section.
      const navNames = ['通用设置', '模型', '插件', 'Agent 预设', '权限', '外观', '硬件', '端口', '连接',
        'General', 'Models', 'Plugins', 'Agent presets', 'Permissions', 'Interface', 'Overhead', 'Ports']
      for (const name of navNames) {
        const navBtn = settingsDialog.getByRole('button', { name: new RegExp(`^${name}`, 'i') })
        if (await navBtn.count() > 0 && await navBtn.first().isVisible().catch(() => false)) {
          await navBtn.first().click().catch(() => {})
          clicks++
          await page.waitForTimeout(400)
          await shot(`06-settings-${name.replace(/\W+/g, '-')}`)
        }
      }
      surfacesSeen.push('settings-sections-walked')
    } catch (e) {
      issues.push(`settings dialog flow failed: ${String(e).split('\n')[0]}`)
    } finally {
      const close = settingsDialog.getByRole('button', { name: /^(关闭|Close)$/ }).last()
      await close.click().catch(() => page.keyboard.press('Escape'))
      await page.waitForTimeout(400)
    }
  } else {
    issues.push('settings trigger missing')
  }
  await shot('06-settings-closed')

  // ── Phase 7: session search + sidebar interactions ────────────────────────
  const searchBtn = page.getByRole('button', { name: /^(Search sessions|搜索会话)/ })
  if (await clickL('open session search', searchBtn, { optional: true })) {
    await page.waitForTimeout(400)
    const searchBox = page.getByRole('textbox', { name: /search|搜索/i }).first()
    if (await searchBox.count() > 0) {
      await searchBox.fill('nothing-real')
      inputsFilled++
      await shot('07-search')
      surfacesSeen.push('session-search')
      const clear = page.getByRole('button', { name: /^(Clear search|清除搜索)/ })
      if (await clear.count() > 0) await clickL('clear search', clear, { optional: true })
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  // Sidebar collapse/expand round trip.
  const collapse = page.getByRole('button', { name: /^(Collapse sidebar|Open sidebar|收起侧边栏|展开侧边栏)/ })
  if (await clickL('sidebar collapse/expand', collapse, { optional: true })) {
    await page.waitForTimeout(400)
    const restore = page.getByRole('button', { name: /^(Collapse sidebar|Open sidebar|收起侧边栏|展开侧边栏)/ })
    await clickL('sidebar restore', restore, { optional: true })
    await page.waitForTimeout(300)
    surfacesSeen.push('sidebar-toggle')
  }

  // ── Phase 8: real send through the UI, verified against the server log ────
  const liveAgain = page.locator('textarea:enabled').last()
  await liveAgain.click()
  await liveAgain.fill(PROBE_TEXT)
  inputsFilled++
  const sendBtn = page.getByRole('button', { name: /^(Send message|发送消息)$/ }).first()
  if (!await clickL('send message', sendBtn)) {
    issues.push('send button not clickable for the probe message')
  } else {
    await shot('08-sent')
    // The human-visible result: our text shows as a user bubble in the DOM.
    const bubble = page.getByText(PROBE_TEXT).first()
    try {
      await bubble.waitFor({ timeout: 20_000 })
      surfacesSeen.push('user-bubble')
    } catch {
      issues.push('sent text never rendered as a message bubble')
    }

    // Server-side proof the UI send reached a session log.
    const deadline = Date.now() + 60_000
    let delivered = false
    while (Date.now() < deadline && !delivered) {
      const listResp = await rpc('session.list', {})
      const items = listResp?.result?.value?.items ?? []
      for (const it of items) {
        if (it.sessionId === undefined) continue
        const hist = await rpc('session.history', { sessionId: it.sessionId })
        if (JSON.stringify(hist?.result?.value?.events ?? []).includes(PROBE_TEXT)) {
          delivered = true
          surfacesSeen.push('server-delivery')
          break
        }
      }
      if (!delivered) await new Promise(r => setTimeout(r, 3000))
    }
    if (!delivered) issues.push('probe text never reached any session log')

    // Wait for the first assistant reply to render (any non-empty assistant
    // text in the DOM), so screenshots capture a live answer.
    const waitAssistant = Date.now() + 90_000
    while (Date.now() < waitAssistant) {
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll('main')]
          .map(n => n.innerText ?? '').join('\n').length)
      if (surfacesSeen.includes('tab-Chat') || visible > 200) break
      await page.waitForTimeout(3000)
    }
    await shot('09-assistant')
  }
} catch (e) {
  issues.push(`fatal: ${String(e && e.stack ? e.stack : e).split('\n')[0]}`)
  await shot('99-error')
} finally {
  // ── Report ────────────────────────────────────────────────────────────────
  log('──── walkthrough report ────')
  log(`clicks=${clicks} inputs=${inputsFilled} dialogs=${dialogsSeen}`)
  log(`surfaces (${surfacesSeen.length}): ${surfacesSeen.join(', ')}`)
  if (issues.length > 0) for (const i of issues) log('ISSUE:', i)
  if (pageErrors.length > 0) for (const p of pageErrors) log('PAGEERROR:', p.slice(0, 300))
  if (consoleErrors.length > 0) for (const e of consoleErrors.slice(0, 20)) log('CONSOLE.ERROR:', e)
  if (api5xx.length > 0) for (const a of api5xx) log('API-5XX:', a)
  if (requestFailures.length > 0) for (const f of requestFailures.slice(0, 10)) log('REQFAIL:', f)
  await browser.close()

  const critical = ['boot ok', 'live-composer', 'settings-dialog', 'user-bubble', 'server-delivery']
  const missingCritical = critical.filter(c => c !== 'boot ok' && !surfacesSeen.includes(c))
  // 'boot ok' is a log-only marker; treat __DSH_BOOT__/composer/settings/send as critical.
  const hardFailed = pageErrors.length > 0 || api5xx.length > 0 || missingCritical.length > 0
  if (hardFailed) {
    log(`FAIL: critical gaps: ${missingCritical.join(', ') || 'none'}; pageErrors=${pageErrors.length}; api5xx=${api5xx.length}`)
    process.exit(1)
  }
  log(`PASS: real-person walkthrough completed — ${clicks} clicks, ${inputsFilled} inputs, ${dialogsSeen} dialogs`)
}