// Real-person team-mode UI end-to-end: open the live `dsh web` shell in a real
// browser, click "New session", select the Team preset (or downgrade to an RPC
// session.create({agentPreset:"team"}) when the headless picker is
// unreachable), type a team-collaboration goal into the composer, click Send,
// then poll session.history and assert the agent made >=2 distinct team_* tool
// calls end-to-end.
//
// Run: node apps/web/tests/conductor/team-ui-e2e.mjs

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.DSH_WEB_URL != null ? process.env.DSH_WEB_URL : 'http://127.0.0.1:8300'
const SID = 'team-ui-' + Date.now()
const log = (...a) => console.log('[team-ui]', ...a)
// Spec: poll the event log for up to 180s.
const TURN_TIMEOUT_MS = Number(process.env.TEAM_UI_TIMEOUT_MS != null ? process.env.TEAM_UI_TIMEOUT_MS : 180000)

// Exact collaboration goal typed into the composer (Chinese per spec).
const GOAL = '你是 team lead。先用 team_list 找到你的队友，然后用 team_send 给任意一名队友发一条消息，最后用 team_inbox 等回复并汇报结果。'

const rpc = (method, payload) => {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'tu-' + method, method, payload })
  return fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(r => r.json())
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
page.setDefaultTimeout(20000)
page.on('console', (m) => { if (m.type() === 'error') log('browser', m.text().slice(0, 200)) })
page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 200)))

const home = process.env.HOME || tmpdir()
mkdirSync(join(home, 'team-ui-ws'), { recursive: true })

const shot = (name) => page.screenshot({ path: 'team-ui-' + name + '.png' }).catch(() => {})

// Module-scoped so the catch block can dump diagnostics from the last poll.
let events = []

async function history(sid) {
  const hist = await rpc('session.history', { sessionId: sid })
  return hist?.result?.value?.events ?? []
}

async function teamSessionId() {
  const list = await rpc('session.list', {})
  const items = list?.result?.value?.items ?? []
  for (const it of items) {
    if (it.agentPreset === 'team' && it.sessionId != null) return it.sessionId
  }
  return undefined
}

function teamToolNames(events) {
  const names = new Set()
  for (const e of events) {
    const t = e?.event?.type
    if (t === 'tool/call' || t === 'tool/result') {
      const n = e?.event?.data?.name ?? e?.event?.data?.tool ?? e?.event?.data?.call?.name
      if (typeof n === 'string' && n.startsWith('team_')) names.add(n)
    }
  }
  return names
}

function dumpDiagnostics(events) {
  const retries = events.filter(e => e?.event?.type === 'llm/retry')
  for (const e of retries.slice(-3)) {
    const f = e?.event?.data?.failure ?? {}
    log('llm/retry', JSON.stringify({ retry: e?.event?.data?.retry, code: f.code, status: f.status, message: f.message }))
  }
  const chunks = events.filter(e => e?.event?.type === 'assistant/chunk')
    .map(e => e?.event?.data?.chunk?.text ?? e?.event?.data?.text ?? '').join('')
  if (chunks.length > 0) log('assistant (first 500):', JSON.stringify(chunks.slice(0, 500)))
  const msgs = events.filter(e => e?.event?.type === 'assistant/message')
  for (const m of msgs.slice(-2)) {
    log('assistant/message (first 500):', JSON.stringify(m?.event?.data?.message ?? m?.event?.data ?? '').slice(0, 500))
  }
}

try {
  await rpc('workspace.create', { path: home }).catch(() => {})

  // ── Phase 0: boot the live shell ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(3000)
  await shot('00-boot')
  const booted = await page.evaluate(() => typeof window.__DSH_BOOT__ !== 'undefined').catch(() => false)
  log('phase 0 boot ok, boot injection', booted)

  // ── Phase 1: connect a workspace (UI picker, RPC fallback) ──
  const wsTrigger = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ })
    .or(page.getByRole('button', { name: /^(Choose workspace|选择工作区)$/ }))
  if (await wsTrigger.count() > 0) {
    await wsTrigger.first().click().catch(() => {})
    await page.waitForTimeout(800)
    const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
    if (await dialog.count() > 0) {
      const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
      await pathInput.fill(home).catch(() => {})
      await pathInput.press('Enter').catch(() => {})
      await dialog.getByRole('button', { name: /^(Open|打开)$/, exact: true }).click().catch(() => {})
      log('workspace connected via UI picker')
    } else {
      await page.keyboard.press('Escape').catch(() => {})
      await rpc('workspace.create', { path: home }).catch(() => {})
      log('DOWNGRADE: workspace picker dialog unreachable; used workspace.create RPC')
    }
  } else {
    await rpc('workspace.create', { path: home }).catch(() => {})
    log('no workspace UI trigger; used workspace.create RPC')
  }
  await page.waitForTimeout(1500)

  // ── Phase 2a: New session (UI click, two-level fallback) ──
  // Level 1: button by aria-label / visible text.
  const newSessionBtn = page.getByRole('button', { name: /^(New session|新会话|新建会话)$/ }).first()
  let clickedNew = false
  if (await newSessionBtn.count() > 0) {
    await newSessionBtn.click().catch(() => {})
    clickedNew = true
    log('clicked New session via UI (level 1: button role)')
  } else {
    // Level 2: any clickable element carrying the text (non-button affordance).
    const alt = page.getByText(/^(New session|新会话|新建会话)$/).first()
    if (await alt.count() > 0) {
      await alt.click().catch(() => {})
      clickedNew = true
      log('clicked New session via UI (level 2: text locator)')
    }
  }
  if (!clickedNew) {
    log('DOWNGRADE: New session button unreachable via UI; will create team session via RPC')
  }
  await page.waitForTimeout(1500)

  // ── Phase 2b: pick the Team preset from the preset menu (UI path) ──
  let sid = await teamSessionId()
  if (sid == null) {
    const presetTrigger = page.getByRole('button', {
      name: /^(Standard mode|Minimal mode|Team mode|标准模式|极简模式|Team 模式)$/,
    }).first()
    if (await presetTrigger.count() > 0) {
      await presetTrigger.click().catch(() => {})
      await page.waitForTimeout(500)
      const teamItem = page.getByRole('menuitem', { name: /^(Team mode|Team 模式)$/ }).first()
      if (await teamItem.count() > 0) {
        await teamItem.click().catch(() => {})
        await page.waitForTimeout(800)
        log('selected Team preset via UI menu')
      } else {
        await page.keyboard.press('Escape').catch(() => {})
      }
    }
    sid = await teamSessionId()
  }

  // ── Phase 2c: DOWNGRADE to RPC session.create({agentPreset:"team"}) ──
  if (sid == null) {
    log('DOWNGRADE: Team preset not selectable via UI in headless CI; using session.create({agentPreset:"team"}) RPC')
    const created = await rpc('session.create', { sessionId: SID, cwd: home, agentPreset: 'team' })
    if (!created?.result?.ok) {
      log('FAIL: session.create team failed')
      await shot('99-error')
      process.exit(1)
    }
    sid = SID
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(2000)
    const row = page.locator('text=' + SID).first()
    if (await row.count() > 0) {
      await row.click().catch(() => {})
      await page.waitForTimeout(1000)
      log('opened team session in browser by id')
    }
  }
  log('active team session id', sid)

  // ── Phase 3: type the team goal into the composer ──
  const composer = page.locator('textarea:enabled').last()
  if (await composer.count() === 0) {
    log('FAIL: no enabled composer textarea')
    await shot('99-error')
    process.exit(1)
  }
  await composer.click().catch(() => {})
  await composer.fill(GOAL)
  const entered = await composer.inputValue().catch(() => '')
  log('composer matches goal:', entered === GOAL)
  await shot('04-before-send')

  // ── Phase 4: click Send, screenshot after send ──
  const sendBtn = page.getByRole('button', { name: /^(Send message|发送消息)$/, exact: true }).first()
  if (await sendBtn.count() === 0 || await sendBtn.isDisabled().catch(() => true)) {
    log('FAIL: send button missing or disabled')
    await shot('99-error')
    process.exit(1)
  }
  await sendBtn.click()
  await shot('05-after-send')
  log('sent team goal to session', sid)

  // ── Phase 5: poll session.history, assert >=2 distinct team_* tool calls ──
  const deadline = Date.now() + TURN_TIMEOUT_MS
  events = []
  const distinctTeamTools = new Set()
  let settled = false
  while (Date.now() < deadline) {
    events = await history(sid)
    // Accumulate distinct team_* tool names across every poll (a non-team tool
    // call or turn/end must not short-circuit the search before both team_*
    // calls appear in the stream).
    for (const n of teamToolNames(events)) distinctTeamTools.add(n)
    if (distinctTeamTools.size >= 2) {
      settled = true
      break
    }
    if (events.some(e => e?.event?.type === 'turn/end')) {
      // Turn closed without enough team_* calls; stop polling early.
      settled = true
      break
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  log('turn settled', settled)
  await shot('06-before-assert')

  log('distinct team_* tools', JSON.stringify([...distinctTeamTools]))
  if (distinctTeamTools.size < 2) {
    dumpDiagnostics(events)
    log('FAIL: fewer than 2 distinct team_* tool calls; saw', JSON.stringify([...distinctTeamTools]))
    await shot('99-error')
    process.exit(1)
  }
  log('PASS: agent invoked >=2 distinct team_* tools end-to-end:', JSON.stringify([...distinctTeamTools]))
  process.exit(0)
} catch (e) {
  console.error('[team-ui][FAIL]', e instanceof Error ? e.stack : e)
  await shot('99-error').catch(() => {})
  try { dumpDiagnostics(events) } catch { /* ignore */ }
  process.exit(1)
} finally {
  await browser.close()
}
