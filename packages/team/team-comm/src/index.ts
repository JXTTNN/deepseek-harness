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
import { homedir } from 'node:os'
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

/** Presence records older than this (ms) are considered stale. */
const PRESENCE_STALE_MS = 60 * 60_000 // 60 minutes — long enough for a peer to sit idle awaiting a reply (was 15m, too short and pruned live peers)

/** A `.lock` file older than this (ms) is treated as orphaned and broken. */
const FILE_LOCK_STALE_MS = 10_000

/** How long to wait for a peer's lock before force-breaking it. */
const FILE_LOCK_TIMEOUT_MS = 5_000

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
  tail.then(() => { if (inboxLocks.get(file) === tail) inboxLocks.delete(file) })
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
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS
    // Acquire the lock, breaking it only when it is provably stale.
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
        // Another process holds it. Break it only if it is orphaned.
        let stale = false
        try {
          stale = Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS
        } catch { /* lock vanished; retry acquisition */ }
        if (stale || Date.now() > deadline) {
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
function lockedAppend<T>(file: string, record: T): Promise<void> {
  return withFileLock(file, () => {
    writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'a' })
    // Amortised bound: only when the ledger is already large, rewrite it to its
    // tail. Best-effort — a trim failure must never fail the append itself.
    try {
      if (statSync(file).size > MAX_APPEND_FILE_BYTES) {
        const records = readJsonlStrict<T>(file)
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
    writeFileSync(inboxFile, JSON.stringify(record) + '\n', { flag: 'a' })
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
    }, (res: any) => { res.resume() })
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
}

/** One presence record. */
interface PresenceRecord {
  id: string
  name: string
  ts: string
}

/** One task on the shared team task board. */
interface TeamTask {
  id: string
  title: string
  description?: string
  assignee?: string
  status: 'todo' | 'in_progress' | 'done' | 'blocked'
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  deadline?: string
  deps?: string[]
  result?: string
  createdBy: string
  ts: string
  updatedTs: string
}

/** One key-value entry in the shared team memory. */
interface TeamMemoryEntry {
  key: string
  value: string
  updatedBy: string
  ts: string
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
    // eslint-disable-next-line no-console
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
  ctx.on('agent/created', ({ agent }: any) => {
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
    text: (_ctx: any) => {
      return 'TEAM STATE: You are in a team. Call team_inbox EVERY turn to check for messages. Call team_list to discover peers. Use team_send to communicate. If you receive a message, you MUST reply to the sender with team_send(reply_to: msgId). To make the team greater than one agent, share a task board with team_task (priority/deadline/assignee + auto-notify), persist decisions with team_memory, fan work out to every peer with team_broadcast + team_collect, verify results independently with team_review + team_review_collect, synchronize phases with team_barrier, and get a one-shot health snapshot with team_status.'
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
      + 'If you type text instead of calling team_send, your peer will NEVER receive the message.',
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
          duplicate: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; msgId: string; to: string; replyTo?: string; duplicate?: boolean; error?: string }
        if (v.duplicate) return [{ type: 'text' as const, text: `Duplicate suppressed — an identical message to ${v.to} was already sent recently.` }]
        if (!v.ok) return [{ type: 'text' as const, text: `Failed to send to ${v.to}: ${v.error ?? 'unknown error'}` }]
        const extra = v.replyTo ? ` (reply to ${v.replyTo})` : ''
        return [{ type: 'text' as const, text: `Message ${v.msgId} sent to ${v.to}${extra}.` }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_send: no agent context')
      const from = agent.session.id
      const cwd = teamCwd(agent)
      const target = assertSafeTeamId(args.target, 'team_send target')
      const msgId = randomUUID()

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
          return { ok: true, msgId, to: target, duplicate: true, ...args.reply_to ? { replyTo: args.reply_to } : {} }
        }

        const record: TeamMessage = {
          msgId,
          from,
          ts: new Date().toISOString(),
          message: args.message,
          read: false,
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
                  const msg: TeamMessage = JSON.parse(line)
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
              content: [{ type: 'text', text: `!!! TEAM MESSAGE from ${from} (msgId: ${msgId}): ${args.message}\n\nYOU MUST CALL team_send(target: "${from}", reply_to: "${msgId}", message: "your complete response") RIGHT NOW. Do NOT type text. Do NOT call team_inbox. Do NOT describe. Just CALL team_send.` }]
            }
          })
          const req = httpRequest({
            hostname: '127.0.0.1',
            port: SERVER_PORT,
            path: '/api/session.prompt',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          }, (res: any) => { res.resume() })
          req.on('error', () => { /* best-effort */ })
          req.write(postData)
          req.end()
          }
        } catch { /* best-effort */ }

        return { ok: true, msgId, to: target, ...args.reply_to ? { replyTo: args.reply_to } : {} }
      }).then(async (result: { ok: boolean; msgId: string; to: string; replyTo?: string; duplicate?: boolean }) => {
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
    presentCall: args => {
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
        const v = value as { new_count: number; messages: TeamMessage[] }
        if (v.messages.length === 0) {
          return [{ type: 'text' as const, text: v.new_count === 0 ? 'Inbox is empty. No new messages. Call team_send to report your progress to peers.' : `${v.new_count} new message(s), all read.` }]
        }
        const lines = v.messages.map((m: TeamMessage) => {
          const reply = m.replyTo ? ` [reply to ${m.replyTo.slice(0, 8)}…]` : ''
          return `[${m.ts}] ${m.msgId.slice(0, 8)}… from ${m.from}${reply}: ${m.message}`
        })
        lines.push('')
        lines.push('!!! REPLY REQUIRED: You MUST reply to EACH message above using team_send(target: <from>, reply_to: <msgId>, message: <your response>).')
        lines.push('If you need to research first, reply with a SHORT status like "Working on it, will report back" — then research. But you MUST call team_send NOW before doing anything else.')
        lines.push('Do NOT just report to the user. Your teammates are WAITING. Call team_send NOW.')
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
        const messages = showAll
          ? all.filter(m => !m.deleted).map(({ read: _r, deleted: _d, ...rest }) => rest)
          : unread.map(({ read: _r, deleted: _d, ...rest }) => rest)

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
        const v = value as { self: { id: string; cwd: string }; peers: { id: string }[]; hint?: string }
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
      render: (_a: any, v: any) => [{ type: 'text' as const, text: v.next || 'Done.' }],
    },
    execute: (args, exec) => {
      const pass = args.pass as number
      const thought = args.thought as string
      const agent = exec.agent
      if (!agent) throw new Error('think: no agent')
      if (![1, 2, 3, 4].includes(pass)) {
        return Promise.resolve({ recorded: false, next: `Invalid pass ${pass}. Only passes 1, 2, 3, and 4 are valid.` })
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
        // Read existing log, append new entry, rotate if over limit.
        let existing = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : ''
        const lines = existing === '' ? [] : existing.trimEnd().split('\n')
        lines.push(entry)
        // Rotate: keep only the last MAX_THINK_LOG_LINES entries.
        if (lines.length > MAX_THINK_LOG_LINES) {
          existing = lines.slice(-MAX_THINK_LOG_LINES).join('\n') + '\n'
        } else {
          existing = lines.join('\n') + '\n'
        }
        writeFileSync(logFile, existing)
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
          next: `All 4 passes recorded to .team/think.log. Peers can read your reasoning. Now act.`,
        }
      })
    },
    presentCall: (args: any) => ({
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
        const v = value as { entries: { session: string; pass: number; thought: string; ts: string }[]; total: number }
        if (v.entries.length === 0) {
          return [{ type: 'text' as const, text: 'No thinking log entries found.' }]
        }
        const lines = v.entries.map(e =>
          `[${e.ts}] ${e.session.slice(0, 8)}… pass${e.pass}: ${e.thought.slice(0, 200)}${e.thought.length > 200 ? '…' : ''}`
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
            const entry = JSON.parse(line)
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
        },
      },
      render: (_args, value) => {
        const v = value as { broadcastId: string; sentTo: number }
        return [{ type: 'text' as const, text: `Broadcast ${v.broadcastId.slice(0, 8)}… sent to ${v.sentTo} peer(s). Collect replies with team_collect(broadcastId: "${v.broadcastId}").` }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_broadcast: no agent context')
      const peers = peerIds(agent)
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
          ...v.replies.map((r) => `  • ${r.from.slice(0, 8)}…: ${r.message.slice(0, 120)}`),
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
          return `  • [${t.status}]${p} ${t.id.slice(0, 8)}… ${t.title} (${a})${dl}${d}${r}`
        })
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(args, exec): Promise<any> {
      const agent = exec.agent
      if (!agent) throw new Error('team_task: no agent context')
      const file = teamPath(agent, 'tasks.jsonl')
      const now = () => new Date().toISOString()

      switch (args.action) {
        case 'create': {
          const title = String(args.title ?? '').trim()
          if (title.length === 0) throw new Error('team_task create: title is required')
          const priority = args.priority !== undefined ? String(args.priority) as TeamTask['priority'] : undefined
          if (priority !== undefined && !['low', 'normal', 'high', 'urgent'].includes(priority)) {
            throw new Error(`team_task create: invalid priority "${priority}"`)
          }
          const task: TeamTask = {
            id: randomUUID(),
            title,
            ...args.description !== undefined ? { description: String(args.description) } : {},
            ...args.assignee !== undefined ? { assignee: assertSafeTeamId(args.assignee, 'team_task assignee') } : {},
            status: 'todo',
            ...priority !== undefined ? { priority } : {},
            ...args.deadline !== undefined ? { deadline: String(args.deadline) } : {},
            ...Array.isArray(args.deps) && args.deps.length > 0 ? { deps: (args.deps as string[]).map(d => String(d)) } : {},
            createdBy: agent.session.id,
            ts: now(),
            updatedTs: now(),
          }
          return lockedAppend(file, task).then(async () => {
            // Auto-notify the assignee so a task is never silently orphaned on the board.
            if (task.assignee !== undefined && task.assignee !== agent.session.id) {
              try {
                await notifyPeer(agent, task.assignee, `[team_task] New task assigned to you: ${task.title}${task.deadline ? ` (due ${task.deadline})` : ''}${priority ? ` (priority ${priority})` : ''}.\nClaim or update it with team_task(action:"claim"|"update", id:"${task.id}", ...) and report back with team_send(target:"${agent.session.id}").`)
              } catch { /* notification is best-effort; the board is the source of truth */ }
            }
            return { ok: true, tasks: [task] }
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
          const id = String(args.id ?? '')
          if (id.length === 0) throw new Error('team_task claim: id is required')
          return lockedUpdate<TeamTask>(file, (tasks) => {
            const task = tasks.find(t => t.id === id)
            if (task === undefined) throw new Error(`team_task claim: unknown task "${id}"`)
            if (task.assignee !== undefined && task.assignee !== agent.session.id) {
              throw new Error(`team_task claim: task "${id}" is already assigned to ${task.assignee}`)
            }
            if (task.status === 'done') throw new Error(`team_task claim: task "${id}" is already done`)
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
          const id = String(args.id ?? '')
          if (id.length === 0) throw new Error('team_task update: id is required')
          const priority = args.priority !== undefined ? String(args.priority) as TeamTask['priority'] : undefined
          if (priority !== undefined && !['low', 'normal', 'high', 'urgent'].includes(priority)) {
            throw new Error(`team_task update: invalid priority "${priority}"`)
          }
          let notify: { creator: string; title: string; status: TeamTask['status']; result?: string } | undefined
          let reassignTo: string | undefined
          return lockedUpdate<TeamTask>(file, (tasks) => {
            const task = tasks.find(t => t.id === id)
            if (task === undefined) throw new Error(`team_task update: unknown task "${id}"`)
            const previousStatus = task.status
            const previousAssignee = task.assignee
            if (args.status !== undefined) task.status = args.status
            if (args.result !== undefined) task.result = String(args.result)
            if (args.description !== undefined) task.description = String(args.description)
            if (args.assignee !== undefined) task.assignee = assertSafeTeamId(args.assignee, 'team_task assignee')
            if (Array.isArray(args.deps)) task.deps = (args.deps as string[]).map(d => String(d))
            if (priority !== undefined) task.priority = priority
            if (args.deadline !== undefined) task.deadline = String(args.deadline)
            task.updatedTs = now()
            // Notify the creator only on a real transition into a terminal state.
            if ((task.status === 'done' || task.status === 'blocked') && task.status !== previousStatus && task.createdBy !== agent.session.id) {
              notify = { creator: task.createdBy, title: task.title, status: task.status, ...(task.result !== undefined ? { result: task.result } : {}) }
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
          throw new Error(`team_task: unknown action "${args.action}"`)
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Task board: ${args.action}`, kind: 'other' as const }),
  }))

  // ── team_memory (shared durable memory) ────────────────────────────────────
  // The cross-session stand-in for a single conversation's shared transcript:
  // decisions and facts persist so peers never re-derive or re-transmit context.

  ctx.tools.register(defineTool({
    name: 'team_memory',
    description:
      'Shared durable key-value memory (.team/memory.jsonl) visible to every team session. '
      + 'Actions: set (store a fact/decision under a key), get (read the latest value), list (all entries), delete. '
      + 'Use it to persist decisions and facts so peers do not re-derive or re-transmit context.',
    parameters: {
      action: { type: 'string', required: true, enum: ['set', 'get', 'list', 'delete'], description: 'Which memory operation to run.' },
      key: { type: 'string', description: 'Memory key (set/get/delete).' },
      value: { type: 'string', description: 'Value to store (set).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as unknown as { ok: boolean; key?: string; value?: string; entries?: TeamMemoryEntry[] }
        if (v.entries !== undefined) {
          return [{ type: 'text' as const, text: v.entries.length === 0 ? 'No memory entries.' : v.entries.map(e => `  • ${e.key} = ${e.value.slice(0, 160)}`).join('\n') }]
        }
        return [{ type: 'text' as const, text: v.ok ? `${v.key ?? ''} ${v.value !== undefined ? `= ${v.value.slice(0, 160)}` : 'done'}` : `${v.key ?? ''} not found` }]
      },
    },
    execute(args, exec): Promise<any> {
      const agent = exec.agent
      if (!agent) throw new Error('team_memory: no agent context')
      const file = teamPath(agent, 'memory.jsonl')
      const now = () => new Date().toISOString()

      switch (args.action) {
        case 'set': {
          const key = String(args.key ?? '').trim()
          const value = String(args.value ?? '')
          if (key.length === 0) throw new Error('team_memory set: key is required')
          // Append-only: O(1) per set; get/list resolve "latest wins" by tail order.
          return lockedAppend(file, { key, value, updatedBy: agent.session.id, ts: now() })
            .then(() => ({ ok: true, key, value }))
        }
        case 'get': {
          const key = String(args.key ?? '').trim()
          const entry = readJsonl<TeamMemoryEntry>(file).findLast(e => e.key === key)
          return Promise.resolve(entry !== undefined
            ? { ok: true, key, value: entry.value, updatedBy: entry.updatedBy, ts: entry.ts }
            : { ok: false, key })
        }
        case 'list': {
          // Append-only storage: collapse to the latest entry per key.
          const latest = new Map<string, TeamMemoryEntry>()
          for (const e of readJsonl<TeamMemoryEntry>(file)) latest.set(e.key, e)
          return Promise.resolve({ ok: true, entries: [...latest.values()] })
        }
        case 'delete': {
          const key = String(args.key ?? '').trim()
          if (key.length === 0) throw new Error('team_memory delete: key is required')
          return lockedUpdate<TeamMemoryEntry>(file, entries => entries.filter(e => e.key !== key))
            .then(() => ({ ok: true, key }))
        }
        default:
          throw new Error(`team_memory: unknown action "${args.action}"`)
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Team memory: ${args.action}`, kind: 'other' as const }),
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
      const subject = String(args.subject)
      const content = String(args.content)
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
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Request review: ${args.subject}`, kind: 'other' as const }),
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
    execute(args, exec): Promise<any> {
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
      return Promise.resolve({ total: reviews.length, verdicts, pending })
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
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(_args, exec): Promise<any> {
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
      for (const t of readJsonl<TeamTask>(teamPath(agent, 'tasks.jsonl'))) {
        rollup[t.status] = (rollup[t.status] ?? 0) + 1
      }

      return Promise.resolve({ self: agent.session.id, peers, unread, pendingBroadcasts, pendingReviews, tasks: rollup })
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
    execute(args, exec): Promise<any> {
      const agent = exec.agent
      if (!agent) throw new Error('team_barrier: no agent context')
      const name = assertSafeTeamId(String(args.name ?? ''), 'team_barrier name')
      if (name.length === 0) throw new Error('team_barrier: name is required')
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
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Barrier ${args.action}: ${args.name}`, kind: 'other' as const }),
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
      render: (_args: any, value: any) => {
        const v = value as { deleted: string; details: string[]; note: string }
        return [{ type: 'text' as const, text: `Session ${v.deleted} deleted. ${v.details.join('; ')}. ${v.note}` }]
      },
    },
    execute: (args: { sessionId: string }, exec: any) => {
      const agent = exec.agent
      if (!agent) throw new Error('session_delete: no agent context')
      const cwd = teamCwd(agent)
      const sessionId = assertSafeTeamId(args.sessionId, 'session_delete sessionId')
      if (sessionId === agent.session.id) {
        throw new Error('session_delete: refusing to delete the calling session while it is running')
      }

      const results: string[] = []

      // 1. Remove session files from DSH_HOME/sessions/ (scan for correct directory).
      //    The harness resolves its home through resolveDshHome() (`$DSH_HOME` then
      //    `~/.dsh`), so mirror that fallback here: a bare `process.env.DSH_HOME`
      //    read would skip file deletion entirely on a default (unset) launch.
      const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      if (dshHome) {
        const sessionsRoot = join(dshHome, 'sessions')
        if (existsSync(sessionsRoot)) {
          let found = false
          for (const projectDir of readdirSync(sessionsRoot)) {
            const projectPath = join(sessionsRoot, projectDir)
            if (!existsSync(projectPath)) continue
            for (const entry of readdirSync(projectPath)) {
              const sessionPath = join(projectPath, entry)
              // Check if this directory contains a session log for our sessionId
              const jsonlPath = join(sessionPath, 'session.jsonl')
              const zstdPath = join(sessionPath, 'session.jsonl.zstd')
              if (existsSync(jsonlPath)) {
                try {
                  const firstLine = (readFileSync(jsonlPath, 'utf-8').split('\n')[0] ?? '') as string
                  const header = JSON.parse(firstLine)
                  if (header.id === sessionId) {
                    rmSync(sessionPath, { recursive: true, force: true })
                    results.push(`Removed session directory: ${sessionPath}`)
                    found = true
                    break
                  }
                } catch { /* skip unparsable */ }
              }
              // zstd artifacts cannot be header-read without decompression, so
              // only delete when the directory name itself matches the target id.
              if (!found && existsSync(zstdPath) && entry === sessionId) {
                rmSync(sessionPath, { recursive: true, force: true })
                results.push(`Removed session directory (zstd): ${sessionPath}`)
                found = true
                break
              }
            }
            if (found) break
          }
          if (!found) {
            results.push(`Session directory not found for: ${sessionId}`)
          }
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

      return Promise.resolve({
        deleted: sessionId,
        details: results,
        note: 'Storage caches (workspace.json, session_projcache.json) will be cleaned on next server restart. The session is now fully deleted from disk.',
      })
    },
    presentCall: (args: any) => ({
      card: 'generic' as const,
      title: `Delete session ${args.sessionId}`,
      kind: 'delete' as const,
    }),
  }))
}