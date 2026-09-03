import { describe, expect, it } from 'vitest'
import { evictOverBudget } from '../src/main/trace'

/**
 * The trace memo held the PARSED LINES of every session file it ever read —
 * capped by COUNT (128 files), never by size. Session files run to 90MB
 * (parsers re-run over the whole line array on append, so the raw lines are
 * load-bearing), and 128 × that is the "application memory" exhaustion: a
 * reader who browses a dozen heavyweight transcripts pins gigabytes that
 * nothing releases. Eviction is now byte-budgeted too — but the newest
 * entries always survive, because evicting the live polled file would turn
 * every rail poll into a full re-read of the biggest file on the machine,
 * the exact O(n²) this cache exists to prevent.
 */

const fill = (sizes: number[]): Map<string, number> =>
  new Map(sizes.map((bytes, i) => [`f${i}`, bytes]))

const size = (bytes: number): number => bytes

describe('the trace memo budget', () => {
  it('evicts oldest beyond the count cap, as before', () => {
    const map = fill([1, 1, 1, 1])
    evictOverBudget(map, size, { maxCount: 3, maxBytes: Infinity, keepNewest: 1 })
    expect([...map.keys()]).toEqual(['f1', 'f2', 'f3'])
  })

  it('evicts oldest when the BYTES exceed the budget, however few the files', () => {
    const map = fill([90, 80, 10])
    evictOverBudget(map, size, { maxCount: 128, maxBytes: 80, keepNewest: 1 })
    expect([...map.keys()]).toEqual(['f2'])
  })

  it('never evicts the newest entries, even over budget — the live file survives', () => {
    // One 90MB Conductor over a 64MB budget must stay cached: dropping it
    // costs a 90MB re-read + re-parse on the NEXT poll tick, forever.
    const map = fill([90])
    evictOverBudget(map, size, { maxCount: 128, maxBytes: 64, keepNewest: 1 })
    expect([...map.keys()]).toEqual(['f0'])
    const two = fill([90, 90])
    evictOverBudget(two, size, { maxCount: 128, maxBytes: 64, keepNewest: 2 })
    expect(two.size).toBe(2)
  })

  it('stops at the budget once under it, keeping everything newer', () => {
    const map = fill([50, 20, 20, 20])
    evictOverBudget(map, size, { maxCount: 128, maxBytes: 70, keepNewest: 1 })
    expect([...map.keys()]).toEqual(['f1', 'f2', 'f3'])
  })

  it('a pinned oldest stops eviction cold — order is recency, newer is pinned harder', () => {
    const map = fill([90, 90, 90])
    evictOverBudget(map, size, { maxCount: 128, maxBytes: 100, keepNewest: 1 }, () => true)
    expect(map.size).toBe(3)
  })

  it('handles the edges: empty map, keepNewest zero', () => {
    const empty = new Map<string, number>()
    evictOverBudget(empty, size, { maxCount: 1, maxBytes: 1, keepNewest: 0 })
    expect(empty.size).toBe(0)
    const map = fill([5, 5])
    evictOverBudget(map, size, { maxCount: 128, maxBytes: 4, keepNewest: 0 })
    expect(map.size).toBe(0)
  })

  it('a round-robin poll over budget does NOT thrash — the residency pin holds', () => {
    // The failure this pins (found in review): round-robin polling is
    // precisely anti-LRU — reading f0 evicts f1..fk, the files the SAME
    // tick is about to poll, and every poll becomes a full re-read.
    // Without the pin this measured 100 full reads in 5 ticks over 20
    // files; the correct number is 20, first tick only.
    const FILES = 20
    const TICK_MS = 2000
    const RESIDENCY_MS = 10_000
    const map = new Map<string, { bytes: number; touchedAt: number }>()
    let fullReads = 0
    for (let tick = 0; tick < 5; tick += 1) {
      const now = tick * TICK_MS
      for (let i = 0; i < FILES; i += 1) {
        const key = `f${i}`
        const hit = map.get(key)
        if (hit) {
          map.delete(key)
          map.set(key, { ...hit, touchedAt: now })
          continue
        }
        fullReads += 1
        map.delete(key)
        map.set(key, { bytes: 30, touchedAt: now })
        evictOverBudget(
          map,
          (e) => e.bytes,
          { maxCount: 128, maxBytes: 256, keepNewest: 8 },
          (e) => now - e.touchedAt < RESIDENCY_MS
        )
      }
    }
    expect(fullReads).toBe(FILES)
  })
})
