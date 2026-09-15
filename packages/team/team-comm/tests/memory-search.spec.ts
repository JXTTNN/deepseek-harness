import {
  rankMemoryEntries,
  tokenizeForMemory,
} from '@deepseek-ai/dsh-team-comm'
import { describe, expect, it } from 'vitest'

describe('tokenizeForMemory', () => {
  it('lowercases, splits on non-alphanumerics, and drops stopwords', () => {
    expect(tokenizeForMemory('The Gateway is DOWN at 19:00!'))
      .toEqual(['gateway', 'down', '19', '00'])
  })

  it('keeps single-char tokens out and handles empties', () => {
    expect(tokenizeForMemory('a I e')).toEqual([])
    expect(tokenizeForMemory('')).toEqual([])
  })
})

describe('rankMemoryEntries', () => {
  const memory = [
    { key: 'deploy-window', value: 'Deploys run every weekday at 19:00 CET', updatedBy: 'x', ts: '2026-01-01T00:00:00Z' },
    { key: 'db-creds', value: 'Postgres credentials live in .env.local', updatedBy: 'y', ts: '2026-01-01T00:01:00Z' },
    { key: 'gateway-quota', value: 'The gateway accepts 20 requests per minute per key', updatedBy: 'z', ts: '2026-01-01T00:02:00Z' },
  ]

  it('ranks the most relevant entry first', () => {
    const hits = rankMemoryEntries('gateway request limits', memory)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.key).toBe('gateway-quota')
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  it('filters to only scoring entries', () => {
    const hits = rankMemoryEntries('schema migrations sqlite', memory)
    expect(hits.length).toBe(0)
  })

  it('returns empty on empty memory or query', () => {
    expect(rankMemoryEntries('', memory)).toEqual([])
    expect(rankMemoryEntries('x y', [])).toEqual([])
  })

  it('prefers shorter docs over longer ones at equal term counts', () => {
    const short = { key: 'short', value: 'fix the foo bug', updatedBy: 'a', ts: '2026-01-01T00:00:00Z' }
    const long = { key: 'long', value: `fix the foo bug plus ${'noise '.repeat(60)}`, updatedBy: 'a', ts: '2026-01-01T00:00:01Z' }
    const hits = rankMemoryEntries('fix bug foo', [long, short])
    expect(hits[0]!.key).toBe('short')
  })

  it('rewards rare terms over common ones across the index', () => {
    const docs = [
      { key: 'a', value: 'auth token expiry policy', updatedBy: 'x', ts: '2026-01-01T00:00:00Z' },
      { key: 'b', value: 'auth refresh rotation', updatedBy: 'x', ts: '2026-01-01T00:01:00Z' },
      { key: 'c', value: 'auth offboarding checklist', updatedBy: 'x', ts: '2026-01-01T00:02:00Z' },
    ]
    const hits = rankMemoryEntries('auth expiry', docs)
    expect(hits[0]!.key).toBe('a')
  })
})
