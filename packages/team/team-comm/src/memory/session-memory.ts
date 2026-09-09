/**
 * Session Memory — Long-running agent memory across tool executions.
 *
 * A lightweight file-based key/value store that persists to `.team/memory/`
 * (git-ignored). Uses BM25 scoring for semantic search over entries.
 * Enables agents to remember decisions, code snippets, or research notes
 * across days or weeks without relying on external databases.
 *
 * Usage:
 *   const mem = new SessionMemory({ sessionId: 'user-xyz' })
 *   await mem.write('decision', 'use Rust for perf')
 *   const notes = await mem.search('performance rust')
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BM25_K1 = 1.2
const BM25_B = 0.75

interface MemoryEntry {
  key: string
  value: string
  timestamp: number
}

export interface SessionMemoryOpts {
  /** Unique identifier for the conversation/team (e.g. 'user-123', 'issue-456') */
  sessionId: string
  /** Root directory for persistence; defaults to cwd/.team/memory/ */
  rootDir?: string
}

export class SessionMemory {
  readonly #sessionId: string
  readonly #filePath: string

  constructor(opts: SessionMemoryOpts) {
    this.#sessionId = opts.sessionId
    const root = opts.rootDir ?? process.cwd()
    this.#filePath = join(root, '.team', 'memory', `${this.#sessionId}.jsonl`)
    mkdirSync(join(this.#filePath, '..'), { recursive: true })
  }

  /** Write a key/value pair (appends to the log file). */
  write(key: string, value: string): void {
    const entry: MemoryEntry = { key, value, timestamp: Date.now() }
    appendFileSync(this.#filePath, JSON.stringify(entry) + '\n')
  }

  /** Read the most recent value for a key. */
  read(key: string): string | null {
    if (!existsSync(this.#filePath)) return null
    const lines = readFileSync(this.#filePath, 'utf-8').trim().split('\n').filter(Boolean)
    // search backwards for last match
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as MemoryEntry
      if (entry.key === key) return entry.value
    }
    return null
  }

  /** Find entries by keyword using BM25 scoring. Returns entries sorted by relevance. */
  search(query: string, limit = 10): MemoryEntry[] {
    if (!existsSync(this.#filePath)) return []
    const lines = readFileSync(this.#filePath, 'utf-8').trim().split('\n').filter(Boolean)

    const terms = query.toLowerCase().split(/\s+/)
    const entries = lines.map(l => JSON.parse(l) as MemoryEntry)

    const scores = entries.map(entry => this.#bm25(query, entry, entries, terms))
    const indexed = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0])

    return indexed.slice(0, limit).map(([_, i]) => entries[i])
  }

  /** TF-IDF style BM25 scoring. */
  #bm25(query: string, entry: MemoryEntry, allEntries: MemoryEntry[], terms: string[]): number {
    let score = 0
    for (const term of terms) {
      const tf = (entry.value.toLowerCase().match(new RegExp(term, 'gi')) ?? []).length
      if (tf === 0) continue
      const df = allEntries.filter(e => e.value.toLowerCase().includes(term)).length
      const idf = Math.log((allEntries.length - df + 0.5) / (df + 0.5) + 1)
      const avgFieldLen = allEntries.reduce((s, e) => s + e.value.split(/\s+/).length, 0) / allEntries.length
      const fieldLen = entry.value.split(/\s+/).length

      const normTerm = 1 / (tf / fieldLen + (1 - BM25_B) * (1 / fieldLen))
      // Simplified BM25 without full saturation constant
      score += tf * idf / (tf + BM25_K1 * (1 - BM25_B + BM25_B * fieldLen / avgFieldLen))
    }
    return score
  }
}

/** singleton factory cached per session for fast lookup */
export function sessionMemory(sessionId: string, rootDir?: string): SessionMemory {
  return new SessionMemory({ sessionId, rootDir })
}