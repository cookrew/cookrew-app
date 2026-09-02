import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoorWatch } from '../src/main/door-watch'

describe('door watch — the remote card is nudged when the door\'s record changes', () => {
  afterEach(() => vi.useRealTimers())

  it('polls only while subscribed, and pushes only on a change', async () => {
    vi.useFakeTimers()
    let print = 'ok:1:1'
    const probes: string[] = []
    const changed: string[] = []
    const watch = new DoorWatch({
      probe: async (id) => {
        probes.push(id)
        return print
      },
      onChange: (id) => changed.push(id),
      intervalMs: 100
    })
    watch.subscribe('t1')
    await vi.advanceTimersByTimeAsync(0)
    // The first answer is the baseline: no nudge for what the card already read.
    expect(probes).toEqual(['t1'])
    expect(changed).toEqual([])
    await vi.advanceTimersByTimeAsync(250)
    expect(changed).toEqual([])
    print = 'ok:2:2'
    await vi.advanceTimersByTimeAsync(100)
    expect(changed).toEqual(['t1'])
    await vi.advanceTimersByTimeAsync(300)
    expect(changed).toEqual(['t1'])

    // Two views, one poll; the poll stops when the last one goes.
    watch.subscribe('t1')
    watch.unsubscribe('t1')
    expect(watch.watching('t1')).toBe(true)
    watch.unsubscribe('t1')
    expect(watch.watching('t1')).toBe(false)
    const before = probes.length
    await vi.advanceTimersByTimeAsync(500)
    expect(probes.length).toBe(before)
  })

  it('probes never overlap — a slow door just misses ticks', async () => {
    vi.useFakeTimers()
    let inFlight = 0
    let peak = 0
    let started = 0
    const watch = new DoorWatch({
      probe: async () => {
        started += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 350))
        inFlight -= 1
        return `v${started}`
      },
      onChange: () => undefined,
      intervalMs: 100
    })
    watch.subscribe('t1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(peak).toBe(1)
    expect(started).toBeLessThan(6)
    watch.forget('t1')
    expect(watch.watching('t1')).toBe(false)
  })

  it('a probe that throws or answers null neither pushes nor stops the poll', async () => {
    vi.useFakeTimers()
    let mode: 'throw' | 'null' | 'a' | 'b' = 'throw'
    const changed: string[] = []
    const watch = new DoorWatch({
      probe: async () => {
        if (mode === 'throw') throw new Error('door down')
        return mode === 'null' ? null : mode
      },
      onChange: (id) => changed.push(id),
      intervalMs: 100
    })
    watch.subscribe('t1')
    await vi.advanceTimersByTimeAsync(150)
    mode = 'null'
    await vi.advanceTimersByTimeAsync(100)
    mode = 'a'
    await vi.advanceTimersByTimeAsync(100)
    expect(changed).toEqual([])
    mode = 'b'
    await vi.advanceTimersByTimeAsync(100)
    expect(changed).toEqual(['t1'])
    watch.dispose()
  })
})
