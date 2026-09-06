// Real team-collaboration probe: create a Team-mode session and prompt it to
// use the team coordination layer, then verify the agent actually invoked a
// team_* tool (end-to-end, not just presence-file existence).
//
// Run: node apps/web/tests/conductor/team-collab.mjs

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const SID = `team-collab-${Date.now()}`
const log = (...a) => console.log('[team-collab]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `tc-${method}`, method, payload }),
}).then(r => r.json())

try {
  const home = process.env.HOME || '/home/runner'
  await rpc('workspace.create', { path: home })
  const created = await rpc('session.create', { sessionId: SID, cwd: home, agentPreset: 'team' })
  log('session.create ok', created?.result?.ok)
  if (!created?.result?.ok) process.exit(1)

  const prompted = await rpc('session.prompt', {
    sessionId: SID,
    mode: 'queue',
    content: [{ type: 'text', text: 'Call team_list to discover your team peers, then report exactly what team_list returned. Do not skip the tool call.' }],
  })
  log('session.prompt ok', prompted?.result?.ok)

  // Wait for the agent's turn to finish. A single 30s sleep is too fragile for
  // CI: the LLM gateway round-trip from a GitHub runner can retry several
  // times (observed: 7 retries in 28s), so poll the event log until a tool
  // call appears or the deadline passes, and dump retry diagnostics on failure.
  const deadline = Date.now() + 180_000
  let events = []
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000))
    const hist = await rpc('session.history', { sessionId: SID })
    events = hist?.result?.value?.events ?? []
    if (events.some(e => e.event?.type === 'tool/call')) break
  }
  const types = events.map(e => e.event?.type)
  log('event types', JSON.stringify(types))
  const retryEvents = events.filter(e => e.event?.type === 'llm/retry')
  if (retryEvents.length > 0) {
    log('llm/retry payloads', JSON.stringify(retryEvents.slice(-3).map(e => e.event?.data)).slice(0, 1200))
  }
  const callEvents = events.filter(e => e.event?.type === 'tool/call')
  if (callEvents.length > 0) log('first tool/call data', JSON.stringify(callEvents[0].event?.data).slice(0, 300))
  const toolCalls = callEvents
    .map(e => e.event?.data?.name ?? e.event?.data?.tool ?? e.event?.data?.call?.name)
    .filter(Boolean)
  const teamCalls = toolCalls.filter(n => String(n).startsWith('team_'))
  log('tool calls', JSON.stringify(toolCalls))
  log('team tool calls', JSON.stringify(teamCalls))
  const msgEvents = events.filter(e => e.event?.type === 'assistant/message')
  if (msgEvents.length > 0) log('first assistant/message', JSON.stringify(msgEvents[0].event?.data).slice(0, 400))

  if (teamCalls.length === 0) {
    log('FAIL: agent did not invoke any team_* tool')
    process.exit(1)
  }
  log('PASS: agent invoked team tools end-to-end:', JSON.stringify(teamCalls))
} catch (e) {
  console.error('[team-collab][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
