/**
 * Audit event types and helpers for collaboration replay.
 *
 * Extracted from index.ts for module separation.
 *
 * @module @deepseek-ai/dsh-team-comm/audit
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd, readJsonl } from './shared'

/** F9: One unified event from the merged team logs. */
export interface AuditEvent {
  ts: string
  source: string
  action: string
  session?: string
  payload: unknown
}

/** F9: Read all .team/*.jsonl files and merge into a unified event stream. */
export function readAllAuditEvents(agent: { session: { id: string; header?: { cwd?: string } } }): AuditEvent[] {
  const teamDir = join(teamCwd(agent), TEAM_DIR)
  const events: AuditEvent[] = []
  if (!existsSync(teamDir)) return events

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

  events.sort((a, b) => a.ts.localeCompare(b.ts))
  return events
}
