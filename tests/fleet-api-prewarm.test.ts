import { describe, expect, it } from 'vitest'
import { PREWARM_BACKOFF_MS, PREWARM_GIVE_UP_MS, runAtIdle, type PrewarmClock } from '../src/main/fleet/prewarm'
import { fakeDesktop } from './fleet-fixture'

/** A clock whose probe timer fires `lag` ms late while `busyUntil` is ahead. */
function fakeClock(busyUntil: number, lag = 50): PrewarmClock & { slept: number[] } {
  let t = 0
  const slept: number[] = []
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms + (ms === 10 && t < busyUntil ? lag : 0)
    }
  }
}

describe('the fleet prewarm', () => {
  it('runs each step at a quiet moment, backing off while the loop is busy', async () => {
    const clock = fakeClock(5_000)
    const at: number[] = []
    const ran = await runAtIdle([() => at.push(clock.now()), () => at.push(clock.now())], clock)
    expect(ran).toBe(2)
    expect(at[0]).toBeGreaterThanOrEqual(5_000)
    expect(clock.slept.filter((ms) => ms === PREWARM_BACKOFF_MS).length).toBeGreaterThan(0)
  })

  it('goes anyway once the give-up deadline passes, and survives a failing step', async () => {
    const clock = fakeClock(Number.POSITIVE_INFINITY)
    const ran = await runAtIdle(
      [
        () => {
          throw new Error('torn workspace')
        },
        () => undefined
      ],
      clock
    )
    expect(ran).toBe(1)
    expect(clock.now()).toBeGreaterThanOrEqual(PREWARM_GIVE_UP_MS)
  })

  it('leaves the service built, so the first request does not build', async () => {
    const desk = fakeDesktop()
    const steps = desk.service.prewarmSteps()
    expect(steps).toHaveLength(2 + 3) // two workspaces, ledger, dials, build
    await runAtIdle(steps, fakeClock(0))
    expect(desk.service.stats().builds).toBe(1)
    desk.service.current()
    expect(desk.service.stats().builds).toBe(1)
    desk.service.close()
  })
})
