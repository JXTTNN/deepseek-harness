/**
 * Durable approval mechanism for team-comm.
 *
 * Provides a file-system-backed approval ledger that supports four approval
 * boundaries (plan, task_round, task_dispatch, tool_call) with SHA-256 content
 * hash binding and first-decision-wins atomic semantics.
 *
 * Each approval request is stored as a JSON file in `.team/approvals/<id>.json`.
 * Atomicity is achieved through file locks (`.lock` sibling files with `wx`
 * exclusive-create semantics), mirroring the pattern used throughout team-comm.
 *
 * @module @deepseek-ai/dsh-team-comm/approval/durable
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sub-directory under `.team/` that holds approval record files. */
const APPROVALS_SUBDIR = 'approvals'

/** A `.lock` file older than this (ms) is treated as orphaned and broken. */
const FILE_LOCK_STALE_MS = 10_000

/** How often a lock holder refreshes its lock's mtime. */
const FILE_LOCK_HEARTBEAT_MS = 2_000

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** The four approval boundaries supported by the durable approval mechanism. */
export type ApprovalScope = 'plan' | 'task_round' | 'task_dispatch' | 'tool_call'

/** The two possible decisions an approver can make. */
export type ApprovalDecision = 'approved' | 'rejected'

/** A snapshot of a task at the time an approval request is created. */
export interface TaskSnapshot {
  id: string
  title: string
  description: string
  status: string
  createdAt: string
  updatedAt: string
}

/** The content payload of an approval request, varying by scope. */
export interface ApprovalRequestContent {
  kind: ApprovalScope
  // plan
  continuation?: 'execute' | 'plan_only'
  tasks?: TaskSnapshot[]
  // task_round
  completedTasks?: TaskSnapshot[]
  nextTasks?: TaskSnapshot[]
  // task_dispatch
  task?: TaskSnapshot
  // tool_call
  toolName?: string
  rawInput?: Record<string, unknown>
  input?: Record<string, unknown>
  agentName?: string
  taskId?: string
  toolCallId?: string
  consequential?: boolean
}

/** A durable, content-addressed approval request. */
export interface DurableApprovalRequest {
  version: 1
  id: string // apr_ + SHA-256 first 32 chars
  runId: string
  scope: ApprovalScope
  boundary: string
  requestHash: string // SHA-256
  requestedAt: string // ISO timestamp
  reason?: string
  content: ApprovalRequestContent
}

/** Identifies who reviewed an approval request. */
export interface ApprovalReviewer {
  id: string
  displayName?: string
}

/** Input for recording an approval decision. */
export interface ApprovalDecisionInput {
  requestId: string
  requestHash: string
  decision: 'approve' | 'reject'
  reviewer: ApprovalReviewer
}

/** A recorded approval decision, bound to the original request by hash. */
export interface ApprovalDecisionRecord {
  version: 1
  requestId: string
  runId: string
  scope: ApprovalScope
  requestHash: string
  decision: ApprovalDecision
  reviewer: ApprovalReviewer
  decidedAt: string
}

/** The full record of an approval request, optionally with its decision. */
export interface ApprovalRecord {
  version: 1
  request: DurableApprovalRequest
  decision?: ApprovalDecisionRecord
}

/** Input for creating a new approval request. */
export interface CreateApprovalRequestInput {
  runId: string
  scope: ApprovalScope
  boundary: string
  reason?: string
  content: ApprovalRequestContent
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Error codes specific to the durable approval mechanism. */
export type DurableApprovalErrorCode =
  | 'APPROVAL_ATOMIC_STORE_REQUIRED'
  | 'APPROVAL_CONFLICT'
  | 'APPROVAL_INTEGRITY_ERROR'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_STALE_DECISION'
  | 'APPROVAL_VALIDATION_ERROR'

/** Error thrown by the durable approval mechanism. */
export class DurableApprovalError extends Error {
  readonly code: DurableApprovalErrorCode

  constructor(code: DurableApprovalErrorCode, message: string) {
    super(message)
    this.name = 'DurableApprovalError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve after `ms` milliseconds (async, non-blocking). */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Serialize a critical section for a shared file across PROCESSES using a
 * `.lock` sibling file with `wx` (atomic exclusive create). Orphaned locks
 * (crashed process) are broken once they outlive `FILE_LOCK_STALE_MS`.
 *
 * This mirrors the `withFileLock` pattern used in team-comm's main module.
 */
function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  return withApprovalLock(file, async () => {
    mkdirSync(dirname(file), { recursive: true })
    const lockPath = `${file}.lock`

    // Acquire the lock, breaking it ONLY when it is provably stale (orphaned).
    for (;;) {
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') throw err
        // Another process holds it. Break it only if it is orphaned.
        let stale = false
        try {
          stale = Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS
        } catch { /* lock vanished; retry acquisition */ }
        if (stale) {
          try { rmSync(lockPath, { force: true }) } catch { /* lost a race; loop again */ }
          continue
        }
        await sleep(10 + Math.floor(Math.random() * 20))
      }
    }

    let heartbeat: NodeJS.Timeout | undefined
    const touch = (): void => {
      try { utimesSync(lockPath, new Date(), new Date()) } catch { /* vanished */ }
    }

    try {
      heartbeat = setInterval(touch, FILE_LOCK_HEARTBEAT_MS)
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

/** Per-file in-process serialization map for approval operations. */
const approvalLocks = new Map<string, Promise<void>>()

/** Run `fn` exclusively for one approval file within this process. */
function withApprovalLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = approvalLocks.get(file) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(() => undefined, () => undefined)
  approvalLocks.set(file, tail)
  void tail.then(() => { if (approvalLocks.get(file) === tail) approvalLocks.delete(file) })
  return run
}

/**
 * Produce a canonical, deterministic JSON string from any JSON-compatible
 * value. Object keys are sorted; cycles, non-plain prototypes, `undefined`
 * fields, and non-finite numbers are rejected. This ensures that the same
 * logical content always produces the same hash.
 */
function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval content contains a non-finite number.')
      }
      return JSON.stringify(value)
    case 'object': {
      const object = value as object
      if (seen.has(object)) {
        throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval content contains a cycle.')
      }
      seen.add(object)
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => stableJson(item, seen)).join(',')}]`
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval content must contain only JSON-compatible plain objects.')
        }
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        const fields = keys.map((key) => {
          const item = record[key]
          if (item === undefined) {
            throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval content field "${key}" is undefined.`)
          }
          return `${JSON.stringify(key)}:${stableJson(item, seen)}`
        })
        return `{${fields.join(',')}}`
      } finally {
        seen.delete(object)
      }
    }
    default:
      throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval content contains unsupported ${typeof value} data.`)
  }
}

/** Compute the SHA-256 hash of a string, returning the hex digest. */
function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/** Resolve the approvals directory path under a given `.team/` directory. */
function approvalsDir(teamDir: string): string {
  return join(teamDir, APPROVALS_SUBDIR)
}

/** Resolve the file path for a single approval record. */
function approvalFile(teamDir: string, requestId: string): string {
  // Reject path separators and traversal attempts in the request ID.
  if (/[\\/]/.test(requestId) || requestId === '.' || requestId === '..' || requestId.includes('\0')) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Invalid request ID: "${requestId}"`)
  }
  return join(approvalsDir(teamDir), `${requestId}.json`)
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 content hash for an approval request.
 *
 * The hash is computed over the canonical JSON of `{ scope, boundary, content }`,
 * ensuring that any tampering with the request content produces a different
 * hash and is detectable.
 */
export function hashApprovalRequest(
  scope: ApprovalScope,
  boundary: string,
  content: ApprovalRequestContent,
): string {
  const canonical = stableJson({ scope, boundary, content })
  return sha256(canonical)
}

/**
 * Create a `DurableApprovalRequest` from the given input, computing its deterministic
 * ID and content hash.
 *
 * The ID is `apr_` followed by the first 32 characters of the SHA-256 hash of
 * `{ scope, boundary, content }`. The `requestHash` is the full 64-character
 * hex digest of the same hash.
 */
export function createApprovalRequest(input: CreateApprovalRequestInput): DurableApprovalRequest {
  const requestHash = hashApprovalRequest(input.scope, input.boundary, input.content)
  const id = `apr_${requestHash.slice(0, 32)}`
  return {
    version: 1,
    id,
    runId: input.runId,
    scope: input.scope,
    boundary: input.boundary,
    requestHash,
    requestedAt: new Date().toISOString(),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    content: input.content,
  }
}

/**
 * Assert that `value` is a valid `DurableApprovalRequest`. Throws
 * `DurableApprovalError` with `APPROVAL_VALIDATION_ERROR` if the shape is
 * incorrect, or `APPROVAL_INTEGRITY_ERROR` if the `requestHash` does not
 * match the recomputed hash.
 */
export function assertApprovalRequest(value: unknown): asserts value is DurableApprovalRequest {
  if (typeof value !== 'object' || value === null) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval request must be an object.')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval request version must be 1, got ${String(record.version)}.`)
  }
  if (typeof record.id !== 'string' || !record.id.startsWith('apr_')) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval request id must start with "apr_", got ${String(record.id)}.`)
  }
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval request runId must be a non-empty string.')
  }
  if (typeof record.scope !== 'string' || !['plan', 'task_round', 'task_dispatch', 'tool_call'].includes(record.scope)) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval request scope must be one of plan|task_round|task_dispatch|tool_call, got ${String(record.scope)}.`)
  }
  if (typeof record.boundary !== 'string' || record.boundary.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval request boundary must be a non-empty string.')
  }
  if (typeof record.requestHash !== 'string' || record.requestHash.length !== 64) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval request requestHash must be a 64-char hex string, got ${String(record.requestHash)}.`)
  }
  if (typeof record.requestedAt !== 'string' || record.requestedAt.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval request requestedAt must be a non-empty string.')
  }
  if (typeof record.content !== 'object' || record.content === null) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval request content must be an object.')
  }
  // Integrity check: recompute the hash and compare.
  const recomputed = hashApprovalRequest(
    record.scope as ApprovalScope,
    record.boundary as string,
    record.content as ApprovalRequestContent,
  )
  if (recomputed !== record.requestHash) {
    throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', `Approval request hash mismatch: expected ${recomputed}, got ${record.requestHash}.`)
  }
}

/**
 * Assert that `value` is a valid `ApprovalDecisionRecord`. Throws
 * `DurableApprovalError` if the shape is incorrect. If `request` is provided,
 * also verifies that the decision's `requestHash` matches the request's hash
 * and that the `requestId` matches.
 */
export function assertApprovalDecision(
  value: unknown,
  request?: DurableApprovalRequest,
): asserts value is ApprovalDecisionRecord {
  if (typeof value !== 'object' || value === null) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval decision must be an object.')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval decision version must be 1, got ${String(record.version)}.`)
  }
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval decision requestId must be a non-empty string.')
  }
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval decision runId must be a non-empty string.')
  }
  if (typeof record.scope !== 'string' || !['plan', 'task_round', 'task_dispatch', 'tool_call'].includes(record.scope)) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval decision scope must be one of plan|task_round|task_dispatch|tool_call, got ${String(record.scope)}.`)
  }
  if (typeof record.requestHash !== 'string' || record.requestHash.length !== 64) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval decision requestHash must be a 64-char hex string, got ${String(record.requestHash)}.`)
  }
  if (typeof record.decision !== 'string' || !['approved', 'rejected'].includes(record.decision)) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', `Approval decision must be "approved" or "rejected", got ${String(record.decision)}.`)
  }
  if (typeof record.reviewer !== 'object' || record.reviewer === null) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval decision reviewer must be an object.')
  }
  const reviewer = record.reviewer as Record<string, unknown>
  if (typeof reviewer.id !== 'string' || reviewer.id.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval decision reviewer.id must be a non-empty string.')
  }
  if (typeof record.decidedAt !== 'string' || record.decidedAt.length === 0) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR', 'Approval decision decidedAt must be a non-empty string.')
  }
  // Cross-check against the request if provided.
  if (request) {
    if (record.requestId !== request.id) {
      throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', `Decision requestId (${record.requestId}) does not match request id (${request.id}).`)
    }
    if (record.requestHash !== request.requestHash) {
      throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', `Decision requestHash does not match request hash.`)
    }
  }
}

/**
 * Type guard: returns `true` if `value` is a valid `DurableApprovalRequest`.
 * Unlike `assertApprovalRequest`, this does not throw — it returns a boolean.
 */
export function isApprovalRequest(value: unknown): value is DurableApprovalRequest {
  try {
    assertApprovalRequest(value)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// DurableApprovalLedger — file-system-backed approval store
// ---------------------------------------------------------------------------

/**
 * A durable, file-system-backed ledger for approval requests and decisions.
 *
 * Each approval request is stored as a JSON file at
 * `.team/approvals/<requestId>.json`. The ledger guarantees:
 *
 * - **Idempotent request creation**: `ensureRequest` is atomic — if a request
 *   with the same ID already exists, the existing record is returned without
 *   modification.
 * - **First-decision-wins**: `decide` atomically checks for an existing
 *   decision and only records a new one if none exists. A second call with a
 *   different decision returns `APPROVAL_STALE_DECISION`.
 * - **Content integrity**: every request carries a SHA-256 `requestHash` that
 *   is verified on read, detecting tampering.
 */
export class DurableApprovalLedger {
  private readonly teamDir: string
  private readonly dir: string

  /**
   * @param teamDir The `.team/` directory path. Approval files are stored
   *   under `<teamDir>/approvals/`.
   */
  constructor(teamDir: string) {
    this.teamDir = teamDir
    this.dir = approvalsDir(teamDir)
  }

  /**
   * Ensure that an approval request exists in the ledger. If a record with the
   * same `request.id` already exists, return the existing record (idempotent).
   * Otherwise, create a new file atomically.
   *
   * @throws {DurableApprovalError} with code `APPROVAL_CONFLICT` if an existing
   *   record has the same ID but different content (hash mismatch).
   */
  async ensureRequest(request: DurableApprovalRequest): Promise<ApprovalRecord> {
    // Validate the request before storing.
    assertApprovalRequest(request)

    const filePath = approvalFile(this.teamDir, request.id)

    return withFileLock(filePath, () => {
      mkdirSync(this.dir, { recursive: true })

      if (existsSync(filePath)) {
        // Request already exists — return the stored record.
        const raw = readFileSync(filePath, 'utf8')
        const existing = JSON.parse(raw) as ApprovalRecord
        // Verify integrity of the stored request.
        assertApprovalRequest(existing.request)
        // If the existing request has a different hash, it's a conflict.
        if (existing.request.requestHash !== request.requestHash) {
          throw new DurableApprovalError(
            'APPROVAL_CONFLICT',
            `Approval request ${request.id} already exists with a different content hash.`,
          )
        }
        return existing
      }

      // Create a new record file atomically.
      const record: ApprovalRecord = {
        version: 1,
        request,
      }
      writeFileSync(filePath, JSON.stringify(record, null, 2), { flag: 'wx' })
      return record
    })
  }

  /**
   * Retrieve an approval record by its request ID.
   *
   * @returns The `ApprovalRecord`, or `null` if no record exists with the
   *   given ID.
   * @throws {DurableApprovalError} with code `APPROVAL_INTEGRITY_ERROR` if the
   *   stored record's content hash does not match the recomputed hash.
   */
  async get(requestId: string): Promise<ApprovalRecord | null> {
    const filePath = approvalFile(this.teamDir, requestId)

    if (!existsSync(filePath)) {
      return null
    }

    const raw = readFileSync(filePath, 'utf8')
    const record = JSON.parse(raw) as ApprovalRecord

    // Verify request integrity.
    assertApprovalRequest(record.request)

    // Verify decision integrity if present.
    if (record.decision) {
      assertApprovalDecision(record.decision, record.request)
    }

    return record
  }

  /**
   * Record an approval decision for a request. Implements first-decision-wins
   * semantics: if a decision already exists for the request, it is returned
   * unchanged and the new decision is rejected with `APPROVAL_STALE_DECISION`.
   *
   * @throws {DurableApprovalError} with code `APPROVAL_NOT_FOUND` if the
   *   request does not exist.
   * @throws {DurableApprovalError} with code `APPROVAL_INTEGRITY_ERROR` if the
   *   provided `requestHash` does not match the stored request's hash.
   * @throws {DurableApprovalError} with code `APPROVAL_STALE_DECISION` if a
   *   decision already exists and differs from the new one.
   */
  async decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionRecord> {
    const filePath = approvalFile(this.teamDir, input.requestId)

    return withFileLock(filePath, async () => {
      if (!existsSync(filePath)) {
        throw new DurableApprovalError(
          'APPROVAL_NOT_FOUND',
          `Approval request ${input.requestId} not found.`,
        )
      }

      const raw = readFileSync(filePath, 'utf8')
      const record = JSON.parse(raw) as ApprovalRecord

      // Verify request integrity.
      assertApprovalRequest(record.request)

      // Verify the input hash matches the stored request hash.
      if (input.requestHash !== record.request.requestHash) {
        throw new DurableApprovalError(
          'APPROVAL_INTEGRITY_ERROR',
          `Decision requestHash does not match stored request hash for ${input.requestId}.`,
        )
      }

      // First-decision-wins: if a decision already exists, return it.
      if (record.decision) {
        // If the existing decision matches the new one, return it (idempotent).
        if (record.decision.decision === (input.decision === 'approve' ? 'approved' : 'rejected')) {
          return record.decision
        }
        // A different decision already exists — stale decision.
        throw new DurableApprovalError(
          'APPROVAL_STALE_DECISION',
          `Approval request ${input.requestId} already has a decision (${record.decision.decision}).`,
        )
      }

      // Record the new decision.
      const decisionRecord: ApprovalDecisionRecord = {
        version: 1,
        requestId: record.request.id,
        runId: record.request.runId,
        scope: record.request.scope,
        requestHash: record.request.requestHash,
        decision: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewer: input.reviewer,
        decidedAt: new Date().toISOString(),
      }

      // Validate the decision before writing.
      assertApprovalDecision(decisionRecord, record.request)

      const updatedRecord: ApprovalRecord = {
        version: 1,
        request: record.request,
        decision: decisionRecord,
      }

      writeFileSync(filePath, JSON.stringify(updatedRecord, null, 2))

      return decisionRecord
    })
  }

  /**
   * List all approval records in the ledger, sorted by `requestedAt`
   * ascending.
   */
  async list(): Promise<ApprovalRecord[]> {
    if (!existsSync(this.dir)) {
      return []
    }

    const entries = readdirSync(this.dir)
    const records: ApprovalRecord[] = []

    for (const entry of entries) {
      // Skip lock files and non-JSON files.
      if (!entry.endsWith('.json')) continue
      const filePath = join(this.dir, entry)
      try {
        const raw = readFileSync(filePath, 'utf8')
        const record = JSON.parse(raw) as ApprovalRecord
        // Verify integrity; skip corrupted records silently.
        assertApprovalRequest(record.request)
        if (record.decision) {
          assertApprovalDecision(record.decision, record.request)
        }
        records.push(record)
      } catch {
        // Skip files that fail validation (corrupted or partial writes).
      }
    }

    // Sort by requestedAt ascending (oldest first).
    records.sort((a, b) => a.request.requestedAt.localeCompare(b.request.requestedAt))

    return records
  }
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

/**
 * Retrieve an approval record by its request ID, using a transient
 * `DurableApprovalLedger` instance.
 */
export async function getApprovalRecord(
  teamDir: string,
  requestId: string,
): Promise<ApprovalRecord | null> {
  const ledger = new DurableApprovalLedger(teamDir)
  return ledger.get(requestId)
}

/**
 * Record an approval decision, using a transient `DurableApprovalLedger`
 * instance.
 */
export async function decideApproval(
  teamDir: string,
  input: ApprovalDecisionInput,
): Promise<ApprovalDecisionRecord> {
  const ledger = new DurableApprovalLedger(teamDir)
  return ledger.decide(input)
}