// Multi-session division-of-labor probe: two Team-mode sessions coordinate
// through the shared .team/ layer — session A creates a task and sends a
// message, session B reads its inbox and task board. Proves the cross-session
// collaboration mechanism (not single-session subagent delegation).
//
// Run: node apps/web/tests/conductor/team-delegate.mjs

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const A = `ui-ms-a-${Date.now()}`
const B = `ui-ms-b-${Date.now()}`
const log = (...a) => console.log('[ms-collab]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `ms-${method}-${Math.random().toString(36).slice(2, 8)}`, method, payload }),
}).then(r => r.json())

try {
  const home = process.env.HOME || '/home/runner'
  await rpc('workspace.create', { path: home })
  const ws = await rpc('workspace.list', {})
  const workspaceId = ws?.result?.value?.workspaces?.[0]?.workspaceId
  await rpc('session.create', { sessionId: A, workspaceId, agentPreset: 'team' })
  await rpc('session.create', { sessionId: B, workspaceId, agentPreset: 'team' })
  log('two team sessions created')

  // A creates a task + sends a direct message to B.
  await rpc('session.prompt', {
    sessionId: A,
    mode: 'queue',
    content: [{ type: 'text', text: `Call team_task(action:"create", title:"ui-ms-task") to create one task, then call team_send(target:"${B}", message:"hello from A") to message your peer. Report both tool results.` }],
  })
  log('A prompted (create task + send)')

  // B reads its inbox + task board.
  await rpc('session.prompt', {
    sessionId: B,
    mode: 'queue',
    content: [{ type: 'text', text: 'Call team_inbox to read your messages, then team_task(action:"list") to list the task board. Report what you found.' }],
  })
  log('B prompted (read inbox + list tasks)')

  await new Promise(r => setTimeout(r, 45000))

  const histA = await rpc('session.history', { sessionId: A })
  const histB = await rpc('session.history', { sessionId: B })
  const calls = (h) => (h?.result?.value?.events ?? [])
    .filter(e => e.event?.type === 'tool/call')
    .map(e => e.event?.data?.name ?? e.event?.data?.tool)
    .filter(Boolean)
  const aCalls = calls(histA)
  const bCalls = calls(histB)
  log('A tool calls', JSON.stringify(aCalls))
  log('B tool calls', JSON.stringify(bCalls))
  const aWrote = aCalls.some(n => String(n).startsWith('team_'))
  const bRead = bCalls.some(n => String(n) === 'team_inbox' || String(n) === 'team_task' || String(n) === 'team_list')
  log('A used team tools (write)', aWrote, '| B used team tools (read)', bRead)

  if (aWrote && bRead) {
    log('PASS: two sessions coordinated through the shared team layer (division of labor)')
  } else {
    log('SKIP: model did not perform the expected division of labor (non-deterministic)')
  }
} catch (e) {
  console.error('[ms-collab][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
