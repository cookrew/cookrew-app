// AN OFFLINE AGENT TAKES A PROMPT: THE FIRST KEY WAKES IT.
//
// Owner, 2026-11-01: an agent shown offline could not be prompted. The prompt
// box and the card's reply box type into the agent's terminal, and main woke
// only an agent that THIS run of the app had put to sleep (agent-sleep.ts
// keeps that ledger in memory). Offline for any other reason — the app
// restarted since it slept, its pane was closed, herdr restarted — it had no
// mirror, and every key typed at it vanished without a word.
//
// Now any terminal card without a running mirror is woken by the first thing
// sent to it: booted (a cold agent resumes its own session, a pane herdr still
// holds is only re-attached, a husk herdr restored is booted in place), and the
// keys typed meanwhile wait for it, then
// go in in order. Enter goes in on its own after a pause, as every other
// submit does (ask.ts · submitDelayMs), or the TUI takes the burst for a paste.
//
// index.ts owns what booting, readiness and liveness mean; this file is the
// queue and the one-boot-per-agent rule, so both are testable without a pane.

import { submitDelayMs } from './ask'

export interface WakeDeps<S> {
  /** The terminal's local mirror, when it has one. */
  session: (id: string) => S | undefined
  /** Is this id a terminal card in some workspace? Nothing else can be woken. */
  isTerminal: (id: string) => boolean
  /** Does the multiplexer still hold its pane? Then the boot only re-attaches a running agent. */
  paneAlive: (id: string) => boolean
  /** Boot (or re-attach) the mirror; true when there is a session now. May throw. */
  boot: (id: string) => boolean
  /**
   * Did the boot start the agent at `since` or later? A husk herdr restored
   * is still a pane, so paneAlive called it warm while its agent was only now
   * starting. Absent = only a missing pane counts as a cold start.
   */
  booted?: (id: string, since: number) => boolean
  /** Resolves once a freshly started agent takes input; false at its deadline. */
  ready: (session: S) => Promise<boolean>
  /** The idle-sleep ledger: a wake claims the sleep, a failed boot puts it back. */
  sleep: { take: (id: string) => boolean; mark: (id: string) => void }
  /** Keys that could not be delivered: the agent would not start. */
  lost?: (id: string, chunks: readonly string[]) => void
  pause?: (ms: number) => Promise<void>
  warn?: (message: string) => void
}

const ENTER = '\r'

/** "words\r" → the words, then Enter on its own. ESC CR (a newline in the box) stays whole. */
function splitEnter(chunk: string): readonly string[] {
  if (chunk.length > 1 && chunk.endsWith(ENTER) && !chunk.endsWith(`\x1b${ENTER}`)) return [chunk.slice(0, -1), ENTER]
  return [chunk]
}

export class AgentWaker<S extends { write: (data: string) => unknown }> {
  /** In-flight wakes, so two callers waking one agent share one boot. */
  private readonly waking = new Map<string, Promise<S | undefined>>()
  /** Keys for an agent that is waking, held until it is ready. */
  private readonly held = new Map<string, readonly string[]>()
  private readonly pause: (ms: number) => Promise<void>

  constructor(private readonly deps: WakeDeps<S>) {
    this.pause = deps.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * The agent's session once it takes input: at once when it is running,
   * after its boot when it was offline. Undefined when the id is no terminal
   * card or the agent would not start.
   */
  wake(id: string): Promise<S | undefined> {
    const pending = this.waking.get(id)
    if (pending) return pending
    const live = this.deps.session(id)
    if (live) {
      this.deps.sleep.take(id)
      return Promise.resolve(live)
    }
    if (!this.deps.isTerminal(id)) return Promise.resolve(undefined)
    const run = this.boot(id)
    this.waking.set(id, run)
    void run.finally(() => {
      if (this.waking.get(id) === run) this.waking.delete(id)
    })
    return run
  }

  /**
   * Keys for a terminal. True when they were taken here — the agent is
   * offline (this starts its wake) or still waking — and will be typed once
   * it is ready. False: the caller writes them to the running session itself.
   */
  hold(id: string, data: string): boolean {
    const queued = this.held.get(id)
    if (queued) {
      this.held.set(id, [...queued, data])
      return true
    }
    if (this.deps.session(id) && !this.waking.has(id)) return false
    if (!this.deps.isTerminal(id)) return false
    this.held.set(id, [data])
    void this.wake(id).then((session) => this.flush(id, session))
    return true
  }

  private async boot(id: string): Promise<S | undefined> {
    const slept = this.deps.sleep.take(id)
    // Asked before the boot: afterwards the pane exists either way.
    const since = Date.now()
    const missing = !this.deps.paneAlive(id)
    let session: S | undefined
    try {
      session = this.deps.boot(id) ? this.deps.session(id) : undefined
    } catch (error) {
      this.deps.warn?.(`Agent ${id} could not be woken: ${String(error)}`)
    }
    if (!session) {
      // Still asleep, so the next caller tries again.
      if (slept) this.deps.sleep.mark(id)
      return undefined
    }
    // A pane herdr kept can still be a husk the boot just brought back: its
    // agent is painting its resumed transcript and would swallow the Enter.
    const husk = !missing && (this.deps.booted?.(id, since) ?? false)
    const ready = missing || husk ? await this.deps.ready(session) : true
    if (!ready) this.deps.warn?.(`Agent ${id} was still booting when it was woken`)
    // A husk whose agent never drew its input box may still be the bare shell
    // herdr restored: words typed there would run as a command in the card's
    // folder. They go back as lost instead.
    if (husk && !ready) return undefined
    // A boot can start and die inside that wait: the keys belong to `lost`, not to a dead session.
    if (this.deps.session(id) !== session) return undefined
    return session
  }

  /** Type what was held, in order; keys typed during a pause join the end of the queue. */
  private async flush(id: string, session: S | undefined): Promise<void> {
    if (!session) {
      const chunks = this.held.get(id) ?? []
      this.held.delete(id)
      this.deps.lost?.(id, chunks)
      return
    }
    let sent = 0
    let words = ''
    for (;;) {
      const chunks = this.held.get(id) ?? []
      if (sent >= chunks.length) break
      for (const part of splitEnter(chunks[sent++])) {
        if (part !== ENTER) {
          words += part
          continue
        }
        if (words) {
          session.write(words)
          await this.pause(submitDelayMs(words.length))
          words = ''
        }
        session.write(ENTER)
      }
    }
    if (words) session.write(words)
    this.held.delete(id)
  }
}
