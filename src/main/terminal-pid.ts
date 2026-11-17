import type { ProcessFact } from './process-facts'

/**
 * A TERMINAL'S ROOT PROCESS, NAMED BEFORE IT IS SIGNALLED.
 *
 * A pid is a number the OS hands out again. Windows reuses them within
 * seconds, and a pane's process that exits between the look and the signal
 * leaves its number to whoever starts next. So a pid is only ever signalled
 * once its START TIME has been read: that is what tells this process from a
 * later one on the same number. Where nothing can read it (Windows, which has
 * no POSIX ps; a ps that timed out; a pid remembered without one) the process
 * is looked at and never signalled, and the pane's end goes unconfirmed rather
 * than risk ending a stranger's.
 */

export interface RememberedPid {
  readonly pid: number
  /** Its start time when it was remembered, or null when none could be read. */
  readonly started: string | null
}

export interface TerminalPidDeps {
  /** The pid an earlier end left running, if any. */
  readonly remembered: () => RememberedPid | undefined
  readonly forget: () => void
  /** The pane's root process as the backend names it now. */
  readonly panePid: () => number | null
  readonly fact: (pid: number) => Promise<ProcessFact>
  /** kill(pid, 0): only that the number is taken. */
  readonly taken: (pid: number) => boolean
  readonly kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
}

export interface TerminalPid {
  pid(): Promise<number | null>
  alive(pid: number): Promise<boolean>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  /** The start time the pid was named by; null when it could not be. */
  identity(): string | null
}

/**
 * node-pty's own child, in a DIRECT session (no multiplexer: Windows always).
 * node-pty holds that child itself (a process handle on Windows, the unreaped
 * child on POSIX), so its exit event is about that very process and no other.
 */
export interface OwnChild {
  /** node-pty reported this child's exit. */
  readonly exited: boolean
  /** End it through node-pty (on Windows, its pseudoconsole), naming no pid. */
  terminate(): void
}

/**
 * How a terminal's end is judged and pressed. With an own child: alive until
 * node-pty says it exited, whatever the pid number now holds; pressed through
 * node-pty on Windows, which has no process identity to check a pid against,
 * and through the identity-checked signal elsewhere. Without one (a
 * multiplexer holds the pane): the pid rules above, unchanged.
 */
export function childJudge(
  root: TerminalPid,
  own: OwnChild | null,
  platform: NodeJS.Platform = process.platform
): { alive: (pid: number) => Promise<boolean>; signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => Promise<void> } {
  if (own === null) return { alive: (pid) => root.alive(pid), signal: (pid, signal) => root.signal(pid, signal) }
  return {
    alive: async () => !own.exited,
    signal: async (pid, signal) => {
      if (own.exited) return
      if (platform !== 'win32') return root.signal(pid, signal)
      try {
        own.terminate()
      } catch {
        // node-pty already let go of it: its exit, or the deadline, says what happened.
      }
    }
  }
}

/** A start time that names a process, or null: a ps that printed none ('') named nothing. */
const named = (started: string | null): string | null => (started !== null && started.trim().length > 0 ? started : null)

export function terminalPid(deps: TerminalPidDeps): TerminalPid {
  let identity: string | null = null
  return {
    async pid() {
      const known = deps.remembered()
      const fact = known ? await deps.fact(known.pid) : null
      // Only proof it is over lets it go: a ps that timed out is not that.
      const over = fact?.state === 'gone' || (fact?.state === 'running' && named(known?.started ?? null) !== null && fact.started !== known?.started)
      if (known && !over) {
        identity = named(known.started)
        return known.pid
      }
      deps.forget()
      const pid = deps.panePid()
      if (pid === null) return null
      const now = await deps.fact(pid)
      identity = now.state === 'running' ? named(now.started) : null
      return pid
    },
    async alive(pid) {
      if (!deps.taken(pid)) return false
      const now = await deps.fact(pid)
      if (now.state === 'unknown') return true
      return now.state === 'running' && (identity === null || now.started === identity)
    },
    async signal(pid, signal) {
      if (identity === null) return
      // Read again right before EVERY signal: only the very process that was
      // named, still running, is signalled. No answer, an end, or another
      // start time on the number all mean hands off.
      const now = await deps.fact(pid)
      if (now.state !== 'running' || now.started !== identity) return
      try {
        deps.kill(pid, signal)
      } catch {
        // Gone between the look and the signal: the next poll says so.
      }
    },
    identity: () => identity
  }
}
