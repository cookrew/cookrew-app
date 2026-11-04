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
// makes the window testable without waiting it out.
//
// Owner, 2026-11-01: ten minutes was unreasonable, and agents that were still
// running were killed. The window is an hour now, and this clock only
// NOMINATES: agent-sleep-evidence.ts asks Claude itself before anything ends.

/** An hour of nothing (was ten minutes until the owner's 2026-11-01 ruling). */
export const DEFAULT_IDLE_SLEEP_MS = 60 * 60_000

/**
 * What a boot costs each card. The first sighting used to start a whole window,
 * and the app restarts several times a day, so a fleet idle for two days was
 * never nominated (2026-11-05). The evidence gate knows how long an agent has
 * really been quiet, so the clock only has to leave time for viewers to
 * reconnect after the boot. Kept apart from the clock: the window can shrink
 * a minute after a boot, and that must not spend the grace.
 */
export const BOOT_GRACE_MS = 5 * 60_000

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
  /** First sightings: not nominated before this moment, whatever the window. */
  private readonly graceUntil = new Map<string, number>()
  /** Terminals this app put to sleep and has not seen wake since. */
  private readonly sleeping = new Set<string>()

  constructor(private readonly idleMs: number) {}

  /** Activity outside the sweep: a status change, a keystroke. */
  touch(id: string, now: number): void {
    if (this.lastBusy.has(id)) this.lastBusy.set(id, now)
  }

  /**
   * One sweep over the terminals that have a running process. Returns the ids
   * whose window has run out, longest quiet first. A first sighting is never
   * due: it waits out BOOT_GRACE_MS, because an app that just booted cannot yet
   * see who is watching. `windowMs` is this sweep's window, shorter under
   * memory pressure (machine-pressure.ts).
   */
  due(live: readonly SleepFacts[], now: number, windowMs: number = this.idleMs): string[] {
    const seen = new Set<string>()
    const out: Array<{ id: string; last: number }> = []
    for (const f of live) {
      seen.add(f.id)
      // Running again after we slept it: something woke it outside the waker,
      // which claims this mark itself. Either way the evidence then counts
      // from Claude's fresh status.
      const wasWoken = this.sleeping.delete(f.id)
      if (wasWoken) this.forget(f.id)
      if (this.idleMs <= 0 || !f.resumable || f.served) {
        this.forget(f.id)
        continue
      }
      const last = this.lastBusy.get(f.id)
      if (f.busy) {
        this.lastBusy.set(f.id, now)
        this.graceUntil.delete(f.id)
        continue
      }
      if (last === undefined) {
        this.firstSight(f.id, now, wasWoken, windowMs)
        continue
      }
      if (now < (this.graceUntil.get(f.id) ?? 0)) continue
      if (now - last >= windowMs) out.push({ id: f.id, last })
    }
    for (const id of [...this.lastBusy.keys()]) if (!seen.has(id)) this.forget(id)
    return out.sort((a, b) => a.last - b.last).map((d) => d.id)
  }

  /**
   * A boot knows nothing of how long this card has been quiet, so its clock is
   * unset (the evidence supplies the truth once the grace is over). A card seen
   * waking counts from now.
   */
  private firstSight(id: string, now: number, woken: boolean, windowMs: number): void {
    this.lastBusy.set(id, woken ? now : Number.NEGATIVE_INFINITY)
    if (!woken) this.graceUntil.set(id, now + Math.min(BOOT_GRACE_MS, windowMs))
  }

  private forget(id: string): void {
    this.lastBusy.delete(id)
    this.graceUntil.delete(id)
  }

  /**
   * The evidence says the last sign of life was `at` (now, or a loop's wakeup
   * still ahead): count the window from there, never from earlier.
   */
  restart(id: string, at: number): void {
    const last = this.lastBusy.get(id)
    if (last !== undefined) this.lastBusy.set(id, Math.max(last, at))
  }

  markAsleep(id: string): void {
    this.forget(id)
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
