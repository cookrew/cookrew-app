/**
 * THE CLOCK A COMPANION LOOKS FOR A NEARER PATH ON.
 *
 * All that is left of the old switchers (path/switch.ts, path/plane-switch.ts)
 * once the per-machine names under d.cookrew.dev were dropped (2026-11-16): the
 * schedule and the ONE-AT-A-TIME rule. The race itself is the companion's
 * (path/companion.ts): a WebRTC knock, and a report of how it went.
 */

/**
 * How often a companion on the relay looks again.
 *
 * Each race costs at most one knock (and the knock has its own, longer gap in
 * companion.ts), so this is the slowest clock that still notices a phone that
 * walked in the door within a minute.
 */
export const RACE_EVERY_MS = 60_000

export interface RaceLoopOptions {
  /** One race. Never rejects; the loop drops a rejection anyway. */
  readonly race: () => Promise<unknown>
  readonly everyMs?: number
  /** window, or a stand-in with the listeners this uses. */
  readonly on?: (event: string, listener: () => void) => () => void
  readonly setInterval?: (fn: () => void, ms: number) => () => void
  /**
   * Handed the loop's own guarded race trigger, once, at start.
   *
   * The ONE-AT-A-TIME guard has to stay the loop's, so something that asks
   * for a race from outside (the Mac saying its addresses moved) cannot start
   * a second race beside the timer's.
   */
  readonly ready?: (raceNow: () => void) => void
}

/**
 * Run a race on a timer, and whenever the network might just have changed.
 *
 * `online` and `visibilitychange` are the two moments that matter and neither
 * is covered by a clock: a phone taken out of a pocket inside the house is on
 * the LAN the instant its screen wakes, and waiting a minute to notice is the
 * difference between "it just works" and "it eventually works".
 */
export const startRaceLoop = (options: RaceLoopOptions): (() => void) => {
  let running = false

  const race = (): void => {
    // One at a time: three events can land together when a phone wakes up on
    // a new network, and three simultaneous races would triple the knocks.
    if (running) return
    running = true
    void options
      .race()
      .catch(() => undefined)
      .finally(() => void (running = false))
  }

  const every = options.setInterval ?? ((fn, ms) => {
    const handle = setInterval(fn, ms)
    return () => clearInterval(handle)
  })
  const listen =
    options.on ??
    ((event, listener) => {
      window.addEventListener(event, listener)
      return () => window.removeEventListener(event, listener)
    })

  const offs: (() => void)[] = [
    every(race, options.everyMs ?? RACE_EVERY_MS),
    listen('online', race),
    listen('visibilitychange', race)
  ]
  options.ready?.(race)
  race()
  return () => offs.forEach((off) => off())
}
