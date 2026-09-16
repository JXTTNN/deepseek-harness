/**
 * Shared constants, types, and helper functions for team-comm modules.
 *
 * This module is the foundation layer that all feature-domain modules
 * (messaging, tasks, memory, review, spawn, etc.) import from. It contains:
 * - Constants (file size limits, timeouts, server port)
 * - Type definitions (TeamMessage, PresenceRecord, TeamTask, etc.)
 * - File-system helpers (withFileLock, lockedAppend, lockedUpdate, readJsonl, etc.)
 * - Presence management (writePresence, readAllPresence, peerIds)
 * - Message delivery (deliverMessage, triggerSession, notifyPeer)
 * - Memory search (tokenizeForMemory, rankMemoryEntries — BM25-lite)
 * - Glob utilities (normalizeGlob, writeSetsOverlap)
 *
 * @module @deepseek-ai/dsh-team-comm/shared
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TEAM_DIR = '.team'

/** Max bytes per message to prevent inbox bloat. */
export const MAX_MESSAGE_BYTES = 100_000

/** Max lines in think.log before rotation. */
export const MAX_THINK_LOG_LINES = 2000

/** Presence records older than this (ms) are treated as gone. 60 minutes covers a peer
 *  idle-awaiting a reply. (Raised from 15m, which pruned live peers.) */
export const PRESENCE_STALE_MS = 60 * 60_000

/** A `.lock` file older than this (ms) is treated as orphaned and broken. */
export const FILE_LOCK_STALE_MS = 10_000

/**
 * How often a lock holder refreshes its lock's mtime. Staleness is judged from
 * mtime, so a holder whose critical section legitimately runs longer than
 * FILE_LOCK_STALE_MS has to keep proving it is alive; otherwise a contender
 * breaks a *live* lock and both proceed into the same read-modify-write,
 * silently losing one side's update. Must stay well under
 * FILE_LOCK_STALE_MS so a single missed tick cannot cross the threshold.
 */
export const FILE_LOCK_HEARTBEAT_MS = 2_000

/** Keep the most recent messages in an inbox so files stay bounded and scans stay fast. */
export const MAX_INBOX_MESSAGES = 500

/** Suppress a send only when an identical (sender, message) landed within this
 *  window — an accidental double-send — never a legitimate later repeat. */
export const DEDUP_WINDOW_MS = 5000

/** Append-only ledgers (tasks, sent, outbox, reviews, memory) are trimmed to
 *  their tail once they exceed this many bytes, so a long project never grows
 *  them without bound while every ordinary append stays O(1). */
export const MAX_APPEND_FILE_BYTES = 2_000_000

/** Number of tail records kept when an append-only ledger is trimmed. */
export const APPEND_TRIM_KEEP = 2000

/** Server port for the team_send wake-up HTTP trigger. The web server reads its
 * port from the `--port` flag (default 8300) via `ctx.webStartup.port`, NOT from
 * `DSH_PORT`, so prefer the actual URL (`DSH_WEB_URL`) over the misleading
 * `DSH_PORT` and fall back to the same 8300 default. */
export const SERVER_PORT = parseInt(
  process.env.DSH_WEB_URL?.match(/:(\d+)(?:\/|$)/)?.[1]
  ?? process.env.DSH_PORT
  ?? '8300',
  10,
)

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** One message in a session's inbox. */
export interface TeamMessage {
  msgId: string
  from: string
  /** The `msgId` this message is replying to, if any. */
  replyTo?: string
  ts: string
  message: string
  read?: boolean
  deleted?: boolean
  /** F2: Message priority (0=normal default, 1=high, 2=urgent). Older messages without this field are treated as 0. */
  priority?: number
}

/** One presence record. */
export interface PresenceRecord {
  id: string
  name: string
  ts: string
}

/** One task on the shared team task board. */
export type TeamTask = {
  id: string
  title: string
  description?: string
  assignee?: string
  status: 'todo' | 'in_progress' | 'done' | 'blocked'
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  deadline?: string
  deps?: string[]
  result?: string
  /** Workspace-relative globs the assignee exclusively owns (file-ownership partitioning). */
  writeSet?: string[]
  /** Machine/human-checkable done criteria the creator verifies before accepting. */
  acceptance?: string
  createdBy: string
  ts: string
  updatedTs: string
}

/** One key-value entry in the shared team memory. */
export type TeamMemoryEntry = {
  key: string
  value: string
  updatedBy: string
  ts: string
  /** F4: MVCC version number, incremented on each write. Starts at 1. */
  version?: number
}

/** One fan-out broadcast record kept for later fan-in collection. */
export interface TeamBroadcast {
  broadcastId: string
  from: string
  ts: string
  targets: { id: string; msgId: string }[]
}

/** One structured request for independent (multi-party) verification. */
export interface TeamReview {
  reviewId: string
  from: string
  target: string
  subject: string
  content: string
  msgId: string
  ts: string
}

/** One outbound delivery in the sender's ledger (for `team_status`). */
export interface TeamSent {
  msgId: string
  from: string
  to: string
  replyTo?: string
  ts: string
}

/** One participation record on a named fan-in barrier. */
export interface TeamBarrier {
  name: string
  expect: number
  arrived: string[]
  ts: string
}

/** F7: One structured evidence entry in a completion report. */
export interface StructuredEvidence {
  type: 'test' | 'lint' | 'build' | 'manual' | 'other'
  command?: string
  expected?: string
  actual?: string
  status: 'pass' | 'fail' | 'skip'
  artifact?: string
}

/** One fixed-schema completion report for a task (fan-in to the coordinator). */
export interface TeamReport {
  reportId: string
  taskId: string
  from: string
  summary: string
  filesChanged: string[]
  decisions?: string[]
  openIssues?: string[]
  /** F7: Evidence can be free-text strings (backward compat) or structured entries. */
  evidence?: Array<string | StructuredEvidence>
  ts: string
}

// ---------------------------------------------------------------------------
// Agent session helpers
// ---------------------------------------------------------------------------

/** Normalise the team root under the agent's working directory. */
export function teamCwd(agent: { session: { header?: { cwd?: string } } }): string {
  return agent.session.header?.cwd ?? process.cwd()
}

/**
 * Validate a caller-supplied team session id before it is interpolated into a
 * filesystem path. Session ids are server-generated UUIDs, but they arrive as
 * tool arguments the model controls, so this blocks path traversal and drive
 * escapes (e.g. `..`, `\`, `/`, NUL) from writing or deleting outside `.team/`.
 */
export function isSafeTeamId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id === id.trim()
    && !/[\\/]/.test(id)
    && id !== '.'
    && id !== '..'
    && !id.includes('\0')
}

export function assertSafeTeamId(id: unknown, label: string): string {
  if (!isSafeTeamId(id)) {
    throw new Error(`${label}: session id must be a non-empty string without path separators`)
  }
  return id
}

/** Team-shared file path under the agent's working directory. */
export function teamPath(agent: { session: { header?: { cwd?: string } } }, name: string): string {
  return join(teamCwd(agent), TEAM_DIR, name)
}

// ---------------------------------------------------------------------------
// In-process file locking
// ---------------------------------------------------------------------------

/** Per-inbox serialization so concurrent read-modify-write never loses a message. */
const inboxLocks = new Map<string, Promise<void>>()

/** Run `fn` exclusively for one inbox file across this process. */
export function withInboxLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = inboxLocks.get(file) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(() => undefined, () => undefined)
  inboxLocks.set(file, tail)
  // Evict the entry once its tail settles so the map does not grow without
  // bound on a long-running server that touches many distinct files.
  void tail.then(() => { if (inboxLocks.get(file) === tail) inboxLocks.delete(file) })
  return run
}

/** Resolve after `ms` milliseconds (async, non-blocking). */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Serialize a critical section for a shared file across PROCESSES (not just
 * within this process). The in-process `withInboxLock` guards concurrent
 * sessions hosted by the same `dsh web` server; this additionally takes a
 * `.lock` sibling file with `wx` (atomic exclusive create) so that two server
 * processes sharing one working directory cannot interleave a
 * read-modify-write and drop an update. Orphaned locks (crashed process) are
 * broken once they outlive `FILE_LOCK_STALE_MS`.
 */
export function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  return withInboxLock(file, async () => {
    // Ensure the lock file's parent directory exists so the very first write to
    // a fresh team workspace (e.g. the first team_task before any inbox/presence
    // call created `.team/`) does not fail with ENOENT.
    mkdirSync(dirname(file), { recursive: true })
    const lockPath = `${file}.lock`
    // Acquire the lock, breaking it ONLY when it is provably stale (orphaned).
    for (;;) {
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // Windows reports EPERM/EBUSY/EACCES (not just EEXIST) when a concurrent
        // `wx` open races an existing or just-deleted lock file; treat every
        // transient-contention code as "lock held, retry" rather than crashing.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') throw err
        // Another process holds it. Break it only if it is orphaned. A wall-clock
        // deadline must NOT break a live lock: a slow-but-alive holder would then
        // be pre-empted mid read-modify-write and silently lose data.
        let stale = false
        try {
          stale = Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS
        } catch { /* lock vanished; retry acquisition */ }
        if (stale) {
          try { rmSync(lockPath, { force: true }) } catch { /* lost a race; loop again */ }
          continue
        }
        // Small backoff with jitter to de-thunder the herd of contending peers.
        await sleep(10 + Math.floor(Math.random() * 20))
      }
    }
    let heartbeat: NodeJS.Timeout | undefined
    const touch = (): void => {
      // Best-effort: a vanished lock file means someone already broke it, and
      // the release below is best-effort too.
      try { utimesSync(lockPath, new Date(), new Date()) } catch { /* vanished */ }
    }
    try {
      heartbeat = setInterval(touch, FILE_LOCK_HEARTBEAT_MS)
      // Never hold the event loop open for a lock heartbeat.
      heartbeat.unref()
      try {
        return await fn()
      } finally {
        clearInterval(heartbeat)
      }
    } finally {
      try { rmSync(lockPath, { force: true }) } catch { /* best-effort */ }
    }
  })
}

/** Serialize an O(1) append to one shared JSONL file. Appends never read or
 *  rewrite the existing records on the hot path; a size-triggered, amortised
 *  trim bounds the ledger once it grows large. This keeps task/memory/ledger
 *  writes fast for a long-running large project instead of O(n) per append. */
export function lockedAppend(file: string, record: unknown): Promise<void> {
  return withFileLock(file, () => {
    writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'a' })
    // Amortised bound: only when the ledger is already large, rewrite it to its
    // tail. Best-effort — a trim failure must never fail the append itself.
    try {
      if (statSync(file).size > MAX_APPEND_FILE_BYTES) {
        const records = readJsonlStrict<unknown>(file)
        if (records.length > APPEND_TRIM_KEEP) {
          writeJsonl(file, records.slice(-APPEND_TRIM_KEEP))
        }
      }
    } catch { /* best-effort trim */ }
  })
}

/** Serialize a read-modify-write for one shared JSONL file (locked + atomic). */
export function lockedUpdate<T>(file: string, mutate: (records: T[]) => T[]): Promise<T[]> {
  return withFileLock(file, () => {
    const records = readJsonlStrict<T>(file)
    const next = mutate(records)
    writeJsonl(file, next)
    return next
  })
}

// ---------------------------------------------------------------------------
// JSONL file I/O
// ---------------------------------------------------------------------------

/** Read a JSONL file, returning an array of parsed objects. A whole-file read
 *  error returns `[]` — suitable only for READ-ONLY consumers where an empty
 *  result is acceptable. Read-modify-write paths must use `readJsonlStrict`. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  try {
    return parseJsonl<T>(readFileSync(path, 'utf-8'))
  } catch {
    // File read error (permission, transient AV lock, etc.) — return empty.
    return []
  }
}

/**
 * Strict JSONL read for READ-MODIFY-WRITE paths. Unlike `readJsonl`, a whole-file
 * read error THROWS so a lockedAppend/lockedUpdate/team_inbox rewrite can never
 * silently treat an unreadable file as empty and then OVERWRITE it, destroying
 * the records it failed to read. Malformed individual lines are still skipped.
 */
export function readJsonlStrict<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return parseJsonl<T>(readFileSync(path, 'utf-8'))
}

/** Parse only the last `n` records of a JSONL file without parsing the bulk —
 *  used for the cheap dedup window and reply lookups on a long inbox. */
export function readTailJsonl<T>(path: string, n: number): T[] {
  if (!existsSync(path) || n <= 0) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.trim().split('\n')
    const result: T[] = []
    for (const line of lines.slice(-n)) {
      try { result.push(JSON.parse(line) as T) } catch { /* skip malformed */ }
    }
    return result
  } catch {
    return []
  }
}

/** Parse JSONL text into records, skipping (not failing on) malformed lines. */
export function parseJsonl<T>(raw: string): T[] {
  const trimmed = raw.trim()
  if (trimmed === '') return []
  const result: T[] = []
  for (const line of trimmed.split('\n')) {
    try {
      result.push(JSON.parse(line) as T)
    } catch {
      // Skip malformed lines — don't lose the whole file over one bad line.
    }
  }
  return result
}

/**
 * Write `content` to `path` atomically: sibling temp file, best-effort fsync,
 * then rename — retrying the rename through the transient Windows share-lock
 * errors that make a bare `renameSync` throw.
 *
 * Extracted from `writeJsonl` so the per-record JSON modules (contract,
 * pipeline, election, budget, consensus, sync, handoff) share ONE hardened
 * implementation. Each of those had grown its own bare
 * `writeFileSync(tmp) + renameSync(tmp, file)` pair, which reintroduced exactly
 * the crash-on-contention and torn-write window this helper exists to close:
 * the same defect class already fixed for the JSONL paths (a bare rename over
 * an open destination throws EPERM/EBUSY on Windows and would take the whole
 * tool call down with it).
 */
export function writeTextAtomic(path: string, content: string): void {
  // A concurrent reader must never see a half-written file.
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, content)
  // Best-effort fsync so a torn write cannot survive a crash as the "current"
  // file after the rename below.
  try {
    const fd = openSync(tmp, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch { /* fsync unsupported/denied — rename still gives atomicity */ }
  // `renameSync` over an existing destination is atomic on POSIX, but Windows
  // can surface transient EPERM/EBUSY/EEXIST while a reader briefly holds the
  // file open. Retry a few times, then fall back to a direct write as a last
  // resort rather than crashing the tool call.
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      lastError = err
      // If the temp file disappeared, another writer already renamed it — done.
      if (!existsSync(tmp)) return
      // Busy-wait briefly; the Windows share lock is usually released in ms.
      const wait = 10 * (attempt + 1)
      const until = Date.now() + wait
      while (Date.now() < until) { /* spin */ }
    }
  }
  // Last resort: non-atomic direct overwrite. The JSONL parser tolerates a
  // partially written final line by skipping malformed lines, so this degrades
  // gracefully rather than failing the operation outright.
  writeFileSync(path, content)
  try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
  if (lastError !== undefined) {
    // Surface the original error to callers that want to observe contention.
    console.warn('[team-comm] writeTextAtomic: rename contended, fell back to direct write:', lastError)
  }
}

/** Overwrite a JSONL file with an array of records, atomically. */
export function writeJsonl(path: string, records: unknown[]): void {
  const content = records.length === 0
    ? ''
    : records.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n'
  writeTextAtomic(path, content)
}

// ---------------------------------------------------------------------------
// Presence management
// ---------------------------------------------------------------------------

/** Write a presence file for this session. */
export function writePresence(agent: { session: { id: string; header?: { cwd?: string } } }): string {
  const cwd = teamCwd(agent)
  const dir = join(cwd, TEAM_DIR, 'presence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${agent.session.id}.json`),
    JSON.stringify({
      id: agent.session.id,
      name: agent.session.id,
      ts: new Date().toISOString(),
    } satisfies PresenceRecord),
  )
  return cwd
}

/** Read all known presence records, cleaning up stale ones. */
export function readAllPresence(agent: { session: { header?: { cwd?: string } } }): PresenceRecord[] {
  const dir = join(teamCwd(agent), TEAM_DIR, 'presence')
  if (!existsSync(dir)) return []
  const records: PresenceRecord[] = []
  const now = Date.now()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const filePath = join(dir, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const record = JSON.parse(raw) as PresenceRecord
      const age = now - new Date(record.ts).getTime()
      // Stale, or carrying a corrupt/absent timestamp or unsafe id — remove it.
      if (Number.isNaN(age) || age > PRESENCE_STALE_MS || typeof record.id !== 'string' || !isSafeTeamId(record.id)) {
        try { unlinkSync(filePath) } catch { /* best-effort */ }
        continue
      }
      records.push(record)
    } catch {
      // Corrupted — remove it.
      try { unlinkSync(filePath) } catch { /* best-effort */ }
    }
  }
  return records
}

/** All live peer ids other than the caller, filtering out any malformed ids. */
export function peerIds(agent: { session: { id: string; header?: { cwd?: string } } }): string[] {
  return readAllPresence(agent).map(p => p.id).filter(id => id !== agent.session.id && isSafeTeamId(id))
}

// ---------------------------------------------------------------------------
// Message delivery
// ---------------------------------------------------------------------------

/** Append one message line to a peer's inbox (locked single-line append) and return its msgId. */
export async function deliverMessage(
  agent: { session: { id: string; header?: { cwd?: string } } },
  target: string,
  message: string,
  replyTo?: string,
  msgId: string = randomUUID(),
): Promise<string> {
  const safeTarget = assertSafeTeamId(target, 'deliverMessage target')
  const msgBytes = Buffer.byteLength(message, 'utf-8')
  if (msgBytes > MAX_MESSAGE_BYTES) {
    throw new Error(`deliverMessage: message too large (${msgBytes} bytes, max ${MAX_MESSAGE_BYTES})`)
  }
  const inboxDir = join(teamCwd(agent), TEAM_DIR, 'inbox')
  mkdirSync(inboxDir, { recursive: true })
  const record: TeamMessage = {
    msgId,
    from: agent.session.id,
    ts: new Date().toISOString(),
    message,
    read: false,
  }
  if (replyTo !== undefined) record.replyTo = replyTo
  const inboxFile = join(inboxDir, `${safeTarget}.jsonl`)
  await withFileLock(inboxFile, () => {
    // Retry a transient append failure (Windows reader-share EPERM/EBUSY) so a
    // brief file-open race cannot silently drop a peer message.
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try { writeFileSync(inboxFile, JSON.stringify(record) + '\n', { flag: 'a' }); return }
      catch (error) { lastError = error }
    }
    throw lastError
  })
  return msgId
}

/** Fire the localhost prompt trigger so a peer wakes up immediately (best-effort). */
export function triggerSession(target: string, from: string, msgId: string, message: string): void {
  try {
    // Sanitize the message to prevent prompt injection: limit length and strip
    // newlines/control chars that could break out of the prompt template or
    // inject adversarial instructions into the peer's steering prompt.
    const safeMessage = String(message).slice(0, 1000).replace(/[\r\n]+/g, ' ').trim()
    const postData = JSON.stringify({
      type: 'client-request',
      rpcId: `team-${msgId.slice(0, 8)}`,
      method: 'session.prompt',
      payload: {
        sessionId: target,
        mode: 'steer',
        content: [{ type: 'text', text: `!!! TEAM MESSAGE from ${from} (msgId: ${msgId}): ${safeMessage}\n\nYOU MUST CALL team_send(target: "${from}", reply_to: "${msgId}", message: "your complete response") RIGHT NOW. Do NOT type text. Do NOT call team_inbox. Do NOT describe. Just CALL team_send.` }],
      },
    })
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/api/session.prompt',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res: IncomingMessage) => { res.resume() })
    req.on('error', () => { /* best-effort */ })
    req.write(postData)
    req.end()
  } catch { /* best-effort */ }
}

/** Deliver a message to a peer and fire its wake-up trigger. */
export async function notifyPeer(
  agent: { session: { id: string; header?: { cwd?: string } } },
  target: string,
  message: string,
): Promise<void> {
  const msgId = await deliverMessage(agent, target, message)
  triggerSession(target, agent.session.id, msgId, message)
}

// ---------------------------------------------------------------------------
// Memory search scoring (BM25-lite, fully offline)
// ---------------------------------------------------------------------------

/** English stopwords contribute no ranking signal; drop them before scoring. */
const MEMORY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'will', 'with',
])

/** Lowercase alnum tokens with stopwords removed. */
export function tokenizeForMemory(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !MEMORY_STOPWORDS.has(t))
}

/** BM25 parameters (Robertson/Jones classics): tf saturation + length norm. */
const BM25_K1 = 1.5
const BM25_B = 0.75

/**
 * Rank memory entries against a query. Deterministic, small enough to be O(N)
 * per query over the whole memory (fine at this scale).
 *
 * @param query - free-text search query.
 * @param entries - the memory's current entries (latest per key)).
 * @returns the top hits, best score first, with a capped `score` field.
 */
export function rankMemoryEntries(query: string, entries: TeamMemoryEntry[]): Array<TeamMemoryEntry & { score: number }> {
  const qTokens = tokenizeForMemory(query)
  if (qTokens.length === 0 || entries.length === 0) return []
  const docs = entries.map(e => tokenizeForMemory(`${e.key} ${e.value}`))
  const df = new Map<string, number>()
  for (const toks of docs) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = docs.length
  const avgLen = docs.reduce((acc, d) => acc + d.length, 0) / Math.max(1, N)
  const scored: Array<TeamMemoryEntry & { score: number }> = []
  for (let i = 0; i < entries.length; i++) {
    const toks = docs[i] ?? []
    const freq = new Map<string, number>()
    for (const t of toks) freq.set(t, (freq.get(t) ?? 0) + 1)
    const lenNorm = 1 - BM25_B + (BM25_B * toks.length) / Math.max(1, avgLen)
    let score = 0
    for (const t of qTokens) {
      const f = freq.get(t) ?? 0
      if (f === 0) continue
      const dfN = df.get(t) ?? 0
      const idf = Math.log(1 + (N - dfN + 0.5) / (dfN + 0.5))
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * lenNorm))
    }
    if (score > 0) {
      const entry = entries[i]
      if (entry !== undefined) scored.push({ ...entry, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

// ---------------------------------------------------------------------------
// Glob utilities
// ---------------------------------------------------------------------------

/** Normalise a workspace-relative glob so equivalent spellings compare equal. */
export function normalizeGlob(glob: string): string {
  return glob.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Naive writeSet overlap: two globs conflict when they are exactly equal or
 *  one is a directory prefix of the other (single most effective conflict
 *  avoidance rule — file-ownership partitioning; overlapping ownership is a bug). */
export function writeSetsOverlap(a: string, b: string): boolean {
  const na = normalizeGlob(a)
  const nb = normalizeGlob(b)
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/')
}