// Real team-collaboration probe: create a Team-mode session and prompt it to
// use the team coordination layer, then verify the agent actually invoked a
// team_* tool (end-to-end, not just presence-file existence).
//
// Diagnostics: on failure, print every llm/retry failure payload (code,
// message, status) and the assistant's streamed text, so a CI artifact tells
// us whether the model errored (401/402/429/5xx), streamed garbage, or simply
// ignored the tool call.
//
// Run: node apps/web/tests/conductor/team-collab.mjs

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const SID = `team-collab-${Date.now()}`
const log = (...a) => console.log('[team-collab]', ...a)
const TURN_TIMEOUT_MS = Number(process.env.TEAM_COLLAB_TIMEOUT_MS ?? 180_000)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `tc-${method}`, method, payload }),
}).then(r => r.json())

async function history() {
  const hist = await rpc('session.history', { sessionId: SID })
  return hist?.result?.value?.events ?? []
}

function dumpDiagnostics(events) {
  const retries = events.filter(e => e.event?.type === 'llm/retry')
  for (const e of retries) {
    const f = e.event?.data?.failure ?? {}
    log('llm/retry', JSON.stringify({
      retry: e.event?.data?.retry,
      mode: e.event?.data?.mode,
      code: f.code,
      status: f.status,
      message: f.message,
      provider: e.event?.data?.provider,
    }))
  }
  const chunks = events
    .filter(e => e.event?.type === 'assistant/chunk')
    .map(e => e.event?.data?.chunk?.text ?? e.event?.data?.text ?? '')
    .join('')
  if (chunks.length > 0) log('assistant streamed text (first 500):', JSON.stringify(chunks.slice(0, 500)))
  const messages = events.filter(e => e.event?.type === 'assistant/message')
  for (const m of messages.slice(-2)) {
    const text = JSON.stringify(m.event?.data?.message ?? m.event?.data ?? '')
    log('assistant/message (first 500):', text.slice(0, 500))
  }
  const errors = events
    .filter(e => /error|fail/i.test(String(e.event?.type)))
    .map(e => e.event?.type)
  if (errors.length > 0) log('error-ish events:', JSON.stringify(errors))
}

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

  // Poll the event log instead of sleeping a fixed window. A single 30s sleep
  // is too fragile for CI: the LLM gateway round-trip from a GitHub runner can
  // retry several times (observed: 6 retries in ~28s). Exit early on the first
  // tool call (the probe's success signal) or when the turn closes; otherwise
  // run out the deadline and dump retry diagnostics below.
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let events = []
  let settled = false
  while (Date.now() < deadline) {
    events = await history()
    if (events.some(e => e.event?.type === 'tool/call' || e.event?.type === 'turn/end')) {
      settled = true
      break
    }
    await new Promise(r => setTimeout(r, 3_000))
  }
  log('turn settled', settled)
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

  if (teamCalls.length === 0) {
    dumpDiagnostics(events)
    log('FAIL: agent did not invoke any team_* tool')
    process.exit(1)
  }
  log('PASS: agent invoked team tools end-to-end:', JSON.stringify(teamCalls))
} catch (e) {
  console.error('[team-collab][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
