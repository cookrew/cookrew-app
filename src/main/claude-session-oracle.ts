// THE CHECKPOINT ⇔ LIVE-TRANSCRIPT INVARIANT, and the one place it is decided.
//
//   For every Claude card whose pane process is alive, the session the card
//   is bound to (claudeSessionId — what the rail, the drawer and every
//   checkpoint are read from) IS the session that process says it is writing.
//
// WHY AN ORACLE
// -------------
// The rail went stale for the third time on 2026-09-05: Conductor's card was
// bound to 5a4cdb91 (a file frozen for 33 hours) while its pane's process
// had been writing f16cf111 the whole time. Every earlier repair inferred the
// move from the DIRECTORY — a successor's head naming its predecessor, a
// replay of its uuids, a continued-in marker at the tail — and each shape has
// a case it cannot see. This one: the successor's head replays the
// predecessor's own compaction pair with the session id rewritten, so the scan
// read it as a file declaring some OTHER predecessor and refused.
//
// Claude itself never had that doubt. Since 2.1.258 it writes
// ~/.claude/sessions/<pid>.json for every live process — `{pid, sessionId,
// cwd, kind, status}` — and keeps `sessionId` current across every rotation
// (measured: process 84516, resumed with 5a4cdb91, reports f16cf111). The
// pane's process pid is the join: herdr's boot script `exec`s the agent, so
// the pane's shell pid IS the claude pid. Inference is the fallback for a
// process that is gone; while it lives, its own statement wins.
//
// SCOPE — pure decisions over facts the caller reads. Reads no files, spawns
// nothing; the holders come from claude-live-session.ts (sub-millisecond) and
// the pane pid from the multiplexer, cached per pane by PanePidCache because
// the herdr lookup is a synchronous child process.

import { isSessionUuid, realCwd } from './claude-fork'
import type { SessionHolder } from './claude-live-session'

/** What the pane's own process says it is writing. */
export interface LiveSessionClaim {
  pid: number
  sessionId: string
}

/**
 * The session the process INSIDE a pane reports, or null when nothing can be
 * said: no pane pid, no record for that pid, a background holder (a pane is
 * never a bg agent), a malformed id, or a record whose cwd is not this
 * terminal's (a pid reused by a process that is not ours).
 */
export function liveSessionOfPane(
  panePid: number | null,
  holders: readonly SessionHolder[],
  cwd: string,
  real: (dir: string) => string = realCwd
): LiveSessionClaim | null {
  if (panePid === null || !Number.isInteger(panePid) || panePid <= 0) return null
  const holder = holders.find((h) => h.pid === panePid)
  if (!holder || holder.kind === 'bg') return null
  if (!isSessionUuid(holder.sessionId)) return null
  if (holder.cwd && real(holder.cwd) !== real(cwd)) return null
  return { pid: holder.pid, sessionId: holder.sessionId }
}

/** What the invariant says to do about a binding, given the oracle's answer. */
export type OracleVerdict =
  /** The process confirms the binding: nothing to scan, nothing to do. */
  | 'agree'
  /** The process writes another session: rebind to it, keep the old on the lineage. */
  | 'rebind'
  /** The live session is another node's: a cross-wire, refused and reported. */
  | 'claimed'
  /** No live statement — fall back to inference from the directory. */
  | 'no-answer'

export function oracleVerdict(
  bound: string,
  live: LiveSessionClaim | null,
  claimed: ReadonlySet<string>
): OracleVerdict {
  if (live === null) return 'no-answer'
  if (live.sessionId === bound) return 'agree'
  if (claimed.has(live.sessionId)) return 'claimed'
  return 'rebind'
}

/** How long a failed pane-pid lookup is believed before asking herdr again. */
export const PANE_PID_MISS_TTL_MS = 25_000

/**
 * Pane pid per terminal, fetched once per pane lifetime.
 *
 * `exec` keeps a pid, so the pid a pane reports never changes while the agent
 * lives; a respawn creates a new pane with a new pid. A cached pid is
 * therefore valid exactly as long as the process is alive, and liveness is a
 * signal-0 check — no hook on spawn or exit is needed to invalidate it.
 */
export class PanePidCache {
  private readonly pids = new Map<string, number>()
  /** Terminals whose lookup answered nothing, with when to ask again. */
  private readonly misses = new Map<string, number>()

  constructor(
    private readonly lookup: (terminalId: string) => number | null,
    private readonly alive: (pid: number) => boolean = processAlive,
    private readonly now: () => number = Date.now,
    private readonly missTtlMs: number = PANE_PID_MISS_TTL_MS
  ) {}

  pidOf(terminalId: string): number | null {
    const cached = this.pids.get(terminalId)
    if (cached !== undefined && this.alive(cached)) return cached
    this.pids.delete(terminalId)
    // A miss is remembered too: a pane that is gone, or a lookup that failed,
    // must not cost a synchronous child process on every sweep until it is
    // cleaned up. Bounded by the TTL so a pane that appears later is found.
    const retryAt = this.misses.get(terminalId)
    if (retryAt !== undefined && retryAt > this.now()) return null
    const pid = this.lookup(terminalId)
    if (pid === null || !this.alive(pid)) {
      this.misses.set(terminalId, this.now() + this.missTtlMs)
      return null
    }
    this.misses.delete(terminalId)
    this.pids.set(terminalId, pid)
    return pid
  }

  /** Whether pidOf() would answer from memory — a live pid or a fresh miss. */
  isWarm(terminalId: string): boolean {
    const cached = this.pids.get(terminalId)
    if (cached !== undefined && this.alive(cached)) return true
    const retryAt = this.misses.get(terminalId)
    return retryAt !== undefined && retryAt > this.now()
  }

  forget(terminalId: string): void {
    this.pids.delete(terminalId)
    this.misses.delete(terminalId)
  }
}

/** Signal 0: exists without touching it; EPERM is alive-but-not-ours. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** How often every live Claude card is checked against its process. */
export const ORACLE_SWEEP_MS = 30_000
/** Spawn-time retries: the record appears once claude has booted. */
export const ORACLE_BOOT_DELAYS_MS = [3_000, 8_000, 20_000]
