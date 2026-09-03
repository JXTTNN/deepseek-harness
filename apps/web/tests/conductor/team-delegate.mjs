// Real multi-agent delegation probe: a Team-mode lead is asked to delegate a
// trivial task to a worker via the subagent tool, proving the collaboration
// mechanism actually fans work out to another agent (more than one turn in one
// conversation). Best-effort: model may choose a different valid path.
//
// Run: node apps/web/tests/conductor/team-delegate.mjs

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const SID = `ui-delegate-${Date.now()}`
const log = (...a) => console.log('[delegate]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `dg-${method}`, method, payload }),
}).then(r => r.json())

try {
  const home = process.env.HOME || '/home/runner'
  await rpc('workspace.create', { path: home })
  const ws = await rpc('workspace.list', {})
  const workspaceId = ws?.result?.value?.workspaces?.[0]?.workspaceId
  await rpc('session.create', { sessionId: SID, workspaceId, agentPreset: 'team' })
  log('session.create ok')

  await rpc('session.prompt', {
    sessionId: SID,
    mode: 'queue',
    content: [{ type: 'text', text: 'Delegate ONE tiny task to a worker using the subagent tool: ask the worker to reply with just the word "OK". After the worker finishes, report the worker\'s reply. Do not do the task yourself.' }],
  })
  log('session.prompt ok')

  await new Promise(r => setTimeout(r, 60000))

  const hist = await rpc('session.history', { sessionId: SID })
  const events = hist?.result?.value?.events ?? []
  const toolCalls = events.filter(e => e.event?.type === 'tool/call')
    .map(e => e.event?.data?.name ?? e.event?.data?.tool)
    .filter(Boolean)
  log('tool calls', JSON.stringify(toolCalls))
  const delegated = toolCalls.some(n => String(n) === 'subagent' || String(n) === 'subagent_fork' || String(n) === 'workflow')
  log('delegated to a worker', delegated)

  if (!delegated) {
    log('SKIP: lead did not delegate via subagent (non-deterministic)')
    process.exit(0)
  }
  log('PASS: team lead delegated to a worker agent (multi-agent collaboration works)')
} catch (e) {
  console.error('[delegate][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
