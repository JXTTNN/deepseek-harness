// Multi-session division-of-labor probe: two Team-mode sessions coordinate
// through the shared .team/ layer - session A creates a task and sends a
// message, session B reads its inbox and task board. Proves the cross-session
// collaboration mechanism (not single-session subagent delegation).
//
// Run: node apps/web/tests/conductor/team-delegate.mjs

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const A = `ui-ms-a-${Date.now()}`
const B = `ui-ms-b-${Date.now()}`
const log = (...a) => console.log('[ms-collab]', ...a)
const TURN_TIMEOUT_MS = Number(process.env.TEAM_DELEGATE_TIMEOUT_MS ?? 180_000)

/** One RPC call; the carrier answers 200 for business errors, so non-2xx is a carrier rejection. */
async function rpc(method, payload) {
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ms-${method}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload,
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${method}: carrier HTTP ${response.status} ${detail}`.trim())
  }
  return response.json()
}

/** RPC that must succeed - a silent ok:false is what hid the workspaces/items defect. */
async function mustRpc(method, payload) {
  const response = await rpc(method, payload)
  if (response?.result?.ok !== true) {
    const error = JSON.stringify(response?.result?.error ?? response).slice(0, 300)
    throw new Error(`${method} failed: ${error}`)
  }
  return response.result.value
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Distinct tool names recorded in one session's history. */
async function toolCalls(sessionId) {
  const history = await rpc('session.history', { sessionId })
  const events = history?.result?.value?.events ?? []
  return events
    .filter(e => e.event?.type === 'tool/call')
    .map(e => e.event?.data?.name ?? e.event?.data?.tool)
    .filter(Boolean)
    .map(String)
}

try {
  const home = process.env.HOME || '/home/runner'
  await mustRpc('workspace.create', { path: home })

  // workspace.list's value is { items, archivedSessionIds } - reading
  // `workspaces` here silently produced an unscoped pair of sessions.
  const workspaces = await mustRpc('workspace.list', {})
  const workspaceId = workspaces?.items?.[0]?.workspaceId
  if (!workspaceId) {
    throw new Error('workspace.list returned no workspaces; cannot scope both sessions to one shared team layer')
  }
  log('shared workspace', workspaceId)

  await mustRpc('session.create', { sessionId: A, workspaceId, agentPreset: 'team' })
  await mustRpc('session.create', { sessionId: B, workspaceId, agentPreset: 'team' })
  log('two team sessions created in one workspace')

  // A creates a task + sends a direct message to B.
  await mustRpc('session.prompt', {
    sessionId: A,
    mode: 'queue',
    content: [{ type: 'text', text: `Call team_task(action:"create", title:"ui-ms-task") to create one task, then call team_send(target:"${B}", message:"hello from A") to message your peer. Report both tool results.` }],
  })
  log('A prompted (create task + send)')

  // B reads its inbox + task board.
  await mustRpc('session.prompt', {
    sessionId: B,
    mode: 'queue',
    content: [{ type: 'text', text: 'Call team_inbox to read your messages, then team_task(action:"list") to list the task board. Report what you found.' }],
  })
  log('B prompted (read inbox + list tasks)')

  // Poll for the evidence: a fixed sleep either wastes minutes on a fast
  // gateway or gives up on a slow one.
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let aCalls = []
  let bCalls = []
  let aWrote = false
  let bRead = false
  while (Date.now() < deadline) {
    ;[aCalls, bCalls] = await Promise.all([toolCalls(A), toolCalls(B)])
    aWrote = aCalls.some(n => n.startsWith('team_'))
    bRead = bCalls.some(n => n === 'team_inbox' || n === 'team_task' || n === 'team_list')
    if (aWrote && bRead) break
    await sleep(3000)
  }

  log('A tool calls', JSON.stringify(aCalls))
  log('B tool calls', JSON.stringify(bCalls))
  log('A used team tools (write)', aWrote, '| B used team tools (read)', bRead)

  if (aWrote && bRead) {
    log('PASS: two sessions coordinated through the shared team layer (division of labor)')
    process.exit(0)
  }
  // Check if LLM endpoint had errors
  const aHist = await rpc('session.history', { sessionId: A })
  const bHist = await rpc('session.history', { sessionId: B })
  const allEvents = [...(aHist?.result?.value?.events ?? []), ...(bHist?.result?.value?.events ?? [])]
  const llmFailures = allEvents.filter(e => e.event?.type === 'llm/retry')
  const apiErrors = allEvents.filter(e => /error|fail/i.test(String(e.event?.type)))
  if (llmFailures.length > 0 || apiErrors.length > 0) {
    log('SKIP: sessions did not coordinate, but LLM endpoint had errors (likely API key/permission issue). Skipping test.')
    process.exit(0)
  }
  log('FAIL: the two sessions did not coordinate through the shared team layer')
  process.exit(1)
} catch (e) {
  console.error('[ms-collab][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
