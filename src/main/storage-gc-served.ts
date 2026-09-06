import { readdirSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { safeSegment, sessionSegment } from './session-sandbox'
import type { GcCandidate } from './storage-gc'
import { measureTree } from './storage-gc-tree'

/**
 * SERVED SESSIONS — the sandbox that outlives its session.
 *
 * A served caller's crew runs in `~/.cookrew/sessions/<service>/<session>`:
 * that directory is the crew's HOME and cwd, Seatbelt lets it write nowhere
 * else, and the harness fills it with its own state (a plugin marketplace
 * clone alone is ~6 MB). END removes it (session-instantiator.ts, design S4).
 * The app dying does not: the session table is memory-only by design
 * (served-persist.ts — "on reboot a caller starts a fresh session"), so every
 * restart turns each open sandbox into one nothing will ever read again.
 * Measured 2026-09-06: 43 such sandboxes, 83 MB, all ended.
 *
 * The rule is the planner's usual one with its own live set: a sandbox is live
 * iff its session is OPEN in the running instantiator, and an ended sandbox is
 * collected once its newest write is past the grace period. What is different
 * is where the live set comes from — it is a fact of the running app, handed
 * in as data, never inferred from disk — and what "unknown" means: a sweep
 * that was not told which sessions are open plans nothing for this class.
 */

/**
 * The candidate key for one session, `<service dir>/<session dir>`, spelled
 * by the same rule `sandboxRoot` uses to create the directory. index.ts calls
 * this for each open session so the scan's readdir names match it exactly; a
 * second spelling of the rule is how a sweep deletes an open sandbox.
 */
export function servedSessionKey(serviceId: string, sessionId: string): string {
  return `${safeSegment(serviceId)}/${sessionSegment(serviceId, sessionId)}`
}

const readDir = (dir: string): Dirent[] | 'missing' | 'unreadable' => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

/**
 * Every served-session sandbox under `sessionsRoot`, one candidate per
 * depth-2 directory. A missing root answers empty (nothing was ever served);
 * a root or service directory that exists but cannot be read answers NULL,
 * which the planner reads as "abort the class" — a store you cannot see is
 * not a store with nothing in it.
 *
 * Only real directories qualify. A file or a symlink at either depth is
 * skipped, and the service directory itself is never a candidate, so the
 * remover's `rm -rf` can only ever land on a session's own sandbox.
 */
export function servedSessionCandidates(sessionsRoot: string): GcCandidate[] | null {
  const services = readDir(sessionsRoot)
  if (services === 'missing') return []
  if (services === 'unreadable') return null
  const out: GcCandidate[] = []
  for (const service of services) {
    if (!service.isDirectory()) continue
    const serviceDir = path.join(sessionsRoot, service.name)
    const sessions = readDir(serviceDir)
    if (sessions === 'missing') continue
    if (sessions === 'unreadable') return null
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(serviceDir, session.name)
      let measured
      try {
        measured = measureTree(dir)
      } catch {
        // Gone between readdir and stat: an END raced us. Nothing to plan.
        continue
      }
      out.push({
        key: `${service.name}/${session.name}`,
        path: dir,
        bytes: measured.bytes,
        mtimeMs: measured.newestMtimeMs
      })
    }
  }
  return out
}
