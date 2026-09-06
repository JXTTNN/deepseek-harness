// Verify auto model discovery: llm.models (the model catalog the selection UI
// reads) must now include remote models beyond the hard-coded two, proving the
// listModels auto-explore fetched the real /models list.
//
// Run: node apps/web/tests/conductor/discover-models.mjs

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:8300'
const log = (...a) => console.log('[discover]', ...a)

const rpc = (method, payload) => fetch(`${BASE}/api/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `dm-${method}`, method, payload }),
}).then(r => r.json())

try {
  const r = await rpc('llm.models', {})
  log('raw', JSON.stringify(r).slice(0, 600))
  // Gateway-agnostic assertion: the hard-coded fallback catalog contains only
  // deepseek-v4-flash and deepseek-v4-pro, so any other surfaced id proves the
  // /models auto-discovery route applied.
  const models = r?.result?.value?.groups?.flatMap(g => g.models ?? []).map(m => m.id) ?? []
  const hardcoded = new Set(['deepseek-v4-flash', 'deepseek-v4-pro'])
  const remote = models.filter(id => !hardcoded.has(id))
  log('models', JSON.stringify(models))
  const hasRemote = remote.length > 0
  log('contains remote model', hasRemote)
  if (!hasRemote) {
    log('FAIL: llm.models did not surface any remote model (auto-discovery not applied)')
    process.exit(1)
  }
  log('PASS: auto-discovery surfaced remote models')
} catch (e) {
  console.error('[discover][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
