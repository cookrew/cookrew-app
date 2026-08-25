// Which Claude sessions another live process is already holding.
//
// WHY THIS EXISTS
// ---------------
// `claude --resume <id>` refuses when something else has that session open:
//
//   Error: Session 427aa2f7-… is currently running as a background agent (bg).
//   Use `claude agents` to find and attach to it, or add --fork-session to
//   branch off a copy.
//
// It prints that one line and exits. Cookrew's recover path had no idea: the
// session FILE existed, so the exact-context gate passed, the pty spawned, and
// the card reported READY / LIVE over a black void. Observed on Forge, whose
// session was held by a `claude bg-spare` process (pid 92878) left over from a
// finished background job — recovery "succeeded" every time and never worked.
//
// WHERE THE ANSWER LIVES
// ----------------------
// Claude writes ~/.claude/sessions/<pid>.json for each live process, carrying
// that process's sessionId. The filename IS the pid, so liveness is a signal-0
// check and only live processes are ever read. Measured here: 0.81 ms across
// 133 files with 8 live holders.
//
// That matters. The obvious source is `claude agents --json`, and forking it
// cost 1.18 s of BLOCKED Electron main thread — the app-wide stall that made
// the whole UI feel broken. A spawn-time check has to be free, and this is.
//
// SCOPE — reads a directory and builds a command string. It spawns nothing.

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Where Claude records one file per live process. */
export function defaultSessionsDir(): string {
  return path.join(homedir(), '.claude', 'sessions')
}

/** What a holder is, reduced to what the decision needs. */
export interface SessionHolder {
  pid: number
  sessionId: string
  /** 'bg' for a background agent/spare, 'interactive' for a real terminal. */
  kind: string
}

export interface LiveSessionFs {
  /** Names in the sessions directory; may throw when it does not exist. */
  list: (dir: string) => string[]
  read: (file: string) => string
  /** True when this pid is still running. */
  alive: (pid: number) => boolean
}

function defaultFs(): LiveSessionFs {
  return {
    list: (dir) => readdirSync(dir),
    read: (file) => readFileSync(file, 'utf8'),
    alive: (pid) => {
      try {
        // Signal 0 tests for existence without touching the process.
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM means it exists and belongs to someone else — still alive.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
  }
}

/**
 * Every session a LIVE claude process currently holds.
 *
 * Never throws: a missing directory, an unreadable file or a half-written
 * one means "cannot tell", and the caller must then behave exactly as it did
 * before this check existed rather than fail a recovery over a bad read.
 */
export function liveSessionHolders(
  sessionsDir: string = defaultSessionsDir(),
  fs: LiveSessionFs = defaultFs()
): SessionHolder[] {
  let names: string[]
  try {
    names = fs.list(sessionsDir)
  } catch {
    return []
  }
  const holders: SessionHolder[] = []
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    // Liveness BEFORE the read: a stale file from a process that exited is
    // the common case here, and reading them all is the only real cost.
    if (!fs.alive(pid)) continue
    try {
      const record: unknown = JSON.parse(fs.read(path.join(sessionsDir, name)))
      if (!record || typeof record !== 'object') continue
      const { sessionId, kind } = record as { sessionId?: unknown; kind?: unknown }
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue
      holders.push({ pid, sessionId, kind: typeof kind === 'string' ? kind : 'unknown' })
    } catch {
      // Unparseable or vanished mid-read — treat as no claim.
    }
  }
  return holders
}

/**
 * The holder of `sessionId` OTHER than `selfPid`, or null when it is free.
 *
 * Excluding our own pid matters on an app restart: a pane whose claude is
 * still alive holds its own session, and treating that as a foreign claim
 * would fork a conversation that was never in trouble.
 */
export function holderOf(
  sessionId: string,
  holders: readonly SessionHolder[],
  selfPid?: number
): SessionHolder | null {
  return (
    holders.find((holder) => holder.sessionId === sessionId && holder.pid !== selfPid) ?? null
  )
}

/**
 * Only a BACKGROUND holder justifies forking.
 *
 * An interactive holder is a real terminal someone can reach — very often
 * this node's OWN pane, which survives an app restart and keeps holding its
 * session while tmux reattaches it. Forking on that would split a live
 * conversation in two on every restart, for a terminal that was never in
 * trouble. A background agent is the opposite case: no pane to attach to, and
 * the only thing that ever made `--resume` refuse here.
 */
export function blocksResume(holder: SessionHolder | null): boolean {
  return holder !== null && holder.kind === 'bg'
}

export interface ForkPlan {
  /** The command to actually launch. */
  command: string
  /**
   * The id the copy will be written under, or null when nothing was held and
   * the session resumed as itself.
   */
  forkedTo: string | null
}

/**
 * Launch plan for a session that may be held by someone else.
 *
 * A fork is not a lesser recovery: it starts from a COPY of the whole
 * transcript, so the agent comes back knowing everything it knew. Only the
 * session id changes.
 *
 * WE MINT THAT ID. `--fork-session` alone lets claude choose one, which left
 * the node still pointing at the held original — so the checkpoint rail read a
 * file that would never grow again, and the NEXT boot forked all over again,
 * stacking up a 4.4 MB copy of the same conversation every restart. Claude
 * accepts `--resume <old> --fork-session --session-id <new>` (verified), so
 * the caller can bind the copy the moment it launches, put the original on the
 * lineage, and never fork twice for the same reason.
 *
 * No fork when the command is not a resume (nothing to branch from), when it
 * already forks, or when nothing holds the session.
 */
export function planHeldSessionFork(
  command: string,
  sessionId: string,
  holders: readonly SessionHolder[],
  mintSessionId: () => string,
  selfPid?: number
): ForkPlan {
  const asIs: ForkPlan = { command, forkedTo: null }
  if (!command.includes('--resume')) return asIs
  if (/(^|\s)--fork-session(\s|$)/.test(command)) return asIs
  if (!blocksResume(holderOf(sessionId, holders, selfPid))) return asIs
  const forkedTo = mintSessionId()
  return { command: `${command} --fork-session --session-id ${forkedTo}`, forkedTo }
}

/** Claude's own refusal, as it appears in a pane. */
export function isSessionHeldError(output: string): boolean {
  return /is currently running as a (background agent|terminal)/i.test(output)
}
