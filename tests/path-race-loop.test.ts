import { describe, expect, it } from 'vitest'
import { RACE_EVERY_MS, startRaceLoop } from '../src/renderer/src/path/race-loop'

// THE CLOCK A COMPANION LOOKS FOR A NEARER PATH ON: at boot, on a timer, on the
// two moments a phone changes network, and never two races at once.

describe('the loop', () => {
  it('races at boot, on a timer, and when the network might have changed', async () => {
    const events = new Map<string, () => void>()
    let tick: (() => void) | null = null
    let every = 0
    let races = 0
    const stop = startRaceLoop({
      race: async () => {
        races += 1
      },
      setInterval: (fn, ms) => {
        tick = fn
        every = ms
        return () => void (tick = null)
      },
      on: (event, listener) => {
        events.set(event, listener)
        return () => void events.delete(event)
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(races).toBe(1)
    expect(every).toBe(RACE_EVERY_MS)

    // Each is awaited, because a race already in flight swallows the next
    // trigger by design — that is the subject of the test below.
    for (const wake of [tick, events.get('online'), events.get('visibilitychange')]) {
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(races).toBe(4)

    stop()
    expect(events.size).toBe(0)
    expect(tick).toBe(null)
  })

  it('runs one race at a time, however many things wake it at once', async () => {
    const events = new Map<string, () => void>()
    let races = 0
    let raceNow: () => void = () => undefined
    const gate: { release: (() => void) | null } = { release: null }
    startRaceLoop({
      race: () =>
        new Promise<void>((resolve) => {
          races += 1
          gate.release = resolve
        }),
      setInterval: () => () => undefined,
      on: (event, listener) => {
        events.set(event, listener)
        return () => events.delete(event)
      },
      ready: (run) => void (raceNow = run)
    })
    // A phone waking on a new network fires all of these at once.
    events.get('online')?.()
    events.get('visibilitychange')?.()
    raceNow()
    expect(races).toBe(1)
    gate.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    events.get('online')?.()
    expect(races).toBe(2)
  })

  it('survives a race that rejects, and races again', async () => {
    const events = new Map<string, () => void>()
    let races = 0
    startRaceLoop({
      race: async () => {
        races += 1
        throw new Error('the network said no')
      },
      setInterval: () => () => undefined,
      on: (event, listener) => {
        events.set(event, listener)
        return () => events.delete(event)
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    events.get('online')?.()
    expect(races).toBe(2)
  })
})
