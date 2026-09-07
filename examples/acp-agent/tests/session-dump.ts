import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

/**
 * ACP failures surface only as timeouts — the harness internals stay silent
 * inside the subprocess. Dump the tail of the session's event log so a CI log
 * on its own distinguishes a rate-limited model (429 retry bursts) from a
 * model that never performs the expected escalation/acceptance move.
 * @param sessionId - ACP session id whose log tail is printed.
 * @param lines - number of trailing JSONL lines to print; defaults to 30.
 */
export async function dumpSessionTail(sessionId: string, lines = 30): Promise<void> {
  try {
    const dir = join(homedir(), '.dsh', 'sessions')
    const files = await readdir(dir)
    const match = files.find(f => f.includes(sessionId))
    if (match === undefined) {
      console.error(`[session-dump] no session log found for ${sessionId} under ${dir}`)
      return
    }
    const text = await readFile(join(dir, match), 'utf8')
    const tail = text.trimEnd().split('\n').slice(-lines)
    console.error(`[session-dump] ===== tail of ${match} (last ${tail.length} events) =====`)
    for (const line of tail) console.error(`[session-dump] ${line.slice(0, 4_000)}`)
  } catch (error) {
    console.error(`[session-dump] failed to dump ${sessionId}: ${String(error)}`)
  }
}
