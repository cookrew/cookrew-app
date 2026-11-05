// THE FIRST FLEET BUILD, paid at idle rather than by the first request.
//
// Cold, it parses every background workspace file and every turn ledger
// (~165 ms measured on the owner's store) on Electron main. Done here it is
// split into steps — one workspace per step, then the ledger, then the build
// itself — and each step waits for a quiet loop: a short timer that fires
// late means something else is using main, so the step backs off.

/** A timer this late means the loop is busy. */
export const PREWARM_LAG_MS = 20
/** Back off this long when busy. */
export const PREWARM_BACKOFF_MS = 2_000
/** After this long waiting for quiet, go anyway: the first request would pay it worse. */
export const PREWARM_GIVE_UP_MS = 120_000

export interface PrewarmClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const realClock: PrewarmClock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
}

/** Resolve once a short probe timer fires on time, or the give-up deadline passes. */
export async function quietMoment(deadline: number, clock: PrewarmClock = realClock): Promise<void> {
  for (;;) {
    const asked = clock.now()
    await clock.sleep(10)
    if (clock.now() - asked - 10 < PREWARM_LAG_MS || clock.now() >= deadline) return
    await clock.sleep(PREWARM_BACKOFF_MS)
  }
}

/** Run each step in its own quiet moment. A step's failure is logged and the rest still run. */
export async function runAtIdle(steps: ReadonlyArray<() => void>, clock: PrewarmClock = realClock): Promise<number> {
  const deadline = clock.now() + PREWARM_GIVE_UP_MS
  let ran = 0
  for (const step of steps) {
    await quietMoment(deadline, clock)
    try {
      step()
      ran += 1
    } catch (error) {
      console.error('Fleet prewarm step failed:', error)
    }
  }
  return ran
}
