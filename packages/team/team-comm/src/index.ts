/**
 * Cross-session team communication tools for the Team mode preset.
 *
 * Team-mode sessions share a `.team/` directory under the workspace. Each
 * session writes its presence lazily (on first tool call) and can send messages
 * to other sessions via their inbox files. Messages carry a `msgId` for
 * threading and `replyTo` for reply chains. The inbox is read-once: `team_inbox`
 * returns only unread messages and marks them read.
 *
 * @module @deepseek-ai/dsh-team-comm
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { dirname, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

/** Stable Cordis plugin name. */
export const name = 'team-comm'

/** Required services before the tools can register. */
export const inject = ['tools', 'systemPrompt']

const TEAM_DIR = '.team'

/** Max bytes per message to prevent inbox bloat. */
const MAX_MESSAGE_BYTES = 100_000

/** Max lines in think.log before rotation. */
const MAX_THINK_LOG_LINES = 2000

/** Presence records older than this (ms) are treated as gone. 60 minutes covers a peer
 *  idle-awaiting a reply. (Raised from 15m, which pruned live peers.) */
const PRESENCE_STALE_MS = 60 * 60_000

/** A `.lock` file older than this (ms) is treated as orphaned and broken. */
const FILE_LOCK_STALE_MS = 10_000

/** Keep the most recent messages in an inbox so files stay bounded and scans stay fast. */
const MAX_INBOX_MESSAGES = 500

/** Suppress a send only when an identical (sender, message) landed within this
 *  window — an accidental double-send — never a legitimate later repeat. */
const DEDUP_WINDOW_MS = 5000

/** Append-only ledgers (tasks, sent, outbox, reviews, memory) are trimmed to
 *  their tail once they exceed this many bytes, so a long project never grows
 *  them without bound while every ordinary append stays O(1). */
const MAX_APPEND_FILE_BYTES = 2_000_000

/** Number of tail records kept when an append-only ledger is trimmed. */
const APPEND_TRIM_KEEP = 2000

/** Server port for the team_send wake-up HTTP trigger. The web server reads its
 * port from the `--port` flag (default 8300) via `ctx.webStartup.port`, NOT from
 * `DSH_PORT`, so prefer the actual URL (`DSH_WEB_URL`) over the misleading
 * `DSH_PORT` and fall back to the same 8300 default. */
const SERVER_PORT = parseInt(
  process.env.DSH_WEB_URL?.match(/:(\d+)(?:\/|$)/)?.[1]
  ?? process.env.DSH_PORT
  ?? '8300',
  10,
)

/** Normalise the team root under the agent's working directory. */
function teamCwd(agent: { session: { header?: { cwd?: string } } }): string {
  return agent.session.header?.cwd ?? process.cwd()
}

/**
 * Validate a caller-supplied team session id before it is interpolated into a
 * filesystem path. Session ids are server-generated UUIDs, but they arrive as
 * tool arguments the model controls, so this blocks path traversal and drive
 * escapes (e.g. `..`, `\`, `/`, NUL) from writing or deleting outside `.team/`.
 */
function isSafeTeamId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id === id.trim()
    && !/[\\/]/.test(id)
    && id !== '.'
    && id !== '..'
    && !id.includes('\0')
}

function assertSafeTeamId(id: unknown, label: string): string {
  if (!isSafeTeamId(id)) {
    throw new Error(`${label}: session id must be a non-empty string without path separators`)
  }
  return id
}

/** Per-inbox serialization so concurrent read-modify-write never loses a message. */
const inboxLocks = new Map<string, Promise<void>>()

/** Run `fn` exclusively for one inbox file across this process. */
function withInboxLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
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
function sleep(ms: number): Promise<void> {
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
function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
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
    try {
      return await fn()
    } finally {
      try { rmSync(lockPath, { force: true }) } catch { /* best-effort */ }
    }
  })
}

/** Serialize an O(1) append to one shared JSONL file. Appends never read or
 *  rewrite the existing records on the hot path; a size-triggered, amortised
 *  trim bounds the ledger once it grows large. This keeps task/memory/ledger
 *  writes fast for a long-running large project instead of O(n) per append. */
function lockedAppend(file: string, record: unknown): Promise<void> {
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
function lockedUpdate<T>(file: string, mutate: (records: T[]) => T[]): Promise<T[]> {
  return withFileLock(file, () => {
    const records = readJsonlStrict<T>(file)
    const next = mutate(records)
    writeJsonl(file, next)
    return next
  })
}

/** Team-shared file path under the agent's working directory. */
function teamPath(agent: { session: { header?: { cwd?: string } } }, name: string): string {
  return join(teamCwd(agent), TEAM_DIR, name)
}

/** All live peer ids other than the caller, filtering out any malformed ids. */
function peerIds(agent: { session: { id: string; header?: { cwd?: string } } }): string[] {
  return readAllPresence(agent).map(p => p.id).filter(id => id !== agent.session.id && isSafeTeamId(id))
}

/** Append one message line to a peer's inbox (locked single-line append) and return its msgId. */
async function deliverMessage(
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
function triggerSession(target: string, from: string, msgId: string, message: string): void {
  try {
    const postData = JSON.stringify({
      type: 'client-request',
      rpcId: `team-${msgId.slice(0, 8)}`,
      method: 'session.prompt',
      payload: {
        sessionId: target,
        mode: 'steer',
        content: [{ type: 'text', text: `!!! TEAM MESSAGE from ${from} (msgId: ${msgId}): ${message}\n\nYOU MUST CALL team_send(target: "${from}", reply_to: "${msgId}", message: "your complete response") RIGHT NOW. Do NOT type text. Do NOT call team_inbox. Do NOT describe. Just CALL team_send.` }],
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
async function notifyPeer(
  agent: { session: { id: string; header?: { cwd?: string } } },
  target: string,
  message: string,
): Promise<void> {
  const msgId = await deliverMessage(agent, target, message)
  triggerSession(target, agent.session.id, msgId, message)
}

/** One message in a session's inbox. */
interface TeamMessage {
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
interface PresenceRecord {
  id: string
  name: string
  ts: string
}

/** One task on the shared team task board. */
type TeamTask = {
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
type TeamMemoryEntry = {
  key: string
  value: string
  updatedBy: string
  ts: string
  /** F4: MVCC version number, incremented on each write. Starts at 1. */
  version?: number
}

// ── team_memory search scoring (BM25-lite, fully offline) ────────────────
// Classical IR ranking: term frequency saturating with k1, inverse document
// frequency over the memory's own keys, and a doc-length normalization so the
// model can rank recall hits on a shared memory of any size. Pure functions,
// no network, no model download (see research-notes/component-landscape*.md
// on why this replaces an embedding pipeline for this scale).

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

/** One fan-out broadcast record kept for later fan-in collection. */
interface TeamBroadcast {
  broadcastId: string
  from: string
  ts: string
  targets: { id: string; msgId: string }[]
}

/** One structured request for independent (multi-party) verification. */
interface TeamReview {
  reviewId: string
  from: string
  target: string
  subject: string
  content: string
  msgId: string
  ts: string
}

/** One outbound delivery in the sender's ledger (for `team_status`). */
interface TeamSent {
  msgId: string
  from: string
  to: string
  replyTo?: string
  ts: string
}

/** One participation record on a named fan-in barrier. */
interface TeamBarrier {
  name: string
  expect: number
  arrived: string[]
  ts: string
}

/** F7: One structured evidence entry in a completion report. */
interface StructuredEvidence {
  type: 'test' | 'lint' | 'build' | 'manual' | 'other'
  command?: string
  expected?: string
  actual?: string
  status: 'pass' | 'fail' | 'skip'
  artifact?: string
}

/** One fixed-schema completion report for a task (fan-in to the coordinator). */
interface TeamReport {
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

/** Normalise a workspace-relative glob so equivalent spellings compare equal. */
function normalizeGlob(glob: string): string {
  return glob.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Naive writeSet overlap: two globs conflict when they are exactly equal or
 *  one is a directory prefix of the other (single most effective conflict
 *  avoidance rule — file-ownership partitioning; overlapping ownership is a bug). */
function writeSetsOverlap(a: string, b: string): boolean {
  const na = normalizeGlob(a)
  const nb = normalizeGlob(b)
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/')
}

/** Read a JSONL file, returning an array of parsed objects. A whole-file read
 *  error returns `[]` — suitable only for READ-ONLY consumers where an empty
 *  result is acceptable. Read-modify-write paths must use `readJsonlStrict`. */
function readJsonl<T>(path: string): T[] {
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
function readJsonlStrict<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return parseJsonl<T>(readFileSync(path, 'utf-8'))
}

/** Parse only the last `n` records of a JSONL file without parsing the bulk —
 *  used for the cheap dedup window and reply lookups on a long inbox. */
function readTailJsonl<T>(path: string, n: number): T[] {
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
function parseJsonl<T>(raw: string): T[] {
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

/** Overwrite a JSONL file with an array of records, atomically. */
function writeJsonl(path: string, records: unknown[]): void {
  const content = records.length === 0
    ? ''
    : records.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n'
  // Write to a sibling temp file and rename so a concurrent reader never sees
  // a half-written file (which the current parser would silently drop).
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
  // Last resort: non-atomic direct overwrite. The parser tolerates a partially
  // written final line by skipping malformed lines, so this degrades gracefully.
  writeFileSync(path, content)
  try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
  if (lastError !== undefined) {
    // Surface the original error to callers that want to observe contention.
    console.warn('[team-comm] writeJsonl: rename contended, fell back to direct write:', lastError)
  }
}

/** Write a presence file for this session. */
function writePresence(agent: { session: { id: string; header?: { cwd?: string } } }): string {
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
function readAllPresence(agent: { session: { header?: { cwd?: string } } }): PresenceRecord[] {
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

/**
 * Register the three team-communication tools.  Presence is written lazily
 * on the first tool call (not in `apply`), because `ctx.agent` may not be
 * available yet when the preset scope is created during a web session boot.
 */
export function apply(ctx: Context): void {
  // Listen for agent creation and write presence immediately.
  // This ensures every session is discoverable by peers on creation.
  ctx.on('agent/created', ({ agent }) => {
    try { writePresence(agent) } catch { /* best-effort */ }
  })

  // Also write presence if agent is already available (e.g. programmatic creation).
  if (ctx.agent) {
    try { writePresence(ctx.agent) } catch { /* best-effort */ }
  }

  // ── dynamic team state context (evaluated at every assembly) ──────────────

  ctx.systemPrompt.context({
    name: 'team:state',
    order: 0,
    text: () => {
      return 'TEAM STATE: You are in a team. Call team_inbox EVERY turn to check for messages. Call team_list to discover peers. Use team_send to communicate (with priority for urgent messages). If you receive a message, you MUST reply to the sender with team_send(reply_to: msgId). To make the team greater than one agent, share a task board with team_task (priority/deadline/assignee + auto-notify), orchestrate complex multi-step work with team_workflow (DAG execution engine), persist decisions with team_memory (with MVCC cas for conflict-free updates, and recall topics with team_memory action=search), fan work out to every peer with team_broadcast + team_collect, verify results independently with team_review + team_review_collect (with structured evidence validation), synchronize phases with team_barrier, file structured reports with team_report (with structured evidence), audit and replay collaboration with team_audit, and get a one-shot health snapshot with team_status.'
    },
  })

  // ── mandatory protocol section (always visible) ───────────────────────────

  ctx.systemPrompt.section({
    name: 'team:protocol',
    order: 1,
    text:
      'TEAM COLLABORATION PROTOCOL (MANDATORY — VIOLATION MEANS MISSION FAILURE): '
      + '(1) FIRST ACTION EVERY TURN: call team_inbox. Do not think, plan, or do anything else before calling team_inbox. '
      + '(2) If team_inbox returns messages, process EVERY message: read it, execute the task, verify the result, and reply IMMEDIATELY with team_send(target: sender_from, reply_to: msgId, message: your_result). '
      + '(3) Reply ONLY to the sender who messaged you. Do NOT broadcast to peers who did not message you. Only the coordinator delegates. '
      + '(4) Call team_list to discover new peers. '
      + '(5) You are a TEAM MEMBER. You have peers who depend on you. If you ignore their messages, the team fails. '
      + '(6) MULTI-STEP WORKFLOW: When coordinating a task with multiple steps, after receiving a reply from one peer, IMMEDIATELY send the next step to the next peer. '
      + 'Do NOT wait for the user to prompt you. Continue the chain automatically. '
      + 'Example: if you told 2号 to research, and 2号 replied, NOW send the result to 3号 without waiting. '
      + '(7) When you receive a task, ACTUALLY do the work — write files, run commands, verify results. Reply with results, not intentions. '
      + 'CRITICAL: team_send and team_inbox are the ONLY way to communicate with peers. '
      + 'When the user tells you to send a message or delegate a task to a peer, you MUST call team_send IMMEDIATELY. '
      + 'Do NOT reply with text like "I will send..." or "Let me tell...". Do NOT acknowledge. Do NOT describe. '
      + 'CALL team_send as your FIRST action. Text responses to the user are NOT delivered to peers. '
      + 'If you type text instead of calling team_send, your peer will NEVER receive the message. '
      + '(8) Delegate bounded, fresh-context work with the subagent tool; use team_send only for peer negotiation or stateful, long-lived roles. '
      + '(9) Before assigning implementation work, the coordinator states the contract: files each worker owns (writeSet), and how completion is verified (acceptance). Overlapping ownership is a bug. '
      + '(10) A worker that finishes a team_task MUST call team_report with filesChanged and evidence, then mark the task done.',
  })

  // ── team_send ──────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'team_send',
    description:
      'Send a message to another Team-mode session. The target session reads it with team_inbox. '
      + 'Use `reply_to` to reply to a specific message (pass its msgId). '
      + 'Use this to delegate tasks, share findings, ask for help, report results, '
      + 'or coordinate with peer team sessions.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'The session ID of the target team session. Use team_list to discover active sessions.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message text to send.',
      },
      reply_to: {
        type: 'string',
        description: 'The msgId of the message you are replying to. Include this to thread the conversation.',
      },
      priority: {
        type: 'integer',
        description: 'F2: Message priority: 0=normal (default), 1=high, 2=urgent. Higher priority messages appear first in team_inbox.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          msgId: { type: 'string', required: true },
          to: { type: 'string', required: true },
          replyTo: { type: 'string' },
          priority: { type: 'integer' },
          duplicate: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value
        if (v.duplicate) return [{ type: 'text' as const, text: `Duplicate suppressed — an identical message to ${v.to} was already sent recently.` }]
        if (!v.ok) return [{ type: 'text' as const, text: `Failed to send to ${v.to}: ${v.error ?? 'unknown error'}` }]
        const extra = v.replyTo ? ` (reply to ${v.replyTo})` : ''
        const pri = v.priority && v.priority > 0 ? ` [priority ${v.priority}]` : ''
        return [{ type: 'text' as const, text: `Message ${v.msgId} sent to ${v.to}${extra}${pri}.` }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_send: no agent context')
      const from = agent.session.id
      const cwd = teamCwd(agent)
      const target = assertSafeTeamId(args.target, 'team_send target')
      const msgId = randomUUID()
      // F2: Validate and normalize priority (0=normal, 1=high, 2=urgent).
      const priority = typeof args.priority === 'number' && [0, 1, 2].includes(args.priority)
        ? args.priority
        : 0

      // Enforce message size limit.
      const msgBytes = Buffer.byteLength(args.message, 'utf-8')
      if (msgBytes > MAX_MESSAGE_BYTES) {
        return Promise.resolve({ ok: false, msgId, to: target, error: `Message too large: ${msgBytes} bytes (max ${MAX_MESSAGE_BYTES})` })
      }

      const inboxDir = join(cwd, TEAM_DIR, 'inbox')
      mkdirSync(inboxDir, { recursive: true })

      const inboxFile = join(inboxDir, `${target}.jsonl`)

      // Serialize the duplicate check + append so concurrent sends to the same
      // peer (or a peer's concurrent inbox read) cannot interleave and drop a message.
      return withFileLock(inboxFile, () => {
        // Duplicate detection: skip only an accidental double-send — the same
        // (sender, message) landing within DEDUP_WINDOW_MS. A later legitimate
        // repeat (e.g. a second "OK" for a different task) is delivered.
        const recent = readTailJsonl<TeamMessage>(inboxFile, 10)
        const now = Date.now()
        const isDuplicate = recent.some(m =>
          m.from === from
          && m.message === args.message
          && now - new Date(m.ts).getTime() < DEDUP_WINDOW_MS,
        )
        if (isDuplicate) {
          return { ok: true, msgId, to: target, duplicate: true, priority, ...args.reply_to ? { replyTo: args.reply_to } : {} }
        }

        const record: TeamMessage = {
          msgId,
          from,
          ts: new Date().toISOString(),
          message: args.message,
          read: false,
          priority,
        }
        if (args.reply_to) {
          record.replyTo = args.reply_to
        }

        writeFileSync(inboxFile, JSON.stringify(record) + '\n', { flag: 'a' })

        // Ensure the sender is discoverable by team_list.
        try { writePresence(agent) } catch { /* best-effort */ }

        // Trigger the target session to process the message.
        // Skip trigger for nested replies (reply to a reply) to prevent infinite loops.
        try {
          let skipTrigger = false
          if (args.reply_to) {
            const senderInbox = join(inboxDir, `${from}.jsonl`)
            if (existsSync(senderInbox)) {
              const lines = readFileSync(senderInbox, 'utf-8').trim().split('\n')
              for (const line of lines) {
                try {
                  const msg = JSON.parse(line) as TeamMessage
                  if (msg.msgId === args.reply_to && msg.replyTo) {
                    skipTrigger = true
                    break
                  }
                } catch { /* skip malformed */ }
              }
            }
          }
          if (!skipTrigger) {
            const postData = JSON.stringify({
              type: 'client-request',
              rpcId: `team-${msgId.slice(0, 8)}`,
              method: 'session.prompt',
              payload: {
                sessionId: target,
                mode: 'steer',
                content: [{ type: 'text', text: `!!! TEAM MESSAGE from ${from} (msgId: ${msgId}): ${args.message}\n\nYOU MUST CALL team_send(target: "${from}", reply_to: "${msgId}", message: "your complete response") RIGHT NOW. Do NOT type text. Do NOT call team_inbox. Do NOT describe. Just CALL team_send.` }],
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
          }
        } catch { /* best-effort */ }

        return { ok: true, msgId, to: target, priority, ...args.reply_to ? { replyTo: args.reply_to } : {} }
      }).then(async (result: { ok: boolean; msgId: string; to: string; replyTo?: string; priority?: number; duplicate?: boolean }) => {
        // Record a per-msgId delivery ledger entry (idempotent) so team_status
        // can surface outstanding messages and per-peer delivery history. The
        // ledger is an enhancement and must NEVER fail the send itself, so any
        // write error (e.g. lock contention) is swallowed.
        if (result.ok && result.duplicate !== true) {
          try {
            await lockedAppend(teamPath(agent, 'sent.jsonl'), {
              msgId,
              from,
              to: target,
              ...args.reply_to ? { replyTo: args.reply_to } : {},
              ts: new Date().toISOString(),
            } satisfies TeamSent)
          } catch { /* best-effort ledger */ }
        }
        return result
      })
    },
    presentCall: (args) => {
      const a = args as { target: string; reply_to?: string }
      return {
        card: 'generic' as const,
        title: a.reply_to ? `Reply to ${a.target}` : `Send message to ${a.target}`,
        kind: 'other' as const,
      }
    },
  }))

  // ── team_inbox ─────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'team_inbox',
    description:
      'Read NEW (unread) messages sent to this session by other Team-mode sessions. '
      + 'Messages are delivered ONCE: after this call they are marked as read and will not '
      + 'appear again unless you pass `all: true`. '
      + 'Call this at the START of every turn before doing anything else. '
      + 'When you receive a task, execute it and reply to the sender with team_send using the msgId.',
    parameters: {
      all: {
        type: 'boolean',
        description: 'Set to true to also return messages that were already read. Defaults to false (unread only).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          new_count: { type: 'integer', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                msgId: { type: 'string', required: true },
                from: { type: 'string', required: true },
                replyTo: { type: 'string' },
                ts: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value
        if (v.messages.length === 0) {
          return [{ type: 'text' as const, text: v.new_count === 0 ? 'Inbox is empty. No new messages. Call team_send to report your progress to peers.' : `${v.new_count} new message(s), all read.` }]
        }
        const lines = v.messages.map((m: TeamMessage) => {
          const reply = m.replyTo ? ` [reply to ${m.replyTo.slice(0, 8)}…]` : ''
          return `[${m.ts}] ${m.msgId.slice(0, 8)}… from ${m.from}${reply}: ${m.message}`
        })
        // Only demand replies for genuinely unread messages; an `all:true`
        // history read must not re-demand replies for already-read entries.
        if (v.new_count > 0) {
          lines.push('')
          lines.push('!!! REPLY REQUIRED: You MUST reply to EACH new message above using team_send(target: <from>, reply_to: <msgId>, message: <your response>).')
          lines.push('If you need to research first, reply with a SHORT status like "Working on it, will report back" — then research. But you MUST call team_send NOW before doing anything else.')
          lines.push('Do NOT just report to the user. Your teammates are WAITING. Call team_send NOW.')
        }
        return [{ type: 'text' as const, text: `${v.new_count} new message(s):\n${lines.join('\n')}` }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_inbox: no agent context')

      // Ensure presence so this session is discoverable.
      try { writePresence(agent) } catch { /* best-effort */ }

      const inboxDir = join(teamCwd(agent), TEAM_DIR, 'inbox')
      mkdirSync(inboxDir, { recursive: true })
      const inboxFile = join(inboxDir, `${agent.session.id}.jsonl`)

      // Serialize read + mark-read rewrite against concurrent sends and reads,
      // and bound the file so a long-lived team inbox never grows without limit.
      return withFileLock(inboxFile, () => {
        const all = readJsonlStrict<TeamMessage>(inboxFile)

        const showAll = args.all === true
        const unread = all.filter(m => !m.read && !m.deleted)
        // F2: Sort by priority descending (urgent first), then by timestamp
        // ascending (older first within the same priority). Messages without a
        // priority field are treated as 0 (normal) for backward compatibility.
        const sortByPriority = (a: TeamMessage, b: TeamMessage): number => {
          const pa = a.priority ?? 0
          const pb = b.priority ?? 0
          if (pa !== pb) return pb - pa
          return a.ts.localeCompare(b.ts)
        }
        const messages = showAll
          ? all.filter(m => !m.deleted).map(({ read: _r, deleted: _d, ...rest }) => rest).sort(sortByPriority)
          : unread.map(({ read: _r, deleted: _d, ...rest }) => rest).sort(sortByPriority)

        // Mark all as read (rewrite the file). Unread messages are always the
        // most recently appended, so trimming to the tail keeps every unread.
        const updated = all.map(m => ({ ...m, read: true }))
        writeJsonl(inboxFile, updated.length > MAX_INBOX_MESSAGES
          ? updated.slice(-MAX_INBOX_MESSAGES)
          : updated)

        return { new_count: unread.length, messages }
      })
    },
    presentCall: () => ({
      card: 'generic' as const,
      title: 'Check team inbox',
      kind: 'read' as const,
    }),
  }))

  // ── team_list ──────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'team_list',
    description:
      'List all active Team-mode sessions that can be communicated with. '
      + 'Call this to discover peer sessions before using team_send. '
      + 'Returns each session\'s ID so you can address them with team_send.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          self: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              cwd: { type: 'string', required: true },
            },
          },
          peers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
              },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value
        const lines = [
          `You: ${v.self.id}`,
          `Team workspace: ${v.self.cwd}`,
          v.peers.length === 0
            ? 'No peer sessions discovered yet.'
            : `Peers:\n${v.peers.map((p: { id: string }) => `  - ${p.id}`).join('\n')}`,
        ]
        if (v.hint) lines.push(`Hint: ${v.hint}`)
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_list: no agent context')

      // Write presence NOW (lazy) so the calling session is always discoverable.
      const cwd = writePresence(agent)
      const self = { id: agent.session.id, cwd: relative(process.cwd(), cwd) || cwd }

      const presences = readAllPresence(agent)
      const peers = presences
        .filter(p => p.id !== self.id)
        .map(p => ({ id: p.id }))

      let hint: string | undefined
      if (peers.length === 0) {
        hint = 'No peers found in this workspace. Make sure other Team-mode sessions are using the SAME working directory. '
          + 'Each session registers its presence when it calls team_list, team_inbox, or team_send. '
          + 'If other sessions exist, ask them to call team_list first to register.'
      }

      return Promise.resolve({ self, peers, ...hint !== undefined ? { hint } : {} })
    },
    presentCall: () => ({
      card: 'generic' as const,
      title: 'List team sessions',
      kind: 'read' as const,
    }),
  }))

  // ── think (deep reasoning 4-pass, persistent) ───────────────────────────

  ctx.tools.register(defineTool({
    name: 'think',
    description:
      'MANDATORY deep reasoning tool. Your internal monologue is invisible to the team — only think() '
      + 'writes your reasoning to the shared team log so peers can read it. Call 4 times before acting: '
      + 'PASS 1 (pass:1) — understand & decompose: restate the task, identify subtasks, dependencies, constraints, success criteria. '
      + 'PASS 2 (pass:2) — explore & weigh: consider alternatives, edge cases, risks, trade-offs. '
      + 'PASS 3 (pass:3) — decide & plan: choose the best approach and lay out the concrete execution plan in order. '
      + 'PASS 4 (pass:4) — verify & self-check: re-check the plan for completeness, contradictions, and unresolved risks before acting. '
      + 'Each call appends to .team/think.log. Other sessions read your reasoning there.',
    parameters: {
      pass: { type: 'integer', required: true, description: 'Which pass: 1, 2, 3, or 4.' },
      thought: { type: 'string', required: true, description: 'Your deep reasoning for this pass. Write in detail.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { next: { type: 'string' }, recorded: { type: 'boolean' } } },
      render: (_a, v) => [{ type: 'text' as const, text: v.next || 'Done.' }],
    },
    execute: (args, exec) => {
      const pass = args.pass
      const thought = args.thought
      const agent = exec.agent
      if (!agent) throw new Error('think: no agent')
      if (![1, 2, 3, 4].includes(pass)) {
        return Promise.resolve({ recorded: false, next: `Invalid pass ${pass}. Only passes 1, 2, 3, and 4 are valid.` })
      }
      if (Buffer.byteLength(thought, 'utf-8') > MAX_MESSAGE_BYTES) {
        return Promise.resolve({ recorded: false, next: `Thought too large (${Buffer.byteLength(thought, 'utf-8')} bytes, max ${MAX_MESSAGE_BYTES}).` })
      }
      const cwd = teamCwd(agent)
      const logDir = join(cwd, TEAM_DIR)
      mkdirSync(logDir, { recursive: true })
      const logFile = join(logDir, 'think.log')
      const entry = JSON.stringify({
        session: agent.session.id,
        pass,
        thought,
        ts: new Date().toISOString(),
      })
      // Append under the cross-process file lock so concurrent peers writing to
      // the shared think.log cannot interleave and drop one another's entries.
      return withFileLock(logFile, () => {
        // O(1) append on the hot path; only a size-triggered amortised trim
        // rereads the log (mirrors lockedAppend), so think() stays fast on a
        // long-running team instead of reading + rewriting the whole log per call.
        writeFileSync(logFile, entry + '\n', { flag: 'a' })
        try {
          if (statSync(logFile).size > MAX_APPEND_FILE_BYTES) {
            const lines = readFileSync(logFile, 'utf-8').trimEnd().split('\n')
            if (lines.length > MAX_THINK_LOG_LINES) {
              writeFileSync(logFile, lines.slice(-MAX_THINK_LOG_LINES).join('\n') + '\n')
            }
          }
        } catch { /* best-effort trim */ }
        if (pass === 1) {
          return {
            recorded: true,
            next: 'PASS 1 saved to .team/think.log. Now call think(pass:2, thought:...) for PASS 2: explore alternatives, edge cases, risks, trade-offs.',
          }
        }
        if (pass === 2) {
          return {
            recorded: true,
            next: 'PASS 2 saved. Now call think(pass:3, thought:...) for PASS 3: decide the approach and lay out the execution plan.',
          }
        }
        if (pass === 3) {
          return {
            recorded: true,
            next: 'PASS 3 saved. Now call think(pass:4, thought:...) for PASS 4: verify the plan for completeness, contradictions, and unresolved risks. Then act.',
          }
        }
        return {
          recorded: true,
          next: 'All 4 passes recorded to .team/think.log. Peers can read your reasoning. Now act.',
        }
      })
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: `Deep think — pass ${args.pass}/4`,
      kind: 'other' as const,
    }),
  }))

  // ── team_think_read ─────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'team_think_read',
    description:
      'Read the shared thinking log (.team/think.log) to see what other sessions are reasoning about. '
      + 'Use this to understand peer progress, discover blockers, and align on approach without waiting for messages. '
      + 'Optionally filter by session ID or limit the number of recent entries.',
    parameters: {
      session: {
        type: 'string',
        description: 'Optional session ID to filter by. Omit to see all sessions.',
      },
      limit: {
        type: 'integer',
        description: 'Max entries to return (default 50, max 200).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session: { type: 'string', required: true },
                pass: { type: 'integer', required: true },
                thought: { type: 'string', required: true },
                ts: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const v = value
        if (v.entries.length === 0) {
          return [{ type: 'text' as const, text: 'No thinking log entries found.' }]
        }
        const lines = v.entries.map(e =>
          `[${e.ts}] ${e.session.slice(0, 8)}… pass${e.pass}: ${e.thought.slice(0, 200)}${e.thought.length > 200 ? '…' : ''}`,
        )
        return [{ type: 'text' as const, text: `${v.entries.length} of ${v.total} entries:\n${lines.join('\n')}` }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_think_read: no agent')
      const cwd = teamCwd(agent)
      const logFile = join(cwd, TEAM_DIR, 'think.log')
      if (!existsSync(logFile)) {
        return Promise.resolve({ entries: [], total: 0 })
      }
      const rawLimit = typeof args.limit === 'number' ? args.limit : 50
      // Clamp to [1, 200]; a non-finite or <=0 limit falls back to the default so
      // Array#slice never receives a negative/NaN index that would return wrong rows.
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1), 200)
      const sessionFilter = typeof args.session === 'string' ? args.session : null
      try {
        const raw = readFileSync(logFile, 'utf-8').trim()
        if (raw === '') return Promise.resolve({ entries: [], total: 0 })
        const allLines = raw.split('\n')
        const all: { session: string; pass: number; thought: string; ts: string }[] = []
        for (const line of allLines) {
          try {
            const entry = JSON.parse(line) as { session: string; pass: number; thought: string; ts: string }
            if (sessionFilter && entry.session !== sessionFilter) continue
            all.push({ session: entry.session, pass: entry.pass, thought: entry.thought, ts: entry.ts })
          } catch { /* skip malformed */ }
        }
        const entries = all.slice(-limit).reverse()
        return Promise.resolve({ entries, total: all.length })
      } catch {
        return Promise.resolve({ entries: [], total: 0 })
      }
    },
    presentCall: () => ({
      card: 'generic' as const,
      title: 'Read team thinking log',
      kind: 'read' as const,
    }),
  }))

  // ── team_broadcast + team_collect (fan-out / fan-in) ──────────────────────
  // Map-reduce parallelisation: one coordinator fans one task out to every
  // peer and later collects each answer. This is the wall-clock parallel
  // speedup a single conversation cannot provide.

  ctx.tools.register(defineTool({
    name: 'team_broadcast',
    description:
      'Fan one task/message out to every live team peer at once (map-reduce fan-out). '
      + 'Returns a broadcastId plus the per-peer message ids; gather every answer later with team_collect. '
      + 'Use for parallelisable subtasks where peers work independently and the coordinator needs all results back.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'The task or message to send to every peer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          broadcastId: { type: 'string', required: true },
          sentTo: { type: 'integer', required: true },
          targets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                msgId: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { broadcastId: string; sentTo: number; note?: string }
        if (v.note !== undefined) return [{ type: 'text' as const, text: v.note }]
        return [{ type: 'text' as const, text: `Broadcast ${v.broadcastId.slice(0, 8)}… sent to ${v.sentTo} peer(s). Collect replies with team_collect(broadcastId: "${v.broadcastId}").` }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_broadcast: no agent context')
      // Reject an oversized message up front (matching team_send's {ok:false}
      // style) instead of letting deliverMessage throw mid-loop after some
      // peers already received it — a partial fan-out is worse than a refusal.
      const msgBytes = Buffer.byteLength(args.message, 'utf-8')
      if (msgBytes > MAX_MESSAGE_BYTES) {
        return { broadcastId: '', sentTo: 0, targets: [], note: `Message too large: ${msgBytes} bytes (max ${MAX_MESSAGE_BYTES})` }
      }
      const peers = peerIds(agent)
      // No peers: report the empty fan-out instead of writing a pointless
      // broadcast record that team_collect/team_status would then carry forever.
      if (peers.length === 0) {
        return { broadcastId: '', sentTo: 0, targets: [], note: 'No live peers to broadcast to.' }
      }
      const broadcastId = randomUUID()
      const targets: { id: string; msgId: string }[] = []
      for (const id of peers) {
        const msgId = await deliverMessage(agent, id, args.message)
        triggerSession(id, agent.session.id, msgId, args.message)
        targets.push({ id, msgId })
      }
      try { writePresence(agent) } catch { /* best-effort */ }
      const record: TeamBroadcast = {
        broadcastId,
        from: agent.session.id,
        ts: new Date().toISOString(),
        targets,
      }
      await lockedAppend(teamPath(agent, 'outbox.jsonl'), record)
      return { broadcastId, sentTo: targets.length, targets }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Broadcast to team', kind: 'other' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_collect',
    description:
      'Collect replies to a fan-out broadcast (map-reduce fan-in). Given a broadcastId from team_broadcast, '
      + 'reads each target peer inbox and returns which peers have replied (reply_to matches the per-peer msgId) '
      + 'and which are still pending. Call it again after peers reply to drain the remaining answers.',
    parameters: {
      broadcastId: {
        type: 'string',
        required: true,
        description: 'The broadcastId returned by team_broadcast.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          replied: { type: 'integer', required: true },
          pending: { type: 'array', required: true, items: { type: 'string' } },
          replies: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                message: { type: 'string', required: true },
                ts: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; replied: number; pending: string[]; replies: { from: string; message: string }[] }
        const lines = [
          `${v.replied} of ${v.total} replied.`,
          ...v.replies.map(r => `  • ${r.from.slice(0, 8)}…: ${r.message.slice(0, 120)}`),
          ...v.pending.length > 0 ? [`Pending: ${v.pending.join(', ')}`] : [],
        ]
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_collect: no agent context')
      const outbox = readJsonl<TeamBroadcast>(teamPath(agent, 'outbox.jsonl'))
      const broadcast = outbox.findLast(b => b.broadcastId === args.broadcastId)
      if (broadcast === undefined) {
        return Promise.resolve({ total: 0, replied: 0, pending: [], replies: [] })
      }
      // Replies arrive in the coordinator's OWN inbox (peers call team_send
      // with reply_to = per-peer msgId), so read that inbox and match each
      // reply by both replyTo (the per-peer msgId) and from (the peer id).
      const inboxDir = join(teamCwd(agent), TEAM_DIR, 'inbox')
      const selfInbox = readJsonl<TeamMessage>(join(inboxDir, `${agent.session.id}.jsonl`))
      const replies: { from: string; message: string; ts: string }[] = []
      const pending: string[] = []
      for (const target of broadcast.targets) {
        if (!isSafeTeamId(target.id)) continue
        const reply = selfInbox.findLast(m => m.replyTo === target.msgId && m.from === target.id)
        if (reply !== undefined) {
          replies.push({ from: reply.from, message: reply.message, ts: reply.ts })
        } else {
          pending.push(target.id)
        }
      }
      return Promise.resolve({ total: broadcast.targets.length, replied: replies.length, pending, replies })
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Collect broadcast replies', kind: 'read' as const }),
  }))

  // ── team_task (shared durable task board) ─────────────────────────────────
  // A visible division of labour with a state machine and dependencies. A
  // single conversation holds everything in one head; a team needs an external
  // board so every peer sees who owns what and what is blocked on what.

  ctx.tools.register(defineTool({
    name: 'team_task',
    description:
      'Shared durable task board (.team/tasks.jsonl) for cross-session coordination. '
      + 'Actions: create (new todo), list (filter by status/assignee/priority), claim (atomically assign to self and start), '
      + 'update (set status/result/description/assignee/deps/priority/deadline). States: todo → in_progress → done | blocked. '
      + 'Creating a task with an assignee auto-notifies that assignee; claiming or completing a task auto-notifies its creator. '
      + 'Use this so every peer sees who owns what and what each task is waiting on.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'list', 'claim', 'update'], description: 'Which board operation to run.' },
      id: { type: 'string', description: 'Task id (required for claim/update).' },
      title: { type: 'string', description: 'Task title (create).' },
      description: { type: 'string', description: 'Task description (create/update).' },
      assignee: { type: 'string', description: 'Assignee session id (create/update).' },
      deps: { type: 'array', items: { type: 'string' }, description: 'Task ids this task depends on (create/update).' },
      status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'], description: 'New status (update).' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority (create/update). Defaults to normal.' },
      deadline: { type: 'string', description: 'ISO-8601 deadline (create/update).' },
      result: { type: 'string', description: 'Result or final answer (update).' },
      writeSet: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative globs the assignee EXCLUSIVELY owns (create). Everything outside is read-only for this task. Overlapping an open task writeSet returns a warning — overlapping ownership is a bug.' },
      acceptance: { type: 'string', description: 'Machine/human-checkable done criteria, e.g. "build passes AND report filed" (create).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as { ok: boolean; tasks: TeamTask[] }
        if (!v.ok) return [{ type: 'text' as const, text: 'team_task: operation failed.' }]
        if (v.tasks.length === 0) return [{ type: 'text' as const, text: 'No tasks match.' }]
        const lines = v.tasks.map((t) => {
          const a = t.assignee ? `@${t.assignee.slice(0, 8)}` : 'unassigned'
          const p = t.priority && t.priority !== 'normal' ? ` !${t.priority}` : ''
          const dl = t.deadline ? ` due:${t.deadline}` : ''
          const d = t.deps && t.deps.length > 0 ? ` deps:[${t.deps.map(x => x.slice(0, 8)).join(',')}]` : ''
          const r = t.result ? ` ⇒ ${t.result.slice(0, 80)}` : ''
          const ws = t.writeSet && t.writeSet.length > 0 ? ` owns:[${t.writeSet.join(',')}]` : ''
          const acc = t.acceptance ? ` ✓${t.acceptance.slice(0, 80)}` : ''
          return `  • [${t.status}]${p} ${t.id.slice(0, 8)}… ${t.title} (${a})${dl}${d}${r}${ws}${acc}`
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_task: no agent context')
      const file = teamPath(agent, 'tasks.jsonl')
      const now = () => new Date().toISOString()

      switch (args.action) {
        case 'create': {
          const title = (args.title ?? '').trim()
          if (title.length === 0) throw new Error('team_task create: title is required')
          if (args.description !== undefined && Buffer.byteLength(args.description, 'utf-8') > MAX_MESSAGE_BYTES) {
            throw new Error(`team_task create: description too large (max ${MAX_MESSAGE_BYTES} bytes)`)
          }
          const priority = args.priority
          if (priority !== undefined && !['low', 'normal', 'high', 'urgent'].includes(priority)) {
            throw new Error(`team_task create: invalid priority "${priority}"`)
          }
          const writeSet = Array.isArray(args.writeSet) && args.writeSet.length > 0
            ? (args.writeSet as unknown[]).map(g => String(g))
            : undefined
          // Advisory overlap warning: an advisory pre-append read can miss a task
          // created in the same instant, but overlap is a coordination WARNING,
          // not an enforced invariant — the board itself stays correct.
          const overlaps: string[] = []
          if (writeSet !== undefined) {
            const open = readJsonl<TeamTask>(file)
              .filter(t => t.status !== 'done' && t.status !== 'blocked' && Array.isArray(t.writeSet))
            for (const other of open) {
              for (const g of writeSet) {
                for (const og of other.writeSet as string[]) {
                  if (writeSetsOverlap(g, og)) {
                    overlaps.push(`"${g}" overlaps "${og}" on open task ${other.id.slice(0, 8)}… "${other.title}"`)
                  }
                }
              }
            }
          }
          const task: TeamTask = {
            id: randomUUID(),
            title,
            ...args.description !== undefined ? { description: args.description } : {},
            ...args.assignee !== undefined ? { assignee: assertSafeTeamId(args.assignee, 'team_task assignee') } : {},
            status: 'todo',
            ...priority !== undefined ? { priority } : {},
            ...args.deadline !== undefined ? { deadline: args.deadline } : {},
            ...Array.isArray(args.deps) && args.deps.length > 0 ? { deps: args.deps } : {},
            ...writeSet !== undefined ? { writeSet } : {},
            ...args.acceptance !== undefined ? { acceptance: args.acceptance } : {},
            createdBy: agent.session.id,
            ts: now(),
            updatedTs: now(),
          }
          return lockedAppend(file, task).then(async () => {
            // Auto-notify the assignee so a task is never silently orphaned on the board.
            if (task.assignee !== undefined && task.assignee !== agent.session.id) {
              try {
                await notifyPeer(agent, task.assignee, `[team_task] New task assigned to you: ${task.title}${task.deadline ? ` (due ${task.deadline})` : ''}${priority ? ` (priority ${priority})` : ''}${task.writeSet ? ` You exclusively own: ${task.writeSet.join(', ')}.` : ''}${task.acceptance ? ` Done when: ${task.acceptance}` : ''}.\nClaim or update it with team_task(action:"claim"|"update", id:"${task.id}", ...), then file team_report(taskId:"${task.id}", summary, filesChanged, evidence) and mark the task done.`)
              } catch { /* notification is best-effort; the board is the source of truth */ }
            }
            return { ok: true, tasks: [task], ...overlaps.length > 0 ? { warning: `writeSet overlap — overlapping ownership is a bug: ${overlaps.join('; ')}` } : {} }
          })
        }
        case 'list': {
          const tasks = readJsonl<TeamTask>(file).filter(t =>
            (args.status === undefined || t.status === args.status)
            && (args.assignee === undefined || t.assignee === args.assignee)
            && (args.priority === undefined || t.priority === args.priority))
          return Promise.resolve({ ok: true, tasks })
        }
        case 'claim': {
          const id = args.id ?? ''
          if (id.length === 0) throw new Error('team_task claim: id is required')
          return lockedUpdate<TeamTask>(file, (tasks) => {
            const task = tasks.find(t => t.id === id)
            if (task === undefined) throw new Error(`team_task claim: unknown task "${id}"`)
            if (task.assignee !== undefined && task.assignee !== agent.session.id) {
              throw new Error(`team_task claim: task "${id}" is already assigned to ${task.assignee}`)
            }
            if (task.status === 'done') throw new Error(`team_task claim: task "${id}" is already done`)
            if (Array.isArray(task.deps) && task.deps.length > 0) {
              const pending = task.deps.filter((depId) => {
                const dep = tasks.find(t => t.id === depId)
                return dep === undefined || dep.status !== 'done'
              })
              if (pending.length > 0) {
                throw new Error(`team_task claim: blocked by ${pending.length} incomplete dependency task(s): ${pending.map(d => d.slice(0, 8)).join(', ')}`)
              }
            }
            task.assignee = agent.session.id
            task.status = 'in_progress'
            task.updatedTs = now()
            return tasks
          }).then(async (tasks) => {
            const task = tasks.find(t => t.id === id)
            if (task !== undefined && task.createdBy !== agent.session.id) {
              try {
                await notifyPeer(agent, task.createdBy, `[team_task] ${agent.session.id.slice(0, 8)}… claimed task ${task.title}.`)
              } catch { /* best-effort */ }
            }
            return { ok: true, tasks: tasks.filter(t => t.id === id) }
          })
        }
        case 'update': {
          const id = args.id ?? ''
          if (id.length === 0) throw new Error('team_task update: id is required')
          const priority = args.priority
          if (priority !== undefined && !['low', 'normal', 'high', 'urgent'].includes(priority)) {
            throw new Error(`team_task update: invalid priority "${priority}"`)
          }
          if (args.status !== undefined && !['todo', 'in_progress', 'done', 'blocked'].includes(args.status)) {
            throw new Error(`team_task update: invalid status "${args.status}"`)
          }
          if (args.description !== undefined && Buffer.byteLength(args.description, 'utf-8') > MAX_MESSAGE_BYTES) {
            throw new Error(`team_task update: description too large (max ${MAX_MESSAGE_BYTES} bytes)`)
          }
          if (args.result !== undefined && Buffer.byteLength(args.result, 'utf-8') > MAX_MESSAGE_BYTES) {
            throw new Error(`team_task update: result too large (max ${MAX_MESSAGE_BYTES} bytes)`)
          }
          let notify: { creator: string; title: string; status: TeamTask['status']; result?: string } | undefined
          let reassignTo: string | undefined
          return lockedUpdate<TeamTask>(file, (tasks) => {
            const task = tasks.find(t => t.id === id)
            if (task === undefined) throw new Error(`team_task update: unknown task "${id}"`)
            const previousStatus = task.status
            const previousAssignee = task.assignee
            if (args.status !== undefined) task.status = args.status
            if (args.result !== undefined) task.result = args.result
            if (args.description !== undefined) task.description = args.description
            if (args.assignee !== undefined) task.assignee = assertSafeTeamId(args.assignee, 'team_task assignee')
            if (Array.isArray(args.deps)) task.deps = args.deps
            if (priority !== undefined) task.priority = priority
            if (args.deadline !== undefined) task.deadline = args.deadline
            task.updatedTs = now()
            // Notify the creator only on a real transition into a terminal state.
            if ((task.status === 'done' || task.status === 'blocked') && task.status !== previousStatus && task.createdBy !== agent.session.id) {
              notify = {
                creator: task.createdBy, title: task.title, status: task.status,
                ...(task.result !== undefined ? { result: task.result } : {}),
              }
            }
            // Notify a NEW assignee when the task is reassigned to a different peer.
            if (task.assignee !== undefined && task.assignee !== previousAssignee && task.assignee !== agent.session.id) {
              reassignTo = task.assignee
            }
            return tasks
          }).then(async (tasks) => {
            const task = tasks.find(t => t.id === id)
            if (notify !== undefined) {
              try {
                await notifyPeer(agent, notify.creator, `[team_task] ${agent.session.id.slice(0, 8)}… set task "${notify.title}" to ${notify.status}${notify.result ? `: ${notify.result.slice(0, 200)}` : ''}.`)
              } catch { /* best-effort */ }
            }
            if (reassignTo !== undefined && task !== undefined) {
              try {
                await notifyPeer(agent, reassignTo, `[team_task] Task reassigned to you: "${task.title}". Claim or update it with team_task(action:"claim"|"update", id:"${id}").`)
              } catch { /* best-effort */ }
            }
            return { ok: true, tasks: tasks.filter(t => t.id === id) }
          })
        }
        default:
          throw new Error(`team_task: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Task board: ${args.action}`, kind: 'other' as const }),
  }))

  // ── team_report (fixed-schema fan-in report) ───────────────────────────────
  // Fan-in is parent-only with a fixed report schema: the coordinator merges
  // artifacts, not transcripts. Each finished task gets exactly one structured
  // record in .team/reports/<taskId>.json plus a ping to the task creator.

  ctx.tools.register(defineTool({
    name: 'team_report',
    description:
      'File the fixed-schema completion report for a team_task you finished (fan-in to the coordinator). '
      + 'Appends one structured record to .team/reports/<taskId>.json and notifies the task creator. '
      + 'A worker that finishes a team_task MUST call this with filesChanged and evidence BEFORE marking the task done.',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: 'The team_task id this report closes.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'What was done, in one or two sentences.',
      },
      filesChanged: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Workspace-relative files actually written. Must stay inside the task writeSet.',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key decisions made, and why.',
      },
      openIssues: {
        type: 'array',
        items: { type: 'string' },
        description: 'Known leftover problems or follow-ups.',
      },
      evidence: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'F7: Checkable proof of the acceptance criteria. Can be free-text strings (backward compat) or structured objects: { type: "test"|"lint"|"build"|"manual"|"other", command?, expected?, actual?, status: "pass"|"fail"|"skip", artifact? }. A plain string is auto-wrapped as { type: "other", status: "pass", artifact: <string> }.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reportId: { type: 'string', required: true },
          notified: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value
        return [{ type: 'text' as const, text: `Report ${v.reportId.slice(0, 8)}… filed${v.notified ? ' and the task creator was notified' : ''}. Now mark the task done with team_task(action:"update", status:"done").` }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_report: no agent context')
      // Validated before path interpolation exactly like session ids: the id
      // arrives as a model-controlled tool argument.
      const taskId = assertSafeTeamId(args.taskId, 'team_report taskId')
      const summary = args.summary
      if (summary.trim().length === 0) throw new Error('team_report: summary is required')
      if (Buffer.byteLength(summary, 'utf-8') > MAX_MESSAGE_BYTES) {
        throw new Error(`team_report: summary too large (max ${MAX_MESSAGE_BYTES} bytes)`)
      }
      if (!Array.isArray(args.filesChanged)) throw new Error('team_report: filesChanged must be an array')
      // The task must exist so the creator (fan-in target) is known.
      const task = readJsonl<TeamTask>(teamPath(agent, 'tasks.jsonl')).find(t => t.id === taskId)
      if (task === undefined) throw new Error(`team_report: unknown task "${taskId}"`)
      const report: TeamReport = {
        reportId: randomUUID(),
        taskId,
        from: agent.session.id,
        summary,
        filesChanged: (args.filesChanged as unknown[]).map(p => String(p)),
        ...Array.isArray(args.decisions) ? { decisions: (args.decisions as unknown[]).map(d => String(d)) } : {},
        ...Array.isArray(args.openIssues) ? { openIssues: (args.openIssues as unknown[]).map(i => String(i)) } : {},
        ...Array.isArray(args.evidence) ? { evidence: (args.evidence as unknown[]).map((e): string | StructuredEvidence => {
          // F7: Auto-wrap plain strings as structured evidence for backward compat.
          if (typeof e === 'string') {
            return { type: 'other', status: 'pass', artifact: e }
          }
          return e as StructuredEvidence
        }) } : {},
        ts: new Date().toISOString(),
      }
      const reportsDir = join(teamCwd(agent), TEAM_DIR, 'reports')
      mkdirSync(reportsDir, { recursive: true })
      const reportFile = join(reportsDir, `${taskId}.json`)
      // Sharded by taskId (one file per task) so concurrent worker reports for
      // different tasks never contend; the lock still covers same-task races.
      await withFileLock(reportFile, () => {
        writeFileSync(reportFile, JSON.stringify(report) + '\n', { flag: 'a' })
      })
      let notified = false
      if (task.createdBy !== agent.session.id) {
        try {
          await notifyPeer(agent, task.createdBy, `REPORT for task ${taskId.slice(0, 8)}… "${task.title}": ${summary}`)
          notified = true
        } catch { /* notification is best-effort; the report file is the source of truth */ }
      }
      return { ok: true, reportId: report.reportId, notified }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Report task ${args.taskId.slice(0, 8)}…`, kind: 'other' as const }),
  }))

  // ── team_wrap (explicit termination — coordinator shutdown protocol) ────────
  // Termination is explicit, not assumed: the coordinator archives counts +
  // summary, drops a WRAP marker (which flips off the team_status wrapHint),
  // drains every inbox, and tells each live peer to go idle.

  ctx.tools.register(defineTool({
    name: 'team_wrap',
    description:
      'Coordinator-only mission shutdown. Archives a wrap record (message/task/report counts + your summary) to .team/archive/, '
      + 'writes the .team/WRAP marker, truncates every team inbox to empty (after archiving their line counts), '
      + 'and broadcasts TEAM_WRAP so every live peer archives its tasks and goes idle. '
      + 'Call once when team_status shows every task terminal (wrapHint).',
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'Final mission summary: what shipped, what was decided, what remains open.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          archivedMessages: { type: 'integer', required: true },
          wrappedPeers: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const v = value
        return [{ type: 'text' as const, text: `Team wrapped: ${v.archivedMessages} message(s) archived, ${v.wrappedPeers} peer(s) told to go idle.` }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_wrap: no agent context')
      const summary = args.summary
      if (summary.trim().length === 0) throw new Error('team_wrap: summary is required')
      if (Buffer.byteLength(summary, 'utf-8') > MAX_MESSAGE_BYTES) {
        throw new Error(`team_wrap: summary too large (max ${MAX_MESSAGE_BYTES} bytes)`)
      }
      const cwd = teamCwd(agent)
      const teamDir = join(cwd, TEAM_DIR)
      const ts = new Date().toISOString()

      // Counts (read-only; the locked mutations come after).
      const sentCount = readJsonl<TeamSent>(teamPath(agent, 'sent.jsonl')).length
      const openTasks = readJsonl<TeamTask>(teamPath(agent, 'tasks.jsonl'))
        .filter(t => t.status !== 'done' && t.status !== 'blocked').length
      let reportsCount = 0
      const reportsDir = join(teamDir, 'reports')
      if (existsSync(reportsDir)) {
        for (const name of readdirSync(reportsDir)) {
          if (!name.endsWith('.json')) continue
          reportsCount += readJsonl<TeamReport>(join(reportsDir, name)).length
        }
      }
      const inboxDir = join(teamDir, 'inbox')
      const inboxFiles = existsSync(inboxDir) ? readdirSync(inboxDir).filter(n => n.endsWith('.jsonl')) : []
      let inboxMessages = 0
      for (const name of inboxFiles) {
        inboxMessages += readJsonl<TeamMessage>(join(inboxDir, name)).length
      }

      // 1. Archive record. The ISO timestamp's ':' is flattened for Windows
      //    (illegal in file names); the full ts stays intact inside the record.
      const archiveFile = join(teamDir, 'archive', `${ts.replace(/:/g, '-')}-wrap.json`)
      await withFileLock(archiveFile, () => {
        writeFileSync(archiveFile, JSON.stringify({
          ts,
          summary,
          messagesTotal: sentCount,
          inboxMessages,
          openTasks,
          reports: reportsCount,
        }, null, 2) + '\n')
      })

      // 2. WRAP marker — its mere presence flips the team_status wrapHint off.
      const wrapFile = join(teamDir, 'WRAP')
      await withFileLock(wrapFile, () => {
        writeFileSync(wrapFile, `TEAM WRAP ${ts}\n\n${summary}\n`)
      })

      // 3. Truncate inboxes only after their line counts are archived above, so
      //    wrap never silently discards the volume of what was exchanged.
      for (const name of inboxFiles) {
        const inboxFile = join(inboxDir, name)
        await withFileLock(inboxFile, () => { writeFileSync(inboxFile, '') })
      }

      // 4. Notify AFTER truncation so the wrap message itself is delivered,
      //    not wiped. Best-effort per peer: a dead peer must not fail the wrap.
      let wrappedPeers = 0
      for (const id of peerIds(agent)) {
        try {
          await notifyPeer(agent, id, `TEAM_WRAP: ${summary} — archive tasks and go idle`)
          wrappedPeers++
        } catch { /* best-effort */ }
      }

      return { ok: true, archivedMessages: sentCount + inboxMessages, wrappedPeers }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Wrap up the team', kind: 'other' as const }),
  }))

  // ── team_memory (shared durable memory) ────────────────────────────────────
  // The cross-session stand-in for a single conversation's shared transcript:
  // decisions and facts persist so peers never re-derive or re-transmit context.

  ctx.tools.register(defineTool({
    name: 'team_memory',
    description:
      'Shared durable key-value memory (.team/memory.jsonl) visible to every team session. '
      + 'Actions: set (store a fact/decision under a key), get (read the latest value), list (all entries), delete. '
      + 'search (query: free text; ranked recall over ALL entries — use this when you know the topic but not the exact key). '
      + 'Use it to persist decisions and facts so peers do not re-derive or re-transmit context.',
    parameters: {
      action: { type: 'string', required: true, enum: ['set', 'get', 'list', 'delete', 'search'], description: 'Which memory operation to run.' },
      key: { type: 'string', description: 'Memory key (set/get/delete).' },
      value: { type: 'string', description: 'Value to store (set).' },
      query: { type: 'string', description: 'Free-text search query (search).' },
      limit: { type: 'number', description: 'Max search hits to return (search; default 8).' },
      version: { type: 'integer', description: 'F4: Expected version number for compare-and-swap (cas). Used with cas=true.' },
      cas: { type: 'boolean', description: 'F4: Enable compare-and-swap. When true, the write only succeeds if the current version matches the `version` parameter.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as { ok: boolean; key?: string; value?: string; entries?: TeamMemoryEntry[]; query?: string }
        if (v.entries !== undefined && v.query !== undefined) {
          const hits = v.entries
          return [{
            type: 'text' as const,
            text: hits.length === 0
              ? `No memory entries matched "${v.query}".`
              : hits.map(e => `  • ${e.key} = ${e.value.slice(0, 160)}`).join('\n'),
          }]
        }
        if (v.entries !== undefined) {
          return [{ type: 'text' as const, text: v.entries.length === 0 ? 'No memory entries.' : v.entries.map(e => `  • ${e.key} = ${e.value.slice(0, 160)}`).join('\n') }]
        }
        return [{ type: 'text' as const, text: v.ok ? `${v.key ?? ''} ${v.value !== undefined ? `= ${v.value.slice(0, 160)}` : 'done'}` : `${v.key ?? ''} not found` }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_memory: no agent context')
      const file = teamPath(agent, 'memory.jsonl')
      const now = () => new Date().toISOString()

      switch (args.action) {
        case 'set': {
          const key = (args.key ?? '').trim()
          const value = args.value ?? ''
          if (key.length === 0) throw new Error('team_memory set: key is required')
          if (Buffer.byteLength(value, 'utf-8') > MAX_MESSAGE_BYTES) {
            throw new Error(`team_memory set: value too large (${Buffer.byteLength(value, 'utf-8')} bytes, max ${MAX_MESSAGE_BYTES})`)
          }
          // F4: MVCC compare-and-swap. When cas=true, the write only succeeds if
          // the current version matches the expected `version` parameter. This
          // prevents lost updates when two sessions concurrently write the same key.
          const cas = args.cas === true
          if (cas) {
            return lockedUpdate<TeamMemoryEntry>(file, (entries) => {
              const existing = entries.findLast(e => e.key === key)
              const currentVersion = existing?.version ?? 0
              const expectedVersion = typeof args.version === 'number' ? args.version : 0
              if (currentVersion !== expectedVersion) {
                // Version conflict — throw a typed error so the caller can catch it.
                // We use a special property to signal the conflict without throwing
                // (since lockedUpdate would propagate the throw). Instead, we append
                // a conflict marker and let the caller detect it.
                // Actually, we need to return the conflict info. Since lockedUpdate
                // returns the mutated array, we'll append a special entry that the
                // caller can detect. But that's messy. Better approach: do the CAS
                // check outside lockedUpdate using a read, then write under lock.
                // For simplicity, we throw a typed error and catch it outside.
                throw new Error(`__MVCC_CONFLICT__:${currentVersion}:${existing?.value ?? ''}`)
              }
              const newVersion = currentVersion + 1
              entries.push({ key, value, updatedBy: agent.session.id, ts: now(), version: newVersion })
              return entries
            }).then(
              () => ({ ok: true, key, value }),
              (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                const match = /^__MVCC_CONFLICT__:(\d+):([\s\S]*)$/.exec(msg)
                if (match) {
                  return {
                    ok: false,
                    error: 'version_conflict',
                    key,
                    current_version: parseInt(match[1]!, 10),
                    current_value: match[2] ?? '',
                  }
                }
                throw err
              },
            )
          }
          // Non-CAS write: read current version, increment, and append.
          return lockedAppend(file, { key, value, updatedBy: agent.session.id, ts: now() })
            .then(() => ({ ok: true, key, value }))
        }
        case 'get': {
          const key = (args.key ?? '').trim()
          const entry = readJsonl<TeamMemoryEntry>(file).findLast(e => e.key === key)
          return Promise.resolve(entry !== undefined
            ? { ok: true, key, value: entry.value, updatedBy: entry.updatedBy, ts: entry.ts, version: entry.version ?? 0 }
            : { ok: false, key })
        }
        case 'list': {
          // Append-only storage: collapse to the latest entry per key.
          const latest = new Map<string, TeamMemoryEntry>()
          for (const e of readJsonl<TeamMemoryEntry>(file)) latest.set(e.key, e)
          return Promise.resolve({ ok: true, entries: [...latest.values()] })
        }
        case 'delete': {
          const key = (args.key ?? '').trim()
          if (key.length === 0) throw new Error('team_memory delete: key is required')
          return lockedUpdate<TeamMemoryEntry>(file, entries => entries.filter(e => e.key !== key))
            .then(() => ({ ok: true, key }))
        }
        case 'search': {
          const query = (args.query ?? '').trim()
          if (query.length === 0) throw new Error('team_memory search: query is required')
          const latest = new Map<string, TeamMemoryEntry>()
          for (const e of readJsonl<TeamMemoryEntry>(file)) latest.set(e.key, e)
          const clamped = typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.trunc(args.limit), 1), 50)
            : 8
          const hits = rankMemoryEntries(query, [...latest.values()]).slice(0, clamped)
          return Promise.resolve({ ok: true, query, entries: hits })
        }
        default:
          throw new Error(`team_memory: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Team memory: ${args.action}`, kind: 'other' as const }),
  }))

  // ── team_review (independent multi-party verification) ─────────────────────
  // Evaluator/critic pattern: a second session independently checks a result
  // before it is reported. This is the "many eyes" check a single conversation
  // cannot give itself.

  ctx.tools.register(defineTool({
    name: 'team_review',
    description:
      'Request an independent review/verification from another team session (evaluator pattern). '
      + 'Sends the subject and content to a peer and records the request so the verdict can be collected. '
      + 'Use this so a second pair of eyes validates results before you report them — a check a single conversation cannot perform.',
    parameters: {
      target: { type: 'string', required: true, description: 'Reviewer session id (a peer).' },
      subject: { type: 'string', required: true, description: 'Short label for what is being reviewed.' },
      content: { type: 'string', required: true, description: 'The work product to verify (code, result, claim).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reviewId: { type: 'string', required: true },
          msgId: { type: 'string', required: true },
          target: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { reviewId: string; target: string }
        return [{ type: 'text' as const, text: `Review ${v.reviewId.slice(0, 8)}… requested from ${v.target.slice(0, 8)}…` }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_review: no agent context')
      const target = assertSafeTeamId(args.target, 'team_review target')
      const reviewId = randomUUID()
      const subject = args.subject
      const content = args.content
      const contentBytes = Buffer.byteLength(subject) + Buffer.byteLength(content)
      if (contentBytes > MAX_MESSAGE_BYTES - 512) {
        throw new Error(`team_review: content too large (${contentBytes} bytes, max ${MAX_MESSAGE_BYTES}). Split the review into smaller parts.`)
      }
      const msgId = randomUUID()
      await deliverMessage(
        agent,
        target,
        `REVIEW REQUEST (reviewId: ${reviewId}) from ${agent.session.id} — subject: ${subject}\n\nCONTENT TO VERIFY:\n${content}\n\nVerify independently: re-read the actual files/claims, do not assume correctness. Reply with team_send(target: "${agent.session.id}", reply_to: "${msgId}", message: "VERDICT: <pass|fail|needs-changes>\nFINDINGS:\n- ...").`,
        undefined,
        msgId,
      )
      triggerSession(target, agent.session.id, msgId, `review "${subject}"`)
      const record: TeamReview = {
        reviewId,
        from: agent.session.id,
        target,
        subject,
        content,
        msgId,
        ts: new Date().toISOString(),
      }
      await lockedAppend(teamPath(agent, 'reviews.jsonl'), record)
      return { reviewId, msgId, target }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Request review: ${args.subject}`, kind: 'other' as const }),
  }))

  // ── team_review_collect (collect verdicts — closes the review loop) ─────────

  ctx.tools.register(defineTool({
    name: 'team_review_collect',
    description:
      'Collect verdicts for review requests you sent with team_review. '
      + 'Given an optional reviewId (or all of your outstanding reviews), reads the reviewer replies from your inbox '
      + '(matched by reply_to) and reports pass/fail/needs-changes verdicts plus which reviews are still pending.',
    parameters: {
      reviewId: { type: 'string', description: 'Optional review id to collect. Omit to collect all of your outstanding reviews.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as {
          total: number
          verdicts: { reviewId: string; subject: string; target: string; verdict: string; message: string; ts: string }[]
          pending: { reviewId: string; subject: string; target: string }[]
        }
        const lines = [`${v.verdicts.length} of ${v.total} review(s) returned a verdict.`]
        for (const x of v.verdicts) {
          lines.push(`  • ${x.subject}: ${x.verdict} (from ${x.target.slice(0, 8)}…)`)
        }
        for (const p of v.pending) {
          lines.push(`  • PENDING: ${p.subject} (awaiting ${p.target.slice(0, 8)}…)`)
        }
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_review_collect: no agent context')
      const reviews = readJsonl<TeamReview>(teamPath(agent, 'reviews.jsonl'))
        .filter(r => r.from === agent.session.id && (args.reviewId === undefined || r.reviewId === args.reviewId))
      const inboxDir = join(teamCwd(agent), TEAM_DIR, 'inbox')
      const selfInbox = readJsonl<TeamMessage>(join(inboxDir, `${agent.session.id}.jsonl`))
      const verdicts: { reviewId: string; subject: string; target: string; verdict: string; message: string; ts: string }[] = []
      const pending: { reviewId: string; subject: string; target: string }[] = []
      for (const r of reviews) {
        const reply = selfInbox.findLast(m => m.replyTo === r.msgId && m.from === r.target)
        if (reply !== undefined) {
          const verdict = /VERDICT:\s*([^\n]+)/.exec(reply.message)?.[1]?.trim() ?? 'unknown'
          verdicts.push({ reviewId: r.reviewId, subject: r.subject, target: r.target, verdict, message: reply.message, ts: reply.ts })
        } else {
          pending.push({ reviewId: r.reviewId, subject: r.subject, target: r.target })
        }
      }
      // F7: Validate structured evidence in reports. For each review that has a
      // corresponding report file, check if evidence entries have any failing
      // status and surface that as part of the verdict collection.
      const reportsDir = join(teamCwd(agent), TEAM_DIR, 'reports')
      const evidenceIssues: string[] = []
      if (existsSync(reportsDir)) {
        for (const r of reviews) {
          const reportFile = join(reportsDir, `${r.subject}.json`)
          if (!existsSync(reportFile)) continue
          try {
            const raw = readFileSync(reportFile, 'utf-8').trim().split('\n')
            for (const line of raw) {
              try {
                const report = JSON.parse(line) as TeamReport
                if (!Array.isArray(report.evidence)) continue
                for (const ev of report.evidence) {
                  // Only validate structured evidence (objects), not plain strings.
                  if (typeof ev === 'object' && ev !== null && 'status' in ev) {
                    const status = (ev as StructuredEvidence).status
                    if (status === 'fail') {
                      evidenceIssues.push(`Report ${report.reportId.slice(0, 8)}… has failing evidence: ${(ev as StructuredEvidence).type} — ${(ev as StructuredEvidence).command ?? 'no command'}`)
                    }
                  }
                }
              } catch { /* skip malformed */ }
            }
          } catch { /* best-effort */ }
        }
      }
      return Promise.resolve({ total: reviews.length, verdicts, pending, ...evidenceIssues.length > 0 ? { evidenceIssues } : {} })
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Collect review verdicts', kind: 'read' as const }),
  }))

  // ── team_status (one-shot team health snapshot) ─────────────────────────────

  ctx.tools.register(defineTool({
    name: 'team_status',
    description:
      'One-shot team health snapshot: which peers are live (and how recently they were seen), how many unread messages you have, '
      + 'how many broadcasts/reviews are still awaiting replies, and a task-board rollup by status. '
      + 'Use it instead of team_list + team_inbox + team_task(list) separately when you only need the shape of the team.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as {
          self: string
          peers: { id: string; seenMsAgo: number }[]
          unread: number
          pendingBroadcasts: number
          pendingReviews: number
          tasks: Record<string, number>
          wrapHint?: string
        }
        const lines = [
          `Team status (self ${v.self.slice(0, 8)}…):`,
          v.peers.length === 0
            ? '  peers: none live'
            : `  peers: ${v.peers.map(p => `${p.id.slice(0, 8)}…(${Math.round(p.seenMsAgo / 1000)}s ago)`).join(', ')}`,
          `  unread inbox: ${v.unread}`,
          `  pending broadcasts: ${v.pendingBroadcasts}`,
          `  pending reviews: ${v.pendingReviews}`,
          `  tasks: ${Object.entries(v.tasks).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`,
        ]
        if (v.wrapHint !== undefined) lines.push(`  ⚑ ${v.wrapHint}`)
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_status: no agent context')
      const cwd = teamCwd(agent)
      try { writePresence(agent) } catch { /* best-effort */ }
      const now = Date.now()
      const peers = readAllPresence(agent)
        .filter(p => p.id !== agent.session.id)
        .map(p => ({ id: p.id, seenMsAgo: now - new Date(p.ts).getTime() }))
      const inboxDir = join(cwd, TEAM_DIR, 'inbox')
      const selfInbox = readJsonl<TeamMessage>(join(inboxDir, `${agent.session.id}.jsonl`))
      const unread = selfInbox.filter(m => !m.read && !m.deleted).length

      const broadcasts = readJsonl<TeamBroadcast>(teamPath(agent, 'outbox.jsonl')).filter(b => b.from === agent.session.id)
      let pendingBroadcasts = 0
      for (const b of broadcasts) {
        for (const t of b.targets) {
          if (selfInbox.findLast(m => m.replyTo === t.msgId && m.from === t.id) === undefined) {
            pendingBroadcasts++
            break
          }
        }
      }

      const reviews = readJsonl<TeamReview>(teamPath(agent, 'reviews.jsonl')).filter(r => r.from === agent.session.id)
      let pendingReviews = 0
      for (const r of reviews) {
        if (selfInbox.findLast(m => m.replyTo === r.msgId && m.from === r.target) === undefined) pendingReviews++
      }

      const rollup: Record<string, number> = {}
      const allTasks = readJsonl<TeamTask>(teamPath(agent, 'tasks.jsonl'))
      for (const t of allTasks) {
        rollup[t.status] = (rollup[t.status] ?? 0) + 1
      }

      // Explicit termination hint: with every task terminal and no WRAP marker
      // yet, the coordinator should close the mission instead of letting peers
      // idle indefinitely. An empty board never hints — nothing was ever run.
      let wrapHint: string | undefined
      if (allTasks.length > 0
        && allTasks.every(t => t.status === 'done' || t.status === 'blocked')
        && !existsSync(teamPath(agent, 'WRAP'))) {
        wrapHint = 'All tasks terminal — call team_wrap to archive and release peers.'
      }

      return Promise.resolve({
        self: agent.session.id, peers, unread, pendingBroadcasts, pendingReviews, tasks: rollup,
        ...wrapHint !== undefined ? { wrapHint } : {},
      })
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Team status snapshot', kind: 'read' as const }),
  }))

  // ── team_barrier (named fan-in synchronization) ─────────────────────────────

  ctx.tools.register(defineTool({
    name: 'team_barrier',
    description:
      'Named fan-in barrier so a coordinator can wait until a minimum number of distinct peers have arrived before proceeding. '
      + 'Each peer calls team_barrier(action:"arrive", name, expect) and the coordinator calls team_barrier(action:"wait", name, expect) '
      + 'to check whether the barrier is met. Use it to synchronize phases (e.g. all research done before a merge step).',
    parameters: {
      action: { type: 'string', required: true, enum: ['arrive', 'wait', 'reset'], description: 'arrive (register self + bump count), wait (check if threshold reached), reset (clear).' },
      name: { type: 'string', required: true, description: 'Barrier name (letters/digits/_-).' },
      expect: { type: 'integer', description: 'Minimum number of distinct arrivals to satisfy the barrier (arrive/wait).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as { name: string; arrived: number; expect: number; reached: boolean; arrivedIds: string[] }
        return [{ type: 'text' as const, text: `Barrier "${v.name}": ${v.arrived}/${v.expect} arrived${v.reached ? ' — REACHED' : ''}${v.arrivedIds.length ? ` (${v.arrivedIds.map(i => i.slice(0, 8)).join(', ')})` : ''}` }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_barrier: no agent context')
      const name = assertSafeTeamId(args.name, 'team_barrier name')
      if (name.length === 0) throw new Error('team_barrier: name is required')
      if (name.length > 200) throw new Error(`team_barrier: name too long (${name.length} chars, max 200)`)
      if (!['arrive', 'wait', 'reset'].includes(args.action)) {
        throw new Error(`team_barrier: invalid action "${args.action}"`)
      }
      mkdirSync(join(teamCwd(agent), TEAM_DIR), { recursive: true })
      const file = teamPath(agent, `barrier-${name}.json`)
      const expect = typeof args.expect === 'number' && args.expect > 0 ? Math.floor(args.expect) : 1

      if (args.action === 'reset') {
        return withFileLock(file, () => {
          try { rmSync(file, { force: true }) } catch { /* best-effort */ }
          return { name, arrived: 0, expect, reached: false, arrivedIds: [] }
        })
      }

      return withFileLock(file, () => {
        let barrier: TeamBarrier = { name, expect, arrived: [], ts: new Date().toISOString() }
        if (existsSync(file)) {
          try { barrier = JSON.parse(readFileSync(file, 'utf-8')) as TeamBarrier } catch { /* corrupted — reset */ }
          // `arrive` only bumps the arrival count; it must not overwrite the
          // threshold the coordinator established. A peer arriving with the
          // default expect=1 would otherwise collapse an N-peer barrier to 1.
          if (args.action !== 'arrive') barrier.expect = expect
        }
        barrier.name = name
        if (args.action === 'arrive' && !barrier.arrived.includes(agent.session.id)) {
          barrier.arrived.push(agent.session.id)
        }
        barrier.ts = new Date().toISOString()
        writeFileSync(file, JSON.stringify(barrier))
        const reached = barrier.arrived.length >= barrier.expect
        return { name, arrived: barrier.arrived.length, expect: barrier.expect, reached, arrivedIds: barrier.arrived }
      })
    },
    presentCall: args => ({ card: 'generic' as const, title: `Barrier ${args.action}: ${args.name}`, kind: 'other' as const }),
  }))

  // ── team_workflow (F3: DAG execution engine) ────────────────────────────────
  // Declarative DAG workflow: a coordinator defines nodes (tasks) with
  // dependencies, and the engine auto-schedules ready nodes (deps satisfied)
  // as team_tasks. When a node completes, the next dependent nodes become ready.

  /** F3: One node in a workflow DAG. */
  interface WorkflowNode {
    id: string
    task_description: string
    deps: string[]
    parallel?: boolean
  }

  /** F3: One edge in a workflow DAG (optional, for conditional transitions). */
  interface WorkflowEdge {
    from: string
    to: string
    condition?: string
  }

  /** F3: The persistent state of a workflow. */
  interface WorkflowState {
    name: string
    nodes: WorkflowNode[]
    edges?: WorkflowEdge[]
    /** Per-node status: pending (deps not met), running (task created), completed, failed, cancelled. */
    nodeStatus: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>
    /** Maps workflow node id to the created team_task id. */
    taskIds: Record<string, string>
    createdBy: string
    ts: string
    updatedTs: string
  }

  /** F3: Read a workflow state file. */
  function readWorkflow(agent: { session: { header?: { cwd?: string } } }, name: string): WorkflowState | undefined {
    const file = join(teamCwd(agent), TEAM_DIR, 'workflows', `${name}.json`)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as WorkflowState
    } catch {
      return undefined
    }
  }

  /** F3: Write a workflow state file atomically. */
  function writeWorkflow(agent: { session: { header?: { cwd?: string } } }, state: WorkflowState): void {
    const dir = join(teamCwd(agent), TEAM_DIR, 'workflows')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${state.name}.json`)
    writeFileSync(file, JSON.stringify(state, null, 2))
  }

  /** F3: Check if all deps of a node are completed. */
  function isNodeReady(node: WorkflowNode, state: WorkflowState): boolean {
    return node.deps.every(depId => state.nodeStatus[depId] === 'completed')
  }

  /** F3: Auto-schedule ready nodes by creating team_tasks for them. */
  async function scheduleReadyNodes(agent: { session: { id: string; header?: { cwd?: string } } }, state: WorkflowState): Promise<WorkflowState> {
    const taskFile = teamPath(agent, 'tasks.jsonl')
    const now = () => new Date().toISOString()
    let changed = false
    for (const node of state.nodes) {
      if (state.nodeStatus[node.id] === 'pending' && isNodeReady(node, state)) {
        // Create a team_task for this ready node.
        const task: TeamTask = {
          id: randomUUID(),
          title: `[workflow:${state.name}] ${node.id}: ${node.task_description.slice(0, 100)}`,
          description: node.task_description,
          status: 'todo',
          createdBy: agent.session.id,
          ts: now(),
          updatedTs: now(),
        }
        await lockedAppend(taskFile, task)
        state.nodeStatus[node.id] = 'running'
        state.taskIds[node.id] = task.id
        changed = true
      }
    }
    if (changed) {
      state.updatedTs = now()
      writeWorkflow(agent, state)
    }
    return state
  }

  /** F3: Check completed tasks and update workflow node statuses. */
  async function syncWorkflowTasks(agent: { session: { id: string; header?: { cwd?: string } } }, state: WorkflowState): Promise<WorkflowState> {
    const tasks = readJsonl<TeamTask>(teamPath(agent, 'tasks.jsonl'))
    const now = () => new Date().toISOString()
    let changed = false
    for (const node of state.nodes) {
      if (state.nodeStatus[node.id] === 'running') {
        const taskId = state.taskIds[node.id]
        if (taskId !== undefined) {
          const task = tasks.findLast(t => t.id === taskId)
          if (task !== undefined) {
            if (task.status === 'done') {
              state.nodeStatus[node.id] = 'completed'
              changed = true
            } else if (task.status === 'blocked') {
              state.nodeStatus[node.id] = 'failed'
              changed = true
            }
          }
        }
      }
    }
    if (changed) {
      // After updating statuses, try to schedule newly-ready nodes.
      state = await scheduleReadyNodes(agent, state)
      state.updatedTs = now()
      writeWorkflow(agent, state)
    }
    return state
  }

  ctx.tools.register(defineTool({
    name: 'team_workflow',
    description:
      'F3: Declarative DAG workflow engine. Define nodes (tasks) with dependencies; the engine auto-schedules ready nodes (deps satisfied) as team_tasks. '
      + 'When a node completes, dependent nodes become ready automatically. Supports parallel execution of independent nodes. '
      + 'Actions: create (define + schedule), status (check node states), cancel (abort unfinished nodes). '
      + 'Workflow state is persisted in .team/workflows/<name>.json.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'status', 'cancel'], description: 'Which workflow operation to run.' },
      name: { type: 'string', required: true, description: 'Workflow name (used as the state file name).' },
      dag: {
        type: 'object',
        additionalProperties: true,
        description: 'The DAG definition (create only). { nodes: [{ id, task_description, deps: string[], parallel?: boolean }], edges?: [{ from, to, condition? }] }',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as { ok: boolean; name?: string; nodeStatus?: Record<string, string>; error?: string }
        if (!v.ok) return [{ type: 'text' as const, text: `team_workflow failed: ${v.error ?? 'unknown error'}` }]
        if (v.nodeStatus !== undefined) {
          const lines = [`Workflow "${v.name ?? ''}" status:`]
          for (const [nodeId, status] of Object.entries(v.nodeStatus)) {
            const icon = status === 'completed' ? '✓' : status === 'running' ? '▶' : status === 'failed' ? '✗' : status === 'cancelled' ? '⊘' : '○'
            lines.push(`  ${icon} ${nodeId}: ${status}`)
          }
          return [{ type: 'text' as const, text: lines.join('\n') }]
        }
        return [{ type: 'text' as const, text: `Workflow "${v.name ?? ''}" operation completed.` }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_workflow: no agent context')
      const name = assertSafeTeamId(args.name, 'team_workflow name')
      if (name.length === 0) throw new Error('team_workflow: name is required')
      const now = () => new Date().toISOString()

      switch (args.action) {
        case 'create': {
          const dag = args.dag as { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] } | undefined
          if (dag === undefined || !Array.isArray(dag.nodes) || dag.nodes.length === 0) {
            throw new Error('team_workflow create: dag.nodes must be a non-empty array')
          }
          // Validate node ids are unique and deps reference existing nodes.
          const nodeIds = new Set(dag.nodes.map(n => n.id))
          for (const node of dag.nodes) {
            if (typeof node.id !== 'string' || node.id.length === 0) {
              throw new Error(`team_workflow create: node id must be a non-empty string`)
            }
            if (typeof node.task_description !== 'string') {
              throw new Error(`team_workflow create: node "${node.id}" must have a task_description`)
            }
            for (const dep of node.deps ?? []) {
              if (!nodeIds.has(dep)) {
                throw new Error(`team_workflow create: node "${node.id}" depends on unknown node "${dep}"`)
              }
            }
          }
          const nodeStatus: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'> = {}
          for (const node of dag.nodes) {
            nodeStatus[node.id] = 'pending'
          }
          const state: WorkflowState = {
            name,
            nodes: dag.nodes.map(n => ({
              id: n.id,
              task_description: n.task_description,
              deps: n.deps ?? [],
              ...n.parallel !== undefined ? { parallel: n.parallel } : {},
            })),
            ...Array.isArray(dag.edges) ? { edges: dag.edges } : {},
            nodeStatus,
            taskIds: {},
            createdBy: agent.session.id,
            ts: now(),
            updatedTs: now(),
          }
          writeWorkflow(agent, state)
          // Auto-schedule initially-ready nodes (those with no deps).
          const updatedState = await scheduleReadyNodes(agent, state)
          return { ok: true, name, nodeStatus: updatedState.nodeStatus, taskIds: updatedState.taskIds }
        }
        case 'status': {
          let state = readWorkflow(agent, name)
          if (state === undefined) {
            return { ok: false, error: `workflow "${name}" not found` }
          }
          // Sync with task board to pick up completions, then re-schedule.
          state = await syncWorkflowTasks(agent, state)
          return { ok: true, name, nodeStatus: state.nodeStatus, taskIds: state.taskIds }
        }
        case 'cancel': {
          let state = readWorkflow(agent, name)
          if (state === undefined) {
            return { ok: false, error: `workflow "${name}" not found` }
          }
          // Cancel all non-terminal nodes and mark associated tasks as blocked
          // atomically under the task file lock.
          const cancelledNodeIds: string[] = []
          for (const node of state.nodes) {
            if (state.nodeStatus[node.id] === 'pending' || state.nodeStatus[node.id] === 'running') {
              state.nodeStatus[node.id] = 'cancelled'
              cancelledNodeIds.push(node.id)
            }
          }
          if (cancelledNodeIds.length > 0) {
            await lockedUpdate<TeamTask>(teamPath(agent, 'tasks.jsonl'), (currentTasks) => {
              for (const nodeId of cancelledNodeIds) {
                const taskId = state!.taskIds[nodeId]
                if (taskId !== undefined) {
                  const task = currentTasks.find(t => t.id === taskId)
                  if (task !== undefined && task.status !== 'done') {
                    task.status = 'blocked'
                    task.updatedTs = now()
                  }
                }
              }
              return currentTasks
            })
          }
          state.updatedTs = now()
          writeWorkflow(agent, state)
          return { ok: true, name, nodeStatus: state.nodeStatus }
        }
        default:
          throw new Error(`team_workflow: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Workflow ${args.action}: ${args.name}`, kind: 'other' as const }),
  }))

  // ── team_audit (F9: collaboration replay & audit) ───────────────────────────
  // Merges all .team/*.jsonl event logs into a unified timeline for replay,
  // audit, and statistics. Supports filtering by time range, session, and
  // action type.

  /** F9: One unified event from the merged team logs. */
  interface AuditEvent {
    ts: string
    source: string
    action: string
    session?: string
    payload: unknown
  }

  /** F9: Read all .team/*.jsonl files and merge into a unified event stream. */
  function readAllAuditEvents(agent: { session: { id: string; header?: { cwd?: string } } }): AuditEvent[] {
    const teamDir = join(teamCwd(agent), TEAM_DIR)
    const events: AuditEvent[] = []
    if (!existsSync(teamDir)) return events

    // Known JSONL event sources and their action/session extractors.
    const sources: Array<{ file: string; action: string; extractSession: (r: unknown) => string | undefined }> = [
      { file: 'sent.jsonl', action: 'send', extractSession: (r) => (r as { from?: string })?.from },
      { file: 'tasks.jsonl', action: 'task', extractSession: (r) => (r as { createdBy?: string })?.createdBy },
      { file: 'memory.jsonl', action: 'memory', extractSession: (r) => (r as { updatedBy?: string })?.updatedBy },
      { file: 'outbox.jsonl', action: 'broadcast', extractSession: (r) => (r as { from?: string })?.from },
      { file: 'reviews.jsonl', action: 'review', extractSession: (r) => (r as { from?: string })?.from },
    ]

    for (const src of sources) {
      const filePath = join(teamDir, src.file)
      const records = readJsonl<unknown>(filePath)
      for (const r of records) {
        const ts = (r as { ts?: string })?.ts
        if (typeof ts !== 'string') continue
        const session = src.extractSession(r)
        const event: AuditEvent = { ts, source: src.file, action: src.action, payload: r }
        if (session !== undefined) event.session = session
        events.push(event)
      }
    }

    // Also scan inbox/*.jsonl for message events.
    const inboxDir = join(teamDir, 'inbox')
    if (existsSync(inboxDir)) {
      for (const file of readdirSync(inboxDir)) {
        if (!file.endsWith('.jsonl')) continue
        const records = readJsonl<unknown>(join(inboxDir, file))
        for (const r of records) {
          const ts = (r as { ts?: string })?.ts
          if (typeof ts !== 'string') continue
          const session = (r as { from?: string })?.from
          const event: AuditEvent = { ts, source: `inbox/${file}`, action: 'message', payload: r }
          if (session !== undefined) event.session = session
          events.push(event)
        }
      }
    }

    // think.log is a JSONL file (despite the .log extension).
    const thinkFile = join(teamDir, 'think.log')
    if (existsSync(thinkFile)) {
      const records = readJsonl<unknown>(thinkFile)
      for (const r of records) {
        const ts = (r as { ts?: string })?.ts
        if (typeof ts !== 'string') continue
        const session = (r as { session?: string })?.session
        const event: AuditEvent = { ts, source: 'think.log', action: 'think', payload: r }
        if (session !== undefined) event.session = session
        events.push(event)
      }
    }

    // Sort by timestamp ascending (oldest first).
    events.sort((a, b) => a.ts.localeCompare(b.ts))
    return events
  }

  ctx.tools.register(defineTool({
    name: 'team_audit',
    description:
      'F9: Collaboration replay and audit. Merges all .team/*.jsonl event logs into a unified timeline. '
      + 'Actions: timeline (sorted event list), replay (timeline with full payloads), stats (summary counts). '
      + 'Supports filtering by time range (since/until ISO timestamps), session id, and action type (send/task/memory/think/broadcast/review/message).',
    parameters: {
      action: { type: 'string', required: true, enum: ['timeline', 'replay', 'stats'], description: 'Which audit operation to run.' },
      since: { type: 'string', description: 'ISO-8601 timestamp; only events at or after this time (default: 24 hours ago).' },
      until: { type: 'string', description: 'ISO-8601 timestamp; only events at or before this time (default: now).' },
      session: { type: 'string', description: 'Filter to events from this session id.' },
      action_type: { type: 'string', description: 'Filter to events of this action type (send/task/memory/think/broadcast/review/message).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as { ok: boolean; events?: AuditEvent[]; stats?: Record<string, unknown>; error?: string }
        if (!v.ok) return [{ type: 'text' as const, text: `team_audit failed: ${v.error ?? 'unknown error'}` }]
        if (v.stats !== undefined) {
          const s = v.stats as { total: number; byAction: Record<string, number>; bySession: Record<string, number>; errorCount: number }
          const lines = [
            `Audit stats (${s.total} total events):`,
            `  By action: ${Object.entries(s.byAction).map(([k, n]) => `${k}=${n}`).join(', ') || 'none'}`,
            `  By session: ${Object.entries(s.bySession).map(([k, n]) => `${k.slice(0, 8)}…=${n}`).join(', ') || 'none'}`,
            `  Errors: ${s.errorCount}`,
          ]
          return [{ type: 'text' as const, text: lines.join('\n') }]
        }
        if (v.events !== undefined) {
          if (v.events.length === 0) return [{ type: 'text' as const, text: 'No events match the filter.' }]
          const lines = v.events.slice(0, 50).map(e => {
            const sess = e.session ? ` ${e.session.slice(0, 8)}…` : ''
            return `[${e.ts}] ${e.action}${sess} (${e.source})`
          })
          const trunc = v.events.length > 50 ? `\n… and ${v.events.length - 50} more.` : ''
          return [{ type: 'text' as const, text: `${v.events.length} event(s):\n${lines.join('\n')}${trunc}` }]
        }
        return [{ type: 'text' as const, text: 'Audit complete.' }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_audit: no agent context')

      // Ensure presence so this session is discoverable.
      try { writePresence(agent) } catch { /* best-effort */ }

      const allEvents = readAllAuditEvents(agent)

      // Apply time range filter (default: last 24 hours).
      const now = Date.now()
      const sinceMs = args.since !== undefined ? new Date(args.since).getTime() : now - 24 * 60 * 60 * 1000
      const untilMs = args.until !== undefined ? new Date(args.until).getTime() : now
      let filtered = allEvents.filter(e => {
        const t = new Date(e.ts).getTime()
        return t >= sinceMs && t <= untilMs
      })

      // Apply session filter.
      if (args.session !== undefined) {
        filtered = filtered.filter(e => e.session === args.session)
      }

      // Apply action_type filter.
      if (args.action_type !== undefined) {
        filtered = filtered.filter(e => e.action === args.action_type)
      }

      switch (args.action) {
        case 'timeline': {
          // Return events without full payloads (lightweight summary).
          const events = filtered.map(e => ({
            ts: e.ts,
            source: e.source,
            action: e.action,
            ...e.session !== undefined ? { session: e.session } : {},
          }))
          return Promise.resolve({ ok: true, count: events.length, events })
        }
        case 'replay': {
          // Return events WITH full payloads.
          return Promise.resolve({ ok: true, count: filtered.length, events: filtered })
        }
        case 'stats': {
          const byAction: Record<string, number> = {}
          const bySession: Record<string, number> = {}
          let errorCount = 0
          for (const e of filtered) {
            byAction[e.action] = (byAction[e.action] ?? 0) + 1
            if (e.session !== undefined) {
              bySession[e.session] = (bySession[e.session] ?? 0) + 1
            }
            // Count errors: tasks with 'blocked' status, messages with error fields, etc.
            const payload = e.payload as { status?: string; ok?: boolean; error?: string }
            if (payload?.status === 'blocked' || (payload?.ok === false && payload?.error !== undefined)) {
              errorCount++
            }
          }
          return Promise.resolve({
            ok: true,
            stats: {
              total: filtered.length,
              byAction,
              bySession,
              errorCount,
            },
          })
        }
        default:
          throw new Error(`team_audit: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Audit ${args.action}`, kind: 'read' as const }),
  }))

  const _defineToolAny = defineTool as any

  // -- team_elect (F1: leader election with lease-based failover) --
  // Deterministic leader election: smallest session id among live peers wins.
  // Each role has an election file .team/election/<role>.json with a lease.
  // A crashed leader's lease expires (default 5 min) and a peer takes over.

  /** F1: Election lease duration in ms (default 5 minutes). */
  const ELECTION_LEASE_MS = 5 * 60_000

  /** F1: One election record for a role. */
  interface ElectionRecord {
    role: string
    leader: string
    leaseExpires: string
    electedAt: string
    voters: string[]
  }

  /** F1: Read an election record for a role. */
  function readElection(agent: { session: { header?: { cwd?: string } } }, role: string): ElectionRecord | undefined {
    const file = join(teamCwd(agent), TEAM_DIR, 'election', `${role}.json`)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as ElectionRecord
    } catch {
      return undefined
    }
  }

  /** F1: Write an election record atomically. */
  function writeElection(agent: { session: { header?: { cwd?: string } } }, record: ElectionRecord): void {
    const dir = join(teamCwd(agent), TEAM_DIR, 'election')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${record.role}.json`)
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(record, null, 2))
    renameSync(tmp, file)
  }

  /** F1: Perform deterministic election: smallest session id among live peers wins. */
  function electLeader(agent: { session: { id: string; header?: { cwd?: string } } }, role: string): ElectionRecord {
    const peers = readAllPresence(agent)
    const sessionIds = peers.map(p => p.id).filter(isSafeTeamId).sort()
    const leader = sessionIds.length > 0 ? sessionIds[0]! : agent.session.id
    const now = new Date()
    const record: ElectionRecord = {
      role,
      leader,
      leaseExpires: new Date(now.getTime() + ELECTION_LEASE_MS).toISOString(),
      electedAt: now.toISOString(),
      voters: sessionIds,
    }
    writeElection(agent, record)
    return record
  }

  ctx.tools.register(_defineToolAny({
    name: 'team_elect',
    description:
      'F1: Deterministic leader election with lease-based failover. '
      + 'Actions: vote (participate in election for a role; smallest session id wins; lease auto-renews if you are leader; expired lease triggers re-election), '
      + 'status (return current leader for one or all roles), yield (release leadership, triggering re-election). '
      + 'Eliminates single-point-of-failure when the coordinator crashes: its lease expires and a peer takes over.',
    parameters: {
      action: { type: 'string', required: true, enum: ['vote', 'status', 'yield'], description: 'Which election operation to run.' },
      role: { type: 'string', description: 'Role name (e.g. "coordinator"). Required for vote/yield; omit for status to list all.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => {
        const v = value as unknown as { ok: boolean; role?: string; leader?: string; isLeader?: boolean; leaseExpires?: string; elections?: ElectionRecord[]; error?: string }
        if (!v.ok) return [{ type: 'text' as const, text: `team_elect failed: ${v.error ?? 'unknown error'}` }]
        if (v.elections !== undefined) {
          if (v.elections.length === 0) return [{ type: 'text' as const, text: 'No elections found.' }]
          const lines = v.elections.map(e => `  ${e.role}: leader=${e.leader.slice(0, 8)}... lease=${e.leaseExpires}`)
          return [{ type: 'text' as const, text: `Elections:\n${lines.join('\n')}` }]
        }
        const me = v.isLeader ? ' (YOU)' : ''
        return [{ type: 'text' as const, text: `Role "${v.role ?? ''}" leader: ${v.leader?.slice(0, 8) ?? 'none'}...${me} (lease expires ${v.leaseExpires ?? 'n/a'})` }]
      },
    },
    async execute(args: any, exec: any) {
      const agent = exec.agent
      if (!agent) throw new Error('team_elect: no agent context')
      try { writePresence(agent) } catch { /* best-effort */ }

      switch (args.action) {
        case 'vote': {
          const role = args.role
          if (typeof role !== 'string' || role.length === 0) throw new Error('team_elect vote: role is required')
          if (!isSafeTeamId(role)) throw new Error('team_elect vote: role must be a non-empty string without path separators')
          const electionFile = join(teamCwd(agent), TEAM_DIR, 'election', `${role}.json`)
          return withFileLock(electionFile, () => {
            const existing = readElection(agent, role)
            const nowMs = Date.now()
            // If there is a live leader with a valid lease, renew if it's us.
            if (existing !== undefined && existing.leader === agent.session.id && nowMs < new Date(existing.leaseExpires).getTime()) {
              const renewed: ElectionRecord = {
                ...existing,
                leaseExpires: new Date(nowMs + ELECTION_LEASE_MS).toISOString(),
              }
              writeElection(agent, renewed)
              return { ok: true, role, leader: renewed.leader, isLeader: true, leaseExpires: renewed.leaseExpires }
            }
            // If there is a valid lease held by someone else, keep them.
            if (existing !== undefined && nowMs < new Date(existing.leaseExpires).getTime()) {
              return { ok: true, role, leader: existing.leader, isLeader: existing.leader === agent.session.id, leaseExpires: existing.leaseExpires }
            }
            // Lease expired or no election yet: run election.
            const record = electLeader(agent, role)
            return { ok: true, role, leader: record.leader, isLeader: record.leader === agent.session.id, leaseExpires: record.leaseExpires }
          })
        }
        case 'status': {
          if (args.role !== undefined) {
            const role = args.role
            if (!isSafeTeamId(role)) throw new Error('team_elect status: invalid role')
            const existing = readElection(agent, role)
            if (existing === undefined) return { ok: true, role, leader: '', isLeader: false, leaseExpires: '' }
            const nowMs = Date.now()
            const leaseValid = nowMs < new Date(existing.leaseExpires).getTime()
            const result: { ok: boolean; role: string; leader: string; isLeader: boolean; leaseExpires: string; leaseExpired?: boolean } = {
              ok: true, role, leader: existing.leader, isLeader: existing.leader === agent.session.id, leaseExpires: existing.leaseExpires,
            }
            if (!leaseValid) result.leaseExpired = true
            return result
          }
          // List all elections.
          const dir = join(teamCwd(agent), TEAM_DIR, 'election')
          const elections: ElectionRecord[] = []
          if (existsSync(dir)) {
            for (const file of readdirSync(dir)) {
              if (!file.endsWith('.json')) continue
              try {
                const record = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ElectionRecord
                elections.push(record)
              } catch { /* skip corrupted */ }
            }
          }
          return { ok: true, elections }
        }
        case 'yield': {
          const role = args.role
          if (typeof role !== 'string' || role.length === 0) throw new Error('team_elect yield: role is required')
          if (!isSafeTeamId(role)) throw new Error('team_elect yield: invalid role')
          const electionFile = join(teamCwd(agent), TEAM_DIR, 'election', `${role}.json`)
          return withFileLock(electionFile, () => {
            const existing = readElection(agent, role)
            if (existing === undefined) return { ok: true, role, leader: '', isLeader: false, leaseExpires: '', error: 'no election found for this role' }
            if (existing.leader !== agent.session.id) return { ok: true, role, leader: existing.leader, isLeader: false, leaseExpires: existing.leaseExpires, error: 'you are not the current leader' }
            // Yield: run a new election excluding ourselves.
            const peers = readAllPresence(agent).filter(p => p.id !== agent.session.id)
            const sessionIds = peers.map(p => p.id).filter(isSafeTeamId).sort()
            const newLeader = sessionIds.length > 0 ? sessionIds[0]! : agent.session.id
            const nowMs = Date.now()
            const record: ElectionRecord = {
              role,
              leader: newLeader,
              leaseExpires: new Date(nowMs + ELECTION_LEASE_MS).toISOString(),
              electedAt: new Date(nowMs).toISOString(),
              voters: sessionIds,
            }
            writeElection(agent, record)
            return { ok: true, role, leader: record.leader, isLeader: record.leader === agent.session.id, leaseExpires: record.leaseExpires }
          })
        }
        default:
          throw new Error(`team_elect: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Election ${args.action}`, kind: 'other' as const }),
  }))

  // -- team_role (F6: typed role definitions) --
  // Roles define capabilities, write sets, tool whitelists/blacklists, and
  // concurrency limits. Stored in .team/roles/<name>.json. Assignments map
  // sessions to roles in .team/roles/assignments.json.

  /** F6: One role definition. */
  interface RoleDefinition {
    name: string
    capabilities?: string[]
    writeSet?: string[]
    tools?: string[]
    disallowedTools?: string[]
    maxConcurrentTasks?: number
    definedAt: string
  }

  /** F6: Session-to-role assignment map. */
  interface RoleAssignments {
    [session: string]: string
  }

  /** F6: Read a role definition. */
  function readRole(agent: { session: { header?: { cwd?: string } } }, name: string): RoleDefinition | undefined {
    const file = join(teamCwd(agent), TEAM_DIR, 'roles', `${name}.json`)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as RoleDefinition
    } catch {
      return undefined
    }
  }

  /** F6: Write a role definition atomically. */
  function writeRole(agent: { session: { header?: { cwd?: string } } }, role: RoleDefinition): void {
    const dir = join(teamCwd(agent), TEAM_DIR, 'roles')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${role.name}.json`)
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(role, null, 2))
    renameSync(tmp, file)
  }

  /** F6: Read all role assignments. */
  function readRoleAssignments(agent: { session: { header?: { cwd?: string } } }): RoleAssignments {
    const file = join(teamCwd(agent), TEAM_DIR, 'roles', 'assignments.json')
    if (!existsSync(file)) return {}
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as RoleAssignments
    } catch {
      return {}
    }
  }

  /** F6: Write role assignments atomically. */
  function writeRoleAssignments(agent: { session: { header?: { cwd?: string } } }, assignments: RoleAssignments): void {
    const dir = join(teamCwd(agent), TEAM_DIR, 'roles')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'assignments.json')
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(assignments, null, 2))
    renameSync(tmp, file)
  }

  ctx.tools.register(_defineToolAny({
    name: 'team_role',
    description:
      'F6: Typed role definitions with capabilities, write sets, tool whitelists/blacklists, and concurrency limits. '
      + 'Actions: define (create/update a role), list (all roles), assign (bind a role to a session), revoke (remove a session\'s role). '
      + 'Role definitions live in .team/roles/<name>.json; assignments in .team/roles/assignments.json. '
      + 'team_task claim can check the session\'s role writeSet before allowing the claim.',
    parameters: {
      action: { type: 'string', required: true, enum: ['define', 'list', 'assign', 'revoke'], description: 'Which role operation to run.' },
      name: { type: 'string', description: 'Role name (define/assign/revoke).' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Capability list, e.g. ["read","write","execute"] (define).' },
      writeSet: { type: 'array', items: { type: 'string' }, description: 'File/dir globs this role may write (define).' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Allowed tool whitelist (define).' },
      disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Disallowed tool blacklist (define).' },
      maxConcurrentTasks: { type: 'integer', description: 'Max concurrent tasks for this role (define).' },
      session: { type: 'string', description: 'Session id to assign/revoke a role for.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => {
        const v = value as unknown as { ok: boolean; role?: RoleDefinition; roles?: RoleDefinition[]; assignment?: { session: string; role: string }; assignments?: RoleAssignments; error?: string }
        if (!v.ok) return [{ type: 'text' as const, text: `team_role failed: ${v.error ?? 'unknown error'}` }]
        if (v.roles !== undefined) {
          if (v.roles.length === 0) return [{ type: 'text' as const, text: 'No roles defined.' }]
          const lines = v.roles.map(r => `  ${r.name}: caps=[${r.capabilities?.join(',') ?? ''}] tools=[${r.tools?.join(',') ?? '*'}] maxConcurrent=${r.maxConcurrentTasks ?? 'unlimited'}`)
          return [{ type: 'text' as const, text: `Roles:\n${lines.join('\n')}` }]
        }
        if (v.assignments !== undefined) {
          const entries = Object.entries(v.assignments)
          if (entries.length === 0) return [{ type: 'text' as const, text: 'No role assignments.' }]
          const lines = entries.map(([s, r]) => `  ${s.slice(0, 8)}... -> ${r}`)
          return [{ type: 'text' as const, text: `Assignments:\n${lines.join('\n')}` }]
        }
        if (v.assignment !== undefined) return [{ type: 'text' as const, text: `Assigned role "${v.assignment.role}" to ${v.assignment.session.slice(0, 8)}...` }]
        if (v.role !== undefined) return [{ type: 'text' as const, text: `Role "${v.role.name}" defined.` }]
        return [{ type: 'text' as const, text: 'Role operation completed.' }]
      },
    },
    async execute(args: any, exec: any) {
      const agent = exec.agent
      if (!agent) throw new Error('team_role: no agent context')
      try { writePresence(agent) } catch { /* best-effort */ }

      switch (args.action) {
        case 'define': {
          const name = args.name
          if (typeof name !== 'string' || name.length === 0) throw new Error('team_role define: name is required')
          if (!isSafeTeamId(name)) throw new Error('team_role define: name must be a non-empty string without path separators')
          const roleFile = join(teamCwd(agent), TEAM_DIR, 'roles', `${name}.json`)
          return withFileLock(roleFile, () => {
            const existing = readRole(agent, name)
            const role: RoleDefinition = {
              name,
              definedAt: existing?.definedAt ?? new Date().toISOString(),
            }
            // Merge: new args take priority, then existing, then omit.
            const capabilities = Array.isArray(args.capabilities) ? args.capabilities as string[] : existing?.capabilities
            if (capabilities !== undefined) role.capabilities = capabilities
            const writeSet = Array.isArray(args.writeSet) ? args.writeSet as string[] : existing?.writeSet
            if (writeSet !== undefined) role.writeSet = writeSet
            const tools = Array.isArray(args.tools) ? args.tools as string[] : existing?.tools
            if (tools !== undefined) role.tools = tools
            const disallowedTools = Array.isArray(args.disallowedTools) ? args.disallowedTools as string[] : existing?.disallowedTools
            if (disallowedTools !== undefined) role.disallowedTools = disallowedTools
            const maxConcurrentTasks = typeof args.maxConcurrentTasks === 'number' ? args.maxConcurrentTasks : existing?.maxConcurrentTasks
            if (maxConcurrentTasks !== undefined) role.maxConcurrentTasks = maxConcurrentTasks
            writeRole(agent, role)
            return { ok: true, role }
          })
        }
        case 'list': {
          const dir = join(teamCwd(agent), TEAM_DIR, 'roles')
          const roles: RoleDefinition[] = []
          if (existsSync(dir)) {
            for (const file of readdirSync(dir)) {
              if (!file.endsWith('.json') || file === 'assignments.json') continue
              try {
                const role = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as RoleDefinition
                roles.push(role)
              } catch { /* skip corrupted */ }
            }
          }
          // Include assignments alongside roles.
          const assignments = readRoleAssignments(agent)
          return { ok: true, roles, assignments }
        }
        case 'assign': {
          const name = args.name
          const session = args.session
          if (typeof name !== 'string' || name.length === 0) throw new Error('team_role assign: name is required')
          if (typeof session !== 'string' || session.length === 0) throw new Error('team_role assign: session is required')
          if (!isSafeTeamId(session)) throw new Error('team_role assign: invalid session id')
          const role = readRole(agent, name)
          if (role === undefined) throw new Error(`team_role assign: role "${name}" is not defined`)
          const assignmentsFile = join(teamCwd(agent), TEAM_DIR, 'roles', 'assignments.json')
          return withFileLock(assignmentsFile, () => {
            const assignments = readRoleAssignments(agent)
            assignments[session] = name
            writeRoleAssignments(agent, assignments)
            return { ok: true, assignment: { session, role: name } }
          })
        }
        case 'revoke': {
          const session = args.session
          if (typeof session !== 'string' || session.length === 0) throw new Error('team_role revoke: session is required')
          if (!isSafeTeamId(session)) throw new Error('team_role revoke: invalid session id')
          const assignmentsFile = join(teamCwd(agent), TEAM_DIR, 'roles', 'assignments.json')
          return withFileLock(assignmentsFile, () => {
            const assignments = readRoleAssignments(agent)
            if (assignments[session] === undefined) {
              return { ok: true, error: `session ${session.slice(0, 8)}... has no role assigned` }
            }
            const previousRole = assignments[session]
            delete assignments[session]
            writeRoleAssignments(agent, assignments)
            return { ok: true, assignment: { session, role: '' }, ...previousRole !== undefined ? { revoked: previousRole } : {} }
          })
        }
        default:
          throw new Error(`team_role: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Role ${args.action}`, kind: 'other' as const }),
  }))

  // -- team_auto_assign (F10: adaptive task assignment) --
  // Reads presence + tasks.jsonl to pick the best peer for a task based on
  // strategy: load_balance (fewest open tasks), affinity (writeSet match),
  // history (most completed tasks), round_robin (cyclic).

  /** F10: Read the round-robin counter state. */
  function readAutoAssignState(agent: { session: { header?: { cwd?: string } } }): { roundRobinIndex: number } {
    const file = join(teamCwd(agent), TEAM_DIR, 'auto_assign_state.json')
    if (!existsSync(file)) return { roundRobinIndex: 0 }
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as { roundRobinIndex: number }
    } catch {
      return { roundRobinIndex: 0 }
    }
  }

  /** F10: Write the round-robin counter state atomically. */
  function writeAutoAssignState(agent: { session: { header?: { cwd?: string } } }, state: { roundRobinIndex: number }): void {
    const file = join(teamCwd(agent), TEAM_DIR, 'auto_assign_state.json')
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  }

  ctx.tools.register(_defineToolAny({
    name: 'team_auto_assign',
    description:
      'F10: Adaptive task assignment. Picks the best peer for a task and assigns it (updates tasks.jsonl + notifies the peer). '
      + 'Strategies: load_balance (fewest open tasks), affinity (writeSet overlap with task), history (most completed tasks), round_robin (cyclic). '
      + 'Reads presence for live peers and tasks.jsonl for current load. Returns the assigned session and the reason.',
    parameters: {
      strategy: { type: 'string', required: true, enum: ['load_balance', 'affinity', 'history', 'round_robin'], description: 'Assignment strategy.' },
      taskId: { type: 'string', description: 'Task id to assign. If omitted, picks the oldest unassigned todo task.' },
      role: { type: 'string', description: 'Only consider peers assigned this role (via team_role).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => {
        const v = value as unknown as { ok: boolean; assignedSession?: string; reason?: string; taskId?: string; error?: string }
        if (!v.ok) return [{ type: 'text' as const, text: `team_auto_assign failed: ${v.error ?? 'unknown error'}` }]
        return [{ type: 'text' as const, text: `Assigned task ${v.taskId?.slice(0, 8) ?? ''}... to ${v.assignedSession?.slice(0, 8) ?? 'none'}... (${v.reason ?? 'no reason'})` }]
      },
    },
    async execute(args: any, exec: any) {
      const agent = exec.agent
      if (!agent) throw new Error('team_auto_assign: no agent context')
      try { writePresence(agent) } catch { /* best-effort */ }

      const taskFile = teamPath(agent, 'tasks.jsonl')
      const tasks = readJsonl<TeamTask>(taskFile)

      // Resolve the target task.
      let targetTask: TeamTask | undefined
      if (args.taskId !== undefined) {
        targetTask = tasks.findLast(t => t.id === args.taskId)
        if (targetTask === undefined) return { ok: false, error: `task "${args.taskId}" not found` }
      } else {
        // Pick the oldest unassigned todo task.
        const candidates = tasks.filter(t => t.status === 'todo' && t.assignee === undefined)
        if (candidates.length === 0) return { ok: false, error: 'no unassigned todo task found' }
        targetTask = candidates[0]
      }
      if (targetTask === undefined) return { ok: false, error: 'no target task' }

      // Get live peers (excluding self first, but fall back to self if alone).
      let peers = readAllPresence(agent).filter(p => p.id !== agent.session.id && isSafeTeamId(p.id))
      if (peers.length === 0) {
        // No peers: assign to self.
        const selfPresence = readAllPresence(agent).filter(p => p.id === agent.session.id)
        if (selfPresence.length === 0) return { ok: false, error: 'no live peers available' }
        peers = selfPresence
      }

      // Filter by role if specified.
      if (args.role !== undefined) {
        const assignments = readRoleAssignments(agent)
        const rolePeers = peers.filter(p => assignments[p.id] === args.role)
        if (rolePeers.length > 0) peers = rolePeers
        // If no peers have the role, fall back to all peers (best-effort).
      }

      const candidateIds = peers.map(p => p.id)
      let assignedSession: string | undefined
      let reason: string | undefined

      switch (args.strategy) {
        case 'load_balance': {
          // Count open tasks per peer.
          const load: Record<string, number> = {}
          for (const id of candidateIds) load[id] = 0
          for (const t of tasks) {
            if (t.assignee !== undefined && t.status !== 'done' && t.status !== 'blocked') {
              load[t.assignee] = (load[t.assignee] ?? 0) + 1
            }
          }
          // Pick the peer with the fewest open tasks.
          candidateIds.sort((a, b) => (load[a] ?? 0) - (load[b] ?? 0))
          assignedSession = candidateIds[0]
          reason = `load_balance: ${load[assignedSession ?? ''] ?? 0} open tasks`
          break
        }
        case 'affinity': {
          // Score peers by writeSet overlap with the task.
          const taskWriteSet = targetTask.writeSet ?? []
          const assignments = readRoleAssignments(agent)
          let bestPeer = candidateIds[0]
          let bestScore = -1
          for (const id of candidateIds) {
            const roleName = assignments[id]
            const role = roleName !== undefined ? readRole(agent, roleName) : undefined
            const peerWriteSet = role?.writeSet ?? []
            let score = 0
            for (const tw of taskWriteSet) {
              for (const pw of peerWriteSet) {
                if (writeSetsOverlap(tw, pw)) score++
              }
            }
            if (score > bestScore) {
              bestScore = score
              bestPeer = id
            }
          }
          assignedSession = bestPeer
          reason = `affinity: writeSet overlap score ${bestScore}`
          break
        }
        case 'history': {
          // Count completed tasks per peer.
          const done: Record<string, number> = {}
          for (const t of tasks) {
            if (t.status === 'done' && t.assignee !== undefined) {
              done[t.assignee] = (done[t.assignee] ?? 0) + 1
            }
          }
          // Pick the peer with the most completed tasks.
          candidateIds.sort((a, b) => (done[b] ?? 0) - (done[a] ?? 0))
          assignedSession = candidateIds[0]
          reason = `history: ${done[assignedSession ?? ''] ?? 0} completed tasks`
          break
        }
        case 'round_robin': {
          const state = readAutoAssignState(agent)
          const idx = state.roundRobinIndex % candidateIds.length
          assignedSession = candidateIds[idx]
          state.roundRobinIndex = (idx + 1) % candidateIds.length
          writeAutoAssignState(agent, state)
          reason = `round_robin: index ${idx}`
          break
        }
        default:
          return { ok: false, error: `unknown strategy "${String(args.strategy)}"` }
      }

      if (assignedSession === undefined) return { ok: false, error: 'no peer selected' }

      // Assign the task to the selected peer (update tasks.jsonl + notify).
      const taskId = targetTask.id
      const taskTitle = targetTask.title
      const now = () => new Date().toISOString()
      await lockedUpdate<TeamTask>(taskFile, (records) => {
        const task = records.find(t => t.id === taskId)
        if (task !== undefined) {
          task.assignee = assignedSession
          if (task.status === 'todo') task.status = 'in_progress'
          task.updatedTs = now()
        }
        return records
      })

      // Notify the assigned peer.
      if (assignedSession !== agent.session.id) {
        try {
          await notifyPeer(agent, assignedSession, `[team_auto_assign] Task "${taskTitle}" assigned to you via ${args.strategy}. Claim or update it with team_task(action:"claim"|"update", id:"${taskId}").`)
        } catch { /* best-effort */ }
      }

      return { ok: true, assignedSession, reason, taskId }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Auto-assign ${args.strategy}`, kind: 'other' as const }),
  }))

  // -- team_agent_define (declarative agent definitions with hot reload) --
  // Agent specs are stored in .team/agents/<name>.json. They define model,
  // tools, permissions, system prompt, isolation, and MCP servers. Hot
  // reload: an updated spec takes effect on the next read without restart.

  /** Agent spec definition. */
  interface AgentSpec {
    name: string
    description: string
    model?: string
    tools?: string[]
    disallowedTools?: string[]
    maxTurns?: number
    permissionMode?: 'read_only' | 'accept_edits' | 'auto' | 'plan'
    systemPrompt?: string
    isolation?: 'worktree' | 'docker' | 'none'
    mcpServers?: string[]
    createdAt: string
    updatedAt: string
  }

  /** Read an agent spec. */
  function readAgentSpec(agent: { session: { header?: { cwd?: string } } }, name: string): AgentSpec | undefined {
    const file = join(teamCwd(agent), TEAM_DIR, 'agents', `${name}.json`)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as AgentSpec
    } catch {
      return undefined
    }
  }

  /** Write an agent spec atomically. */
  function writeAgentSpec(agent: { session: { header?: { cwd?: string } } }, spec: AgentSpec): void {
    const dir = join(teamCwd(agent), TEAM_DIR, 'agents')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${spec.name}.json`)
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(spec, null, 2))
    renameSync(tmp, file)
  }

  ctx.tools.register(_defineToolAny({
    name: 'team_agent_define',
    description:
      'Declarative agent definitions with hot reload. Agent specs live in .team/agents/<name>.json. '
      + 'Actions: create (new spec), update (modify spec; hot-reloads without restarting running agents), delete (remove spec), list (all specs), get (one spec). '
      + 'Spec includes: description, model, tools whitelist/blacklist, maxTurns, permissionMode, systemPrompt, isolation (worktree/docker/none), mcpServers. '
      + 'Inspired by Claude Code .claude/agents/*.md and CrewAI agents/*.jsonc.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update', 'delete', 'list', 'get'], description: 'Which agent spec operation to run.' },
      name: { type: 'string', description: 'Agent name (create/update/delete/get).' },
      spec: {
        type: 'object',
        additionalProperties: true,
        description: 'Agent spec (create/update). { description, model?, tools?, disallowedTools?, maxTurns?, permissionMode?, systemPrompt?, isolation?, mcpServers? }',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => {
        const v = value as unknown as { ok: boolean; spec?: AgentSpec; specs?: AgentSpec[]; error?: string }
        if (!v.ok) return [{ type: 'text' as const, text: `team_agent_define failed: ${v.error ?? 'unknown error'}` }]
        if (v.specs !== undefined) {
          if (v.specs.length === 0) return [{ type: 'text' as const, text: 'No agent specs defined.' }]
          const lines = v.specs.map(s => `  ${s.name}: model=${s.model ?? 'default'} tools=${s.tools?.length ?? '*'} isolation=${s.isolation ?? 'none'}`)
          return [{ type: 'text' as const, text: `Agent specs:\n${lines.join('\n')}` }]
        }
        if (v.spec !== undefined) {
          const s = v.spec
          const lines = [
            `Agent "${s.name}":`,
            `  description: ${s.description}`,
            `  model: ${s.model ?? 'default'}`,
            `  tools: ${s.tools?.join(', ') ?? '*'}`,
            `  disallowedTools: ${s.disallowedTools?.join(', ') ?? 'none'}`,
            `  maxTurns: ${s.maxTurns ?? 'unlimited'}`,
            `  permissionMode: ${s.permissionMode ?? 'default'}`,
            `  isolation: ${s.isolation ?? 'none'}`,
            `  mcpServers: ${s.mcpServers?.join(', ') ?? 'none'}`,
          ]
          return [{ type: 'text' as const, text: lines.join('\n') }]
        }
        return [{ type: 'text' as const, text: 'Agent spec operation completed.' }]
      },
    },
    async execute(args: any, exec: any) {
      const agent = exec.agent
      if (!agent) throw new Error('team_agent_define: no agent context')
      try { writePresence(agent) } catch { /* best-effort */ }

      switch (args.action) {
        case 'create': {
          const name = args.name
          if (typeof name !== 'string' || name.length === 0) throw new Error('team_agent_define create: name is required')
          if (!isSafeTeamId(name)) throw new Error('team_agent_define create: name must be a non-empty string without path separators')
          const specArg = args.spec as Partial<AgentSpec> | undefined
          if (specArg === undefined || typeof specArg.description !== 'string' || specArg.description.length === 0) {
            throw new Error('team_agent_define create: spec.description is required')
          }
          const description: string = specArg.description
          const agentFile = join(teamCwd(agent), TEAM_DIR, 'agents', `${name}.json`)
          return withFileLock(agentFile, () => {
            if (existsSync(agentFile)) throw new Error(`team_agent_define create: agent "${name}" already exists (use update)`)
            const now = new Date().toISOString()
            const spec: AgentSpec = {
              name,
              description,
              createdAt: now,
              updatedAt: now,
            }
            if (typeof specArg.model === 'string') spec.model = specArg.model
            if (Array.isArray(specArg.tools)) spec.tools = specArg.tools as string[]
            if (Array.isArray(specArg.disallowedTools)) spec.disallowedTools = specArg.disallowedTools as string[]
            if (typeof specArg.maxTurns === 'number') spec.maxTurns = specArg.maxTurns
            if (typeof specArg.permissionMode === 'string') spec.permissionMode = specArg.permissionMode as 'read_only' | 'accept_edits' | 'auto' | 'plan'
            if (typeof specArg.systemPrompt === 'string') spec.systemPrompt = specArg.systemPrompt
            if (typeof specArg.isolation === 'string') spec.isolation = specArg.isolation as 'worktree' | 'docker' | 'none'
            if (Array.isArray(specArg.mcpServers)) spec.mcpServers = specArg.mcpServers as string[]
            writeAgentSpec(agent, spec)
            return { ok: true, spec }
          })
        }
        case 'update': {
          const name = args.name
          if (typeof name !== 'string' || name.length === 0) throw new Error('team_agent_define update: name is required')
          if (!isSafeTeamId(name)) throw new Error('team_agent_define update: invalid name')
          const specArg = args.spec as Partial<AgentSpec> | undefined
          const agentFile = join(teamCwd(agent), TEAM_DIR, 'agents', `${name}.json`)
          return withFileLock(agentFile, () => {
            const existing = readAgentSpec(agent, name)
            if (existing === undefined) throw new Error(`team_agent_define update: agent "${name}" not found (use create)`)
            // Hot reload: update the spec in place; running agents pick up the
            // change on their next read (no restart needed).
            const spec: AgentSpec = {
              ...existing,
              updatedAt: new Date().toISOString(),
            }
            if (specArg !== undefined) {
              if (typeof specArg.description === 'string') spec.description = specArg.description
              if (typeof specArg.model === 'string') spec.model = specArg.model
              if (Array.isArray(specArg.tools)) spec.tools = specArg.tools as string[]
              if (Array.isArray(specArg.disallowedTools)) spec.disallowedTools = specArg.disallowedTools as string[]
              if (typeof specArg.maxTurns === 'number') spec.maxTurns = specArg.maxTurns
              if (typeof specArg.permissionMode === 'string') spec.permissionMode = specArg.permissionMode as 'read_only' | 'accept_edits' | 'auto' | 'plan'
              if (typeof specArg.systemPrompt === 'string') spec.systemPrompt = specArg.systemPrompt
              if (typeof specArg.isolation === 'string') spec.isolation = specArg.isolation as 'worktree' | 'docker' | 'none'
              if (Array.isArray(specArg.mcpServers)) spec.mcpServers = specArg.mcpServers as string[]
            }
            writeAgentSpec(agent, spec)
            return { ok: true, spec }
          })
        }
        case 'delete': {
          const name = args.name
          if (typeof name !== 'string' || name.length === 0) throw new Error('team_agent_define delete: name is required')
          if (!isSafeTeamId(name)) throw new Error('team_agent_define delete: invalid name')
          const agentFile = join(teamCwd(agent), TEAM_DIR, 'agents', `${name}.json`)
          return withFileLock(agentFile, () => {
            if (!existsSync(agentFile)) return { ok: true, error: `agent "${name}" not found` }
            try { unlinkSync(agentFile) } catch { /* best-effort */ }
            return { ok: true }
          })
        }
        case 'list': {
          const dir = join(teamCwd(agent), TEAM_DIR, 'agents')
          const specs: AgentSpec[] = []
          if (existsSync(dir)) {
            for (const file of readdirSync(dir)) {
              if (!file.endsWith('.json')) continue
              try {
                const spec = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as AgentSpec
                specs.push(spec)
              } catch { /* skip corrupted */ }
            }
          }
          return { ok: true, specs }
        }
        case 'get': {
          const name = args.name
          if (typeof name !== 'string' || name.length === 0) throw new Error('team_agent_define get: name is required')
          const spec = readAgentSpec(agent, name)
          if (spec === undefined) return { ok: false, error: `agent "${name}" not found` }
          return { ok: true, spec }
        }
        default:
          throw new Error(`team_agent_define: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Agent ${args.action}`, kind: 'other' as const }),
  }))

  // ── session_delete tool ───────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'session_delete',
    description: 'Delete a session and all its files. Removes the session directory from disk, clears its storage cache entries, and removes its team presence. Use this to clean up old or unwanted sessions COMPLETELY.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session ID to delete. E.g. "session-abc123".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'string', required: true },
          details: { type: 'array' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as unknown as { deleted: string; details: string[]; note: string }
        return [{ type: 'text' as const, text: `Session ${v.deleted} deleted. ${v.details.join('; ')}. ${v.note}` }]
      },
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (!agent) throw new Error('session_delete: no agent context')
      const cwd = teamCwd(agent)
      const sessionId = assertSafeTeamId(args.sessionId, 'session_delete sessionId')
      if (sessionId === agent.session.id) {
        throw new Error('session_delete: refusing to delete the calling session while it is running')
      }

      const results: string[] = []

      // 1. Remove the session's backend-owned artifact through the persistence
      //    backend's own locator (id encoding + compression suffix stay the
      //    backend's concern), mirroring workspace.deleteSession.
      const persistence = ctx.get('sessionPersistence') as
        | { list(): Promise<{ id: string }[]>; locate(meta: { id: string }): { path: string } | undefined }
        | undefined
      if (persistence !== undefined) {
        const header = (await persistence.list()).find(c => c.id === sessionId)
        if (header !== undefined) {
          const location = persistence.locate(header)
          if (location !== undefined) {
            rmSync(dirname(location.path), { recursive: true, force: true })
            results.push(`Removed session directory: ${dirname(location.path)}`)
          }
        } else {
          results.push(`Session directory not found for: ${sessionId}`)
        }
      }

      // 2. Remove team presence
      const presenceDir = join(cwd, TEAM_DIR, 'presence')
      const presenceFile = join(presenceDir, `${sessionId}.json`)
      if (existsSync(presenceFile)) {
        unlinkSync(presenceFile)
        results.push(`Removed team presence: ${presenceFile}`)
      }

      // 3. Remove team inbox
      const inboxFile = join(cwd, TEAM_DIR, 'inbox', `${sessionId}.jsonl`)
      if (existsSync(inboxFile)) {
        unlinkSync(inboxFile)
        results.push(`Removed team inbox: ${inboxFile}`)
      }

      return {
        deleted: sessionId,
        details: results,
        note: 'Storage caches (workspace.json, session_projcache.json) will be cleaned on next server restart. The session is now fully deleted from disk.',
      }
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: `Delete session ${args.sessionId}`,
      kind: 'delete' as const,
    }),
  }))
  // ==========================================================================
  // -- team_spawn: dynamic subagent delegation with skill injection ----------
  //
  // Allows a team-mode session to spawn child subagents on demand. Each
  // subagent gets parent-child attribution (parentSession), can access the
  // .team/ directory for collaboration, and supports both one-shot and
  // continuable modes. Recursive delegation is controlled by maxDepth.
  //
  // Skill injection: the caller names skills (e.g. ["code-review",
  // "deep-research"]) at spawn time. The tool searches ctx.skills for each
  // name, renders the matching SKILL.md bodies, and prepends them to the
  // subagent's prompt. The injection is ephemeral — it lives only in the
  // child's prompt, not in any persistent config — so "用完就删除" is
  // automatic: when the child disposes, the skill text goes with it.
  // "现创建现搜索" means every team_spawn call re-queries ctx.skills; no
  // cache, no pre-configuration.
  // ==========================================================================

  const subagentsService = ctx.get('subagents' as any) as
    | {
        start(name: string, request: any): Promise<any>
        startContinuable(spec: any): Promise<{ childId: string; messageId: string }>
        followup(parent: any, childId: string, content: any[], options: any): Promise<string>
        interrupt(targetSessionId: string, authority: any): void
        listChildren(parentSessionId: string, signal?: AbortSignal): Promise<any[]>
        listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<any[]>
        getProvider(name: string): any
        list(): string[]
      }
    | undefined

  const skillsService = ctx.get('skills' as any) as
    | {
        list(options?: any): Promise<any[]>
        get(name: string, options?: any): Promise<any | undefined>
      }
    | undefined

  if (subagentsService !== undefined) {
    /** Default subagent provider. */
    const DEFAULT_SPAWN_PROVIDER = 'spawn'

    /** Default max delegation depth. */
    const DEFAULT_SPAWN_MAX_DEPTH = 3

    /** Render a loaded skill definition into a prompt-prefix block. */
    function renderSkillForPrompt(skill: { name: string; content: string; description?: string }): string {
      return [
        `<skill_content name="${skill.name}">`,
        '<skill_instructions>',
        skill.content,
        '</skill_instructions>',
        '</skill_content>',
      ].join('\n')
    }

    /**
     * Search and load skills by name from ctx.skills. Returns a prompt prefix
     * containing all found skill bodies, or an empty string if none found.
     * "现创建现搜索": every call re-queries the skill registry; no caching.
     */
    async function loadSkillsForSpawn(
      skillNames: string[],
      cwd: string | undefined,
      signal: AbortSignal,
    ): Promise<{ prefix: string; found: string[]; missing: string[] }> {
      if (skillsService === undefined || skillNames.length === 0) {
        return { prefix: '', found: [], missing: skillNames }
      }
      const found: string[] = []
      const missing: string[] = []
      const bodies: string[] = []
      for (const name of skillNames) {
        try {
          const skill = await skillsService.get(name, { cwd, signal })
          if (skill !== undefined && typeof skill.content === 'string') {
            bodies.push(renderSkillForPrompt(skill))
            found.push(name)
          } else {
            missing.push(name)
          }
        } catch {
          missing.push(name)
        }
      }
      const prefix = bodies.length > 0
        ? bodies.join('\n\n') + '\n\n'
        : ''
      return { prefix, found, missing }
    }

    /** Write a spawn record to .team/spawns/ for team visibility. */
    function writeSpawnRecord(
      agent: { session: { id: string; header?: { cwd?: string } } },
      childId: string,
      spec: {
        label: string
        mode: 'one-shot' | 'continuable'
        provider: string
        role?: string
        depth?: number
        skills?: string[]
      },
    ): void {
      const cwd = teamCwd(agent)
      const spawnsDir = join(cwd, TEAM_DIR, 'spawns')
      mkdirSync(spawnsDir, { recursive: true })
      const record = {
        childId,
        parentSessionId: agent.session.id,
        label: spec.label,
        mode: spec.mode,
        provider: spec.provider,
        role: spec.role,
        depth: spec.depth,
        skills: spec.skills,
        spawnedAt: Date.now(),
      }
      const file = join(spawnsDir, `${childId}.json`)
      const fd = openSync(file, 'w')
      try {
        writeFileSync(fd, JSON.stringify(record, null, 2))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }

    /** List spawn records for a parent session. */
    function listSpawnRecords(
      agent: { session: { id: string; header?: { cwd?: string } } },
    ): Array<{ childId: string; parentSessionId: string; label: string; mode: string; provider: string; role?: string; depth?: number; skills?: string[]; spawnedAt: number }> {
      const cwd = teamCwd(agent)
      const spawnsDir = join(cwd, TEAM_DIR, 'spawns')
      if (!existsSync(spawnsDir)) return []
      const records: any[] = []
      for (const file of readdirSync(spawnsDir)) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = readFileSync(join(spawnsDir, file), 'utf8')
          const rec = JSON.parse(raw)
          if (rec.parentSessionId === agent.session.id) records.push(rec)
        } catch { /* skip corrupt */ }
      }
      return records.sort((a, b) => a.spawnedAt - b.spawnedAt)
    }

    // -- team_spawn: spawn a subagent with optional skill injection --

    ctx.tools.register(_defineToolAny({
      name: 'team_spawn',
      description:
        'Spawn a subagent (child agent) for delegated work, with team integration and skill injection. '
        + 'The subagent can access the .team/ directory for collaboration with other team members. '
        + 'Mode "one-shot" (default): the subagent runs the task and returns its result. '
        + 'Set run_in_background=true to return immediately with a job id. '
        + 'Mode "continuable": the subagent stays alive for multi-turn interaction; '
        + 'use team_spawn_followup to send later messages and team_spawn_interrupt to stop it. '
        + 'Skills: pass skill names (e.g. ["code-review","deep-research"]) to search and inject '
        + 'skill instructions into the subagent prompt. Skills are ephemeral — they exist only '
        + 'in the child prompt and are cleaned up automatically when the subagent disposes. '
        + 'Parent-child attribution is recorded in .team/spawns/ for team visibility. '
        + 'Recursive delegation is controlled by maxDepth (default 3).',
      parameters: {
        description: { type: 'string', required: true, description: 'A short (3-5 word) label for the delegated task.' },
        prompt: { type: 'string', required: true, description: 'The complete task prompt for the subagent.' },
        provider: { type: 'string', description: 'Subagent provider name (default "spawn"). Available: spawn, fork, acp.' },
        mode: { type: 'string', enum: ['one-shot', 'continuable'], description: 'Delegation mode (default "one-shot").' },
        run_in_background: { type: 'boolean', description: 'For one-shot: run as background job. For continuable: always background.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill names to search and inject into the subagent prompt (e.g. ["code-review","deep-research"]). Ephemeral: cleaned up when the subagent disposes.' },
        toolFilter: {
          type: 'object',
          properties: {
            allow: { type: 'array', items: { type: 'string' }, description: 'Tool whitelist.' },
            deny: { type: 'array', items: { type: 'string' }, description: 'Tool blacklist.' },
          },
          description: 'Tool scoping for the subagent.',
        },
        maxDepth: { type: 'number', description: 'Maximum delegation depth for recursive subagent spawning (default 3).' },
        persona: { type: 'string', description: 'Per-child persona that shadows the deployment persona.' },
        role: { type: 'string', description: 'Team role to assign to this subagent (recorded in .team/spawns/).' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                subagentId: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
                stopReason: { type: 'string', required: true },
                skillsFound: { type: 'array', items: { type: 'string' } },
                skillsMissing: { type: 'array', items: { type: 'string' } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
                messageId: { type: 'string', required: true },
                skillsFound: { type: 'array', items: { type: 'string' } },
                skillsMissing: { type: 'array', items: { type: 'string' } },
              },
            },
          ],
        },
        render: (_args: any, value: any) => [{
          type: 'text',
          text: value.kind === 'foreground'
            ? `subagent ${value.subagentId} completed: ${JSON.stringify(value.output)}`
            : value.kind === 'background'
              ? `started background subagent job ${value.jobId}`
              : `started continuable subagent ${value.subagentId}`,
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args: any, exec: any) {
        const agent = exec.agent
        if (!agent) throw new Error('team_spawn: no agent context (exec.agent was undefined)')

        const providerName = args.provider ?? DEFAULT_SPAWN_PROVIDER
        const provider = subagentsService.getProvider(providerName)
        if (provider === undefined) {
          const available = subagentsService.list()
          throw new Error(`team_spawn: provider "${providerName}" not registered. Available: ${available.join(', ') || 'none'}`)
        }

        const mode = args.mode ?? 'one-shot'
        const maxDepth = args.maxDepth ?? DEFAULT_SPAWN_MAX_DEPTH
        const label = args.description
        const skillNames: string[] = Array.isArray(args.skills) ? args.skills : []
        const cwd = teamCwd(agent)

        // "现创建现搜索": load skills on demand for this spawn
        const { prefix: skillPrefix, found: skillsFound, missing: skillsMissing } = await loadSkillsForSpawn(skillNames, cwd, exec.signal)

        // Build the prompt: skill instructions first, then the user's task prompt
        const fullPromptText = skillPrefix + args.prompt
        const promptContent = [{ type: 'text', text: fullPromptText }]

        // Build the start request
        const request: any = {
          label,
          prompt: promptContent,
          parent: agent,
          signal: exec.signal,
          ...args.persona !== undefined ? { persona: args.persona } : {},
          ...args.toolFilter !== undefined ? { toolFilter: args.toolFilter } : {},
          maxDepth,
        }

        if (mode === 'continuable') {
          // Continuable: always background, returns child id immediately
          const started = await subagentsService.startContinuable({
            provider: providerName,
            label,
            request,
            signal: exec.signal,
          })
          // Record spawn for team visibility
          try {
            writeSpawnRecord(agent, started.childId, { label, mode: 'continuable', provider: providerName, role: args.role, depth: maxDepth, skills: skillNames })
          } catch { /* best-effort */ }
          return { kind: 'continuable' as const, subagentId: started.childId, messageId: started.messageId, skillsFound, skillsMissing }
        }

        // One-shot mode
        const runInBackground = args.run_in_background ?? false

        if (runInBackground) {
          const jobs = ctx.get('jobs' as any)
          if (jobs === undefined) {
            throw new Error('team_spawn: background jobs unavailable (load @deepseek-ai/dsh-jobs)')
          }
          const id = jobs.start({
            kind: 'team-subagent',
            label,
            owner: agent,
            run: () => {
              const controller = new AbortController()
              const start = subagentsService.start(providerName, { ...request, signal: controller.signal })
              return {
                cancel: (reason?: string) => controller.abort(reason ?? 'background team subagent killed'),
                done: (async () => {
                  try {
                    const run = await start
                    const result = await run.result
                    try { writeSpawnRecord(agent, run.id, { label, mode: 'one-shot', provider: providerName, role: args.role, depth: maxDepth, skills: skillNames }) } catch { /* best-effort */ }
                    await run.dispose()
                    return { status: 'completed', detail: JSON.stringify(result.output) }
                  } catch (error: unknown) {
                    return { status: 'failed', detail: String(error) }
                  }
                })(),
              }
            },
          })
          return { kind: 'background' as const, jobId: id }
        }

        // Foreground one-shot: wait for result
        const run = await subagentsService.start(providerName, { ...request, signal: exec.signal })
        try {
          const result = await run.result
          // Record spawn for team visibility
          try {
            writeSpawnRecord(agent, run.id, { label, mode: 'one-shot', provider: providerName, role: args.role, depth: maxDepth, skills: skillNames })
          } catch { /* best-effort */ }
          return {
            kind: 'foreground' as const,
            subagentId: run.id,
            output: result.output as any,
            stopReason: result.stopReason,
            skillsFound,
            skillsMissing,
          }
        } finally {
          await run.dispose()
        }
      },
      presentCall: (args: any) => ({
        card: 'generic' as const,
        title: `Spawn subagent: ${args.description}`,
        kind: 'spawn' as const,
      }),
    }))

    // -- team_spawn_list: list child subagents --

    ctx.tools.register(_defineToolAny({
      name: 'team_spawn_list',
      description:
        'List subagents spawned by this session. Returns both local spawn records '
        + '(from .team/spawns/) and live session-backed children (from the subagent runtime). '
        + 'Use recursive=true to list the entire descendant tree.',
      parameters: {
        recursive: { type: 'boolean', description: 'List all descendants (full tree) instead of just direct children (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            children: { type: 'array', items: { type: 'json' } },
          },
        },
        render: (_args: any, value: any) => [{
          type: 'text',
          text: `${value.children.length} subagent(s): ${value.children.map((c: any) => c.id ?? c.childId).join(', ')}`,
        }],
      },
      async execute(args: any, exec: any) {
        const agent = exec.agent
        if (!agent) throw new Error('team_spawn_list: no agent context')

        // Get live children from subagent runtime
        const liveChildren = args.recursive
          ? await subagentsService.listDescendants(agent.session.id, exec.signal)
          : await subagentsService.listChildren(agent.session.id, exec.signal)

        // Get local spawn records
        const localRecords = listSpawnRecords(agent)

        // Merge: live children take precedence, local records fill gaps
        const liveIds = new Set(liveChildren.map((c: any) => c.id))
        const merged = [
          ...liveChildren,
          ...localRecords.filter(r => !liveIds.has(r.childId)).map(r => ({
            id: r.childId,
            label: r.label,
            mode: r.mode,
            provider: r.provider,
            role: r.role,
            depth: r.depth,
            skills: r.skills,
            spawnedAt: r.spawnedAt,
            source: 'local-record',
          })),
        ]

        return { children: merged }
      },
      presentCall: (args: any) => ({
        card: 'generic' as const,
        title: args.recursive ? 'List all descendant subagents' : 'List direct child subagents',
        kind: 'list' as const,
      }),
    }))

    // -- team_spawn_followup: send follow-up to a continuable subagent --

    ctx.tools.register(_defineToolAny({
      name: 'team_spawn_followup',
      description:
        'Send a follow-up message to a continuable subagent. The subagent processes '
        + 'it as its next turn. Only the direct parent can send follow-ups. '
        + 'Use team_spawn with mode="continuable" to create a continuable subagent first. '
        + 'Optional skills parameter: search and inject additional skills into this follow-up message.',
      parameters: {
        subagentId: { type: 'string', required: true, description: 'The continuable subagent session id (from team_spawn result).' },
        message: { type: 'string', required: true, description: 'The follow-up message content.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Additional skill names to search and inject into this follow-up message (ephemeral).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            messageId: { type: 'string', required: true },
            skillsFound: { type: 'array', items: { type: 'string' } },
            skillsMissing: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args: any, value: any) => [{
          type: 'text',
          text: `follow-up delivered to subagent (message id: ${value.messageId})`,
        }],
      },
      async execute(args: any, exec: any) {
        const agent = exec.agent
        if (!agent) throw new Error('team_spawn_followup: no agent context')

        const childId = assertSafeTeamId(args.subagentId, 'team_spawn_followup subagentId')

        // Load skills for this follow-up (ephemeral injection)
        const skillNames: string[] = Array.isArray(args.skills) ? args.skills : []
        const cwd = teamCwd(agent)
        const { prefix: skillPrefix, found: skillsFound, missing: skillsMissing } = await loadSkillsForSpawn(skillNames, cwd, exec.signal)

        const fullText = skillPrefix + args.message
        const content = [{ type: 'text', text: fullText }]

        const messageId = await subagentsService.followup(agent, childId, content, {
          signal: exec.signal,
        })

        return { messageId, skillsFound, skillsMissing }
      },
      presentCall: (args: any) => ({
        card: 'generic' as const,
        title: `Follow-up to subagent ${args.subagentId}`,
        kind: 'message' as const,
      }),
    }))

    // -- team_spawn_interrupt: interrupt a running subagent --

    ctx.tools.register(_defineToolAny({
      name: 'team_spawn_interrupt',
      description:
        'Interrupt a running continuable subagent. The subagent\'s current turn is '
        + 'cancelled but its session state is preserved. The calling agent must be '
        + 'the parent or an ancestor of the target subagent.',
      parameters: {
        subagentId: { type: 'string', required: true, description: 'The subagent session id to interrupt.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            interrupted: { type: 'string', required: true },
          },
        },
        render: (_args: any, value: any) => [{
          type: 'text',
          text: `interrupted subagent ${value.interrupted}`,
        }],
      },
      async execute(args: any, exec: any) {
        const agent = exec.agent
        if (!agent) throw new Error('team_spawn_interrupt: no agent context')

        const childId = assertSafeTeamId(args.subagentId, 'team_spawn_interrupt subagentId')

        // The authority is the calling agent (parent or ancestor)
        subagentsService.interrupt(childId, { kind: 'ancestor', agent })

        return { interrupted: childId }
      },
      presentCall: (args: any) => ({
        card: 'generic' as const,
        title: `Interrupt subagent ${args.subagentId}`,
        kind: 'interrupt' as const,
      }),
    }))

    // -- team_spawn_skill_search: search available skills --

    if (skillsService !== undefined) {
      ctx.tools.register(_defineToolAny({
        name: 'team_spawn_skill_search',
        description:
          'Search available skills from the skill registry. Returns skill names and '
          + 'descriptions. Use the skill names with team_spawn\'s skills parameter to '
          + 'inject skill instructions into a subagent. Skills are searched live from '
          + 'the project, user, and bundled skill directories.',
        parameters: {
          query: { type: 'string', description: 'Optional filter: only return skills whose name or description contains this string.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              skills: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    name: { type: 'string', required: true },
                    description: { type: 'string', required: true },
                    whenToUse: { type: 'string' },
                    source: { type: 'string' },
                    provider: { type: 'string' },
                  },
                },
              },
            },
          },
          render: (_args: any, value: any) => [{
            type: 'text',
            text: value.skills.map((s: any) => `${s.name}: ${s.description}`).join('\n'),
          }],
        },
        async execute(args: any, exec: any) {
          const agent = exec.agent
          if (!agent) throw new Error('team_spawn_skill_search: no agent context')

          const cwd = teamCwd(agent)
          const allSkills = await skillsService.list({ cwd, signal: exec.signal })

          // Apply optional query filter
          const query = args.query?.toLowerCase()
          const filtered = query !== undefined && query.length > 0
            ? allSkills.filter((s: any) =>
                s.name.toLowerCase().includes(query)
                || (s.description?.toLowerCase().includes(query))
                || (s.whenToUse?.toLowerCase().includes(query)),
              )
            : allSkills

          return {
            skills: filtered.map((s: any) => ({
              name: s.name,
              description: s.description,
              ...s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {},
              source: s.source,
              provider: s.provider,
            })),
          }
        },
        presentCall: (args: any) => ({
          card: 'generic' as const,
          title: args.query ? `Search skills: ${args.query}` : 'List all skills',
          kind: 'list' as const,
        }),
      }))
    } // end if (skillsService !== undefined)
  } // end if (subagentsService !== undefined)
}


