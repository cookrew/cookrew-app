import { describe, expect, it } from 'vitest'
import { createRelayPace, PACE_CUT, PACE_FAR, PACE_MAX, PACE_MIN, PACE_START, PACE_TARGET_MS } from '../src/main/relay-pace'

/** A pace on a clock the test moves; `start` above the floor, so there is room to shrink. */
const paced = (start?: number): { pace: ReturnType<typeof createRelayPace>; at: (ms: number) => void } => {
  let now = 0
  return { pace: createRelayPace({ now: () => now, ...(start === undefined ? {} : { start }) }), at: (ms) => void (now = ms) }
}
const ROOM = 64 * 1024

describe('the relay pace', () => {
  it('starts at a window that has proved nothing yet', () => {
    expect(paced().pace.window()).toBe(PACE_START)
  })

  it('grows by what was confirmed while the line shows no queue and more was waiting', () => {
    const { pace, at } = paced()
    at(1000)
    pace.sample({ acked: 32_000, rttMs: 120, limited: true })
    expect(pace.window()).toBe(PACE_START + 32_000)
  })

  it('grows more slowly as the queue nears its target', () => {
    const { pace, at } = paced()
    at(1000)
    pace.sample({ acked: 1000, rttMs: 100, limited: true })
    const before = pace.window()
    at(1100)
    pace.sample({ acked: 40_000, rttMs: 100 + PACE_TARGET_MS / 2, limited: true })
    expect(pace.window() - before).toBe(20_000)
  })

  it('does not grow a window nothing was waiting on', () => {
    const { pace, at } = paced()
    at(1000)
    pace.sample({ acked: 32_000, rttMs: 120, limited: false })
    expect(pace.window()).toBe(PACE_START)
  })

  it('shrinks in proportion when the queue is a little over its target', () => {
    const { pace, at } = paced(ROOM)
    at(1000)
    pace.sample({ acked: 1000, rttMs: 200, limited: true })
    const before = pace.window()
    at(1100)
    // Half the target over it: down by half of what was confirmed.
    pace.sample({ acked: 20_000, rttMs: 200 + PACE_TARGET_MS * 1.5, limited: true })
    expect(pace.window()).toBe(before - 10_000)
    // At the target exactly, it holds.
    at(1200)
    pace.sample({ acked: 20_000, rttMs: 200 + PACE_TARGET_MS, limited: true })
    expect(pace.window()).toBe(before - 10_000)
  })

  it('halves a queue far over its target, once per round trip', () => {
    const { pace, at } = paced(ROOM)
    at(1000)
    pace.sample({ acked: 1000, rttMs: 200, limited: true })
    const before = pace.window()
    const far = 200 + PACE_TARGET_MS * PACE_FAR + 50
    at(1100)
    pace.sample({ acked: 1000, rttMs: far, limited: true })
    expect(pace.window()).toBe(Math.floor(before * PACE_CUT))
    // The next receipts still carry the queue from before the cut.
    at(1200)
    pace.sample({ acked: 1000, rttMs: far, limited: true })
    expect(pace.window()).toBe(Math.floor(before * PACE_CUT))
    // A round trip (base + target) later, it may halve again.
    at(1100 + 200 + PACE_TARGET_MS)
    pace.sample({ acked: 1000, rttMs: far, limited: true })
    expect(pace.window()).toBe(Math.max(PACE_MIN, Math.floor(Math.floor(before * PACE_CUT) * PACE_CUT)))
  })

  it('measures the queue from the smallest delay seen, not the first', () => {
    const { pace, at } = paced(ROOM)
    at(1000)
    pace.sample({ acked: 1000, rttMs: 900, limited: false })
    at(1100)
    pace.sample({ acked: 1000, rttMs: 100, limited: false })
    // 400 above a base of 100 is queue, though it is below the first sample.
    at(1200)
    pace.sample({ acked: 1000, rttMs: 100 + PACE_TARGET_MS + 150, limited: true })
    expect(pace.window()).toBeLessThan(ROOM)
  })

  it('forgets a base delay from before a quiet spell', () => {
    const { pace, at } = paced(ROOM)
    at(1000)
    pace.sample({ acked: 1000, rttMs: 100, limited: true })
    // Two minutes later the route is slower; that is its round trip now, not queue.
    at(121_000)
    pace.sample({ acked: 1000, rttMs: 600, limited: true })
    expect(pace.window()).toBeGreaterThanOrEqual(ROOM)
  })

  it('stays between its floor and its ceiling', () => {
    const { pace, at } = paced()
    // Each a round trip apart, all inside the base delay's memory.
    for (let i = 0; i < 40; i += 1) {
      at(i * 400)
      pace.sample({ acked: 1000, rttMs: i === 0 ? 50 : 50 + PACE_TARGET_MS * (PACE_FAR + 2), limited: true })
    }
    expect(pace.window()).toBe(PACE_MIN)
    const fast = paced()
    for (let i = 0; i < 400; i += 1) {
      fast.at(i)
      fast.pace.sample({ acked: 1_000_000, rttMs: 5, limited: true })
    }
    expect(fast.pace.window()).toBe(PACE_MAX)
  })

  it('waits for a first delay before moving, then judges untimed receipts by the last one', () => {
    const { pace, at } = paced()
    at(1000)
    pace.sample({ acked: 32_000, rttMs: null, limited: true })
    expect(pace.window()).toBe(PACE_START)
    pace.sample({ acked: 1000, rttMs: 100, limited: true })
    const timed = pace.window()
    // No new delay, no queue last measured: every confirmed byte still grows it.
    pace.sample({ acked: 8000, rttMs: null, limited: true })
    expect(pace.window()).toBe(timed + 8000)
  })

  it('does not halve on a stale delay, only on a fresh one', () => {
    const { pace, at } = paced()
    at(1000)
    pace.sample({ acked: 1000, rttMs: 100, limited: true })
    at(1100)
    pace.sample({ acked: 1000, rttMs: 100 + PACE_TARGET_MS * (PACE_FAR + 1), limited: true })
    const halved = pace.window()
    at(5000)
    pace.sample({ acked: 1000, rttMs: null, limited: true })
    // Judged by the same far-over reading, it shrinks by steps, not by half.
    expect(pace.window()).toBeGreaterThan(Math.floor(halved * PACE_CUT))
  })

  it('forgets the line on reset', () => {
    const { pace, at } = paced()
    at(1000)
    pace.sample({ acked: 32_000, rttMs: 100, limited: true })
    pace.reset()
    expect(pace.window()).toBe(PACE_START)
    pace.sample({ acked: 32_000, rttMs: null, limited: true })
    expect(pace.window()).toBe(PACE_START)
  })
})
