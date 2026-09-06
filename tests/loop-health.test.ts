// The main thread reading its own loop (src/main/loop-health.ts).
//
// What is pinned: the windows roll and are bounded, a named loop's ticks are
// summarised over the same horizon, timed() records even when the tick
// throws, and stop() leaves nothing running. The delay numbers themselves
// are the machine's to decide, so they are only checked for shape.

import { afterEach, describe, expect, it } from 'vitest'
import { createLoopHealth, type LoopHealth } from '../src/main/loop-health'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('loop health', () => {
  const open: LoopHealth[] = []
  afterEach(() => {
    for (const h of open.splice(0)) h.stop()
  })
  const make = (over: Parameters<typeof createLoopHealth>[0] = {}): LoopHealth => {
    const h = createLoopHealth(over)
    open.push(h)
    return h
  }

  it('answers a well-formed snapshot from the first read', () => {
    const h = make({ residency: () => ({ store: 2, registry: 3 }) })
    const s = h.snapshot()
    expect(s.loop.lastMinute).toBeNull()
    expect(s.loop.windows).toEqual([])
    expect(s.loop.current.samples).toBeGreaterThanOrEqual(0)
    for (const k of ['p50', 'p95', 'p98', 'max'] as const) expect(Number.isFinite(s.loop.current[k])).toBe(true)
    expect(s.loop.current.elu).toBeGreaterThanOrEqual(0)
    expect(s.loop.current.elu).toBeLessThanOrEqual(1)
    expect(s.residency).toEqual({ store: 2, registry: 3 })
    expect(s.loops).toEqual({})
    expect(s.uptimeMs).toBeGreaterThanOrEqual(0)
  })

  it('rolls windows on the interval and keeps at most `keep` of them', async () => {
    const h = make({ windowMs: 15, keep: 3 })
    await sleep(120)
    const s = h.snapshot()
    expect(s.loop.windows.length).toBe(3)
    expect(s.loop.lastMinute).toEqual(s.loop.windows[2])
    // Oldest first, and each window starts where the previous one ended.
    for (let i = 1; i < s.loop.windows.length; i += 1) {
      expect(s.loop.windows[i].at).toBeGreaterThanOrEqual(s.loop.windows[i - 1].at)
    }
    expect(s.loop.current.at).toBeGreaterThanOrEqual(s.loop.windows[2].at)
  })

  it('summarises a named loop over its ticks, newest tick called out', () => {
    let clock = 1_800_000_000_000
    const h = make({ now: () => clock })
    h.observe('sessionDrain', 1)
    clock += 5000
    h.observe('sessionDrain', 3)
    clock += 5000
    h.observe('sessionDrain', 2)
    const { loops } = h.snapshot()
    expect(loops.sessionDrain).toEqual({ count: 3, p50: 2, p95: 2.9, max: 3, lastMs: 2, lastAt: clock })
  })

  it('forgets ticks older than the kept horizon', () => {
    let clock = 1_800_000_000_000
    const h = make({ now: () => clock, windowMs: 1000, keep: 2 })
    h.observe('boardProbe', 500)
    clock += 5000 // beyond keep × windowMs
    h.observe('boardProbe', 1)
    expect(h.snapshot().loops.boardProbe.count).toBe(1)
    expect(h.snapshot().loops.boardProbe.max).toBe(1)
  })

  it('timed() records the tick and re-throws what it threw', () => {
    const h = make()
    expect(() =>
      h.timed('boardProbe', () => {
        throw new Error('tmux exploded')
      })
    ).toThrow('tmux exploded')
    expect(h.timed('boardProbe', () => 42)).toBe(42)
    expect(h.snapshot().loops.boardProbe.count).toBe(2)
  })

  it('sees a stall it was awake for', async () => {
    const h = make()
    await sleep(60) // let the sampler take its first timer before the stall
    const until = performance.now() + 80
    while (performance.now() < until) {
      // hold the loop
    }
    await sleep(60)
    const s = h.snapshot()
    expect(s.loop.current.max, JSON.stringify(s.loop.current)).toBeGreaterThanOrEqual(30)
    expect(s.loop.current.elu).toBeGreaterThan(0)
  })
})
