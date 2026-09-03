// Verify the auto model-discovery wiring: llm.discoverModels must return the
// remote /models list (more than the hard-coded two-model catalog) when a key
// is configured — proving "auto-explore available models" works end to end.
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
  const r = await rpc('llm.discoverModels', { settingsNs: 'llm-deepseek', provider: 'deepseek-official' })
  log('raw', JSON.stringify(r).slice(0, 400))
  const value = r?.result?.value
  const models = Array.isArray(value) ? value : (value?.models ?? value?.items ?? [])
  const ids = models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
  log('model ids', JSON.stringify(ids))
  if (ids.length <= 2) {
    log('FAIL: only the static two-model catalog returned; auto-discovery did not run')
    process.exit(1)
  }
  log(`PASS: auto-discovered ${ids.length} models`)
} catch (e) {
  console.error('[discover][FAIL]', e instanceof Error ? e.stack : e)
  process.exit(1)
}
