// AN IDLE AGENT SLEEPS; THE NEXT ASK OR LIVE WAKES IT ON THE SAME SESSION.
//
// Owner, 2026-10-31: keep the TUI, but stop paying for it while nobody uses
// it. Measured that day: an idle agent's process tree is 450–700 MB (claude
// plus its MCP children), and 14 of 16 agents were idle. The conversation is
// on disk either way, so a TUI that has had no turn, no viewer and no input
// for the window is ended, and the next ask, dispatch, quick reply or LIVE
// brings it back with `--resume` — the path proven on Harden the same day.
//
// This file is the clock and the ledger only. Deciding what "busy" means and
// ending/booting processes is index.ts's job; keeping the timing pure is what
// makes the ten minutes testable without waiting them out.

/** The owner's ruling: ten minutes of nothing. */
export const DEFAULT_IDLE_SLEEP_MS = 10 * 60_000

export interface SleepFacts {
  id: string
  /** Its harness can resume this exact conversation (otherwise sleep loses it). */
  resumable: boolean
  /** A served session's agent: its process belongs to someone else's call. */
  served: boolean
  /** In a turn, waiting on a person, being viewed, or being typed into. */
  busy: boolean
}

/** `COOKREW_IDLE_SLEEP_MS`: milliseconds, 0 = never sleep, garbage = default. */
export function idleSleepMsFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_SLEEP_MS
  const ms = Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_IDLE_SLEEP_MS
}

export class IdleSleep {
  /** Last moment each live terminal was seen busy (or first seen at all). */
  private readonly lastBusy = new Map<string, number>()
  /** Terminals this app put to sleep and has not seen wake since. */
  private readonly sleeping = new Set<string>()

  constructor(private readonly idleMs: number) {}

  /** Activity outside the sweep: a status change, a keystroke. */
  touch(id: string, now: number): void {
    if (this.lastBusy.has(id)) this.lastBusy.set(id, now)
  }

  /**
   * One sweep over the terminals that have a running process. Returns the ids
   * whose window has run out. The first sighting only starts the clock: an
   * app that just booted knows nothing about how long anyone has been idle.
   */
  due(live: readonly SleepFacts[], now: number): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const f of live) {
      seen.add(f.id)
      // Running again after we slept it: something woke it (LIVE, an ask).
      if (this.sleeping.delete(f.id)) this.lastBusy.delete(f.id)
      if (this.idleMs <= 0 || !f.resumable || f.served) {
        this.lastBusy.delete(f.id)
        continue
      }
      const last = this.lastBusy.get(f.id)
      if (f.busy || last === undefined) {
        this.lastBusy.set(f.id, now)
        continue
      }
      if (now - last >= this.idleMs) out.push(f.id)
    }
    for (const id of [...this.lastBusy.keys()]) if (!seen.has(id)) this.lastBusy.delete(id)
    return out
  }

  markAsleep(id: string): void {
    this.lastBusy.delete(id)
    this.sleeping.add(id)
  }

  isAsleep(id: string): boolean {
    return this.sleeping.has(id)
  }

  /** Claim the wake: true once per sleep, so two wakers never boot twice. */
  takeAsleep(id: string): boolean {
    return this.sleeping.delete(id)
  }
}
