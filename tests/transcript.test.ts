import { describe, expect, it } from 'vitest'
import {
  activeBlockForScroll,
  evictTrace,
  isAtBottom,
  boundaryReached,
  hasNewerBlocks,
  hasOlderBlocks,
  mergeCheckpointRows,
  mergeTrace,
  newestIndex,
  pruneToTotal,
  railPointerFraction,
  railToScrollTop,
  scrollTopToFraction,
  tailClipRows,
  type TraceBlock
} from '../src/renderer/src/transcript'
import type { TurnRecord } from '../src/shared/turn'
// Identity-keyed blocks (integration round 2): pos is GONE — TraceBlock.index
// (1-based, from the trace parsers) is both identity and layout ordinal.
const block = (index: number, over: Partial<TraceBlock> = {}): TraceBlock => ({
  id: `u${index}`,
  index,
  prompt: `prompt ${index}`,
  reply: `reply ${index}`,
  activity: [],
  startedAt: 0,
  endedAt: 1,
  ...over
})

describe('mergeTrace (lazy pagination)', () => {
  it('prepends an older window, ascending by position, no duplicates', () => {
    const loaded = [block(2), block(3), block(4)]
    const older = [block(0), block(1)]
    expect(mergeTrace(loaded, older).map((b) => b.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('dedupes overlapping windows, incoming wins (fresher body)', () => {
    const loaded = [block(0, { reply: 'old' }), block(1)]
    const incoming = [block(0, { reply: 'new' }), block(2)]
    const merged = mergeTrace(loaded, incoming)
    expect(merged.map((b) => b.index)).toEqual([0, 1, 2])
    expect(merged[0].reply).toBe('new')
  })

  it('is stable when incoming is empty', () => {
    const loaded = [block(0), block(1)]
    expect(mergeTrace(loaded, [])).toEqual(loaded)
  })
})

describe('evictTrace (BLOCK 3 real windowing)', () => {
  const many = Array.from({ length: 10 }, (_, i) => block(i))

  it('returns all when under the cap', () => {
    expect(evictTrace(many.slice(0, 3), 1, 6)).toHaveLength(3)
  })

  it('keeps a window centred on the anchor, dropping the rest', () => {
    const kept = evictTrace(many, 5, 4)
    expect(kept.map((b) => b.index)).toEqual([3, 4, 5, 6])
  })

  it('clamps the window at the ends and always keeps the anchor', () => {
    expect(evictTrace(many, 0, 4).map((b) => b.index)).toEqual([0, 1, 2, 3])
    const tail = evictTrace(many, 9, 4).map((b) => b.index)
    expect(tail).toEqual([6, 7, 8, 9])
    expect(tail).toContain(9)
  })

  it('item 1: a MAX_SAFE anchor keeps the freshest tail through the cap', () => {
    // Returning to live re-anchors eviction at MAX_SAFE so the just-fetched
    // tail survives — never trimmed around a stale deep-history anchor.
    const deep = Array.from({ length: 105 }, (_, i) => block(i + 1)) // T1..T105
    const kept = evictTrace(deep, Number.MAX_SAFE_INTEGER, 60).map((b) => b.index)
    expect(kept[kept.length - 1]).toBe(105) // true newest survives
    expect(kept).toHaveLength(60)
    expect(kept[0]).toBe(46) // newest 60: T46..T105
  })
})

describe('pruneToTotal (MEDIUM 4 rewind shrink)', () => {
  it('drops blocks at or past the new total', () => {
    const blocks = [block(1), block(2), block(3), block(4)]
    expect(pruneToTotal(blocks, 2).map((b) => b.index)).toEqual([1, 2])
  })

  it('keeps everything when total covers all loaded blocks', () => {
    const blocks = [block(1), block(2)]
    expect(pruneToTotal(blocks, 5)).toEqual(blocks)
  })
})

// Capped-history fixture (defect: identity ≠ count): 100 records whose
// identities span T6..T105 (cap trim + sibling collapse), total 100.
const cappedBlocks = Array.from({ length: 100 }, (_, i) => block(i + 6))

describe('newestIndex (latest = blocks[last].index, never total)', () => {
  it('returns the newest loaded IDENTITY, which outruns the count', () => {
    // 100 blocks, but the newest identity is T105 — NOT the total (100).
    expect(newestIndex(cappedBlocks)).toBe(105)
    expect(cappedBlocks.length).toBe(100)
  })
  it('is null when nothing is loaded', () => {
    expect(newestIndex([])).toBeNull()
  })
})

describe('hasOlderBlocks (identity floor, never a hardcoded T1)', () => {
  it('stops at the discovered trace floor even when it is above T1', () => {
    // oldest loaded T6, floor discovered as T6 → nothing older (no phantom T1..T5)
    expect(hasOlderBlocks(6, 6)).toBe(false)
    expect(hasOlderBlocks(6, null)).toBe(true) // floor unknown → older may exist
    expect(hasOlderBlocks(50, 6)).toBe(true)
  })
  it('is false with nothing loaded', () => {
    expect(hasOlderBlocks(null, null)).toBe(false)
  })
})

describe('hasNewerBlocks (fill-forward to the true newest after eviction)', () => {
  it('keeps loading newer until the trace ceiling (T105), not the count', () => {
    // newest loaded stuck at T60 after eviction; ceiling T105 → more to load
    expect(hasNewerBlocks(60, 105)).toBe(true)
    expect(hasNewerBlocks(105, 105)).toBe(false)
    expect(hasNewerBlocks(60, null)).toBe(true) // ceiling unknown → newer may exist
  })
  it('is false with nothing loaded', () => {
    expect(hasNewerBlocks(null, null)).toBe(false)
  })
})

describe('boundaryReached (empty-page latch guard)', () => {
  it('latches only when a NON-EMPTY page has nothing beyond start', () => {
    // scroll-up from T8: page came back but all >= 8 → T8 is the floor
    expect(boundaryReached([block(8), block(9)], 8, 'older')).toBe(true)
    // page has something older than 8 → not the floor yet
    expect(boundaryReached([block(6), block(7), block(8)], 8, 'older')).toBe(false)
  })
  it('does NOT latch on a truly empty (retryable) page', () => {
    expect(boundaryReached([], 8, 'older')).toBe(false)
    expect(boundaryReached([], 105, 'newer')).toBe(false)
  })
  it('handles the newer direction (ceiling)', () => {
    expect(boundaryReached([block(104), block(105)], 105, 'newer')).toBe(true)
    expect(boundaryReached([block(105), block(106)], 105, 'newer')).toBe(false)
  })
})

describe('mergeCheckpointRows (item 3: full trace range selectable)', () => {
  // Deep-history fixture: record store capped to T8..T105; the trace reaches T1.
  const record = (index: number): TurnRecord => ({
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: 0,
    endedAt: 1
  })
  const records = Array.from({ length: 98 }, (_, i) => record(i + 8)) // T8..T105
  const traceIndex = Array.from({ length: 105 }, (_, i) => ({ index: i + 1, title: `t${i + 1}` }))

  it('spans the WHOLE trace range, not just the capped records', () => {
    const rows = mergeCheckpointRows(records, traceIndex)
    expect(rows[0].index).toBe(1) // T1 present though the record store starts at T8
    expect(rows[rows.length - 1].index).toBe(105)
    expect(rows).toHaveLength(105)
  })
  it('marks sub-cap identities trace-only, cap identities record-backed', () => {
    const rows = mergeCheckpointRows(records, traceIndex)
    const t1 = rows.find((r) => r.index === 1)!
    const t60 = rows.find((r) => r.index === 60)!
    expect(t1.record).toBeNull()
    expect(t1.traceTitle).toBe('t1')
    expect(t60.record).not.toBeNull()
  })
  it('falls back to records alone when the trace listing is absent', () => {
    const rows = mergeCheckpointRows(records, [])
    expect(rows).toHaveLength(98)
    expect(rows.every((r) => r.record !== null)).toBe(true)
  })
})

describe('activeBlockForScroll (scroll → checkpoint block)', () => {
  const tops = [
    { index: 1, top: 0 },
    { index: 2, top: 120 },
    { index: 3, top: 300 }
  ]
  it('is null above the first block', () => {
    expect(activeBlockForScroll(tops, -10)).toBeNull()
  })
  it('maps a scroll position to the last block scrolled past', () => {
    expect(activeBlockForScroll(tops, 0)).toBe(1)
    expect(activeBlockForScroll(tops, 150)).toBe(2)
    expect(activeBlockForScroll(tops, 999)).toBe(3)
  })
})

describe('isAtBottom (autoscroll pin)', () => {
  it('true within the slack of the bottom', () => {
    expect(isAtBottom(880, 1000, 120)).toBe(true)
    expect(isAtBottom(860, 1000, 120)).toBe(true)
  })
  it('false when scrolled up past the slack', () => {
    expect(isAtBottom(500, 1000, 120)).toBe(false)
  })
})

describe('railToScrollTop (item 4 rail scrub)', () => {
  it('maps a fraction to a scrollTop over the scrollable extent', () => {
    // extent = scrollHeight(1000) - clientHeight(200) = 800
    expect(railToScrollTop(0, 1000, 200)).toBe(0)
    expect(railToScrollTop(1, 1000, 200)).toBe(800)
    expect(railToScrollTop(0.5, 1000, 200)).toBe(400)
  })
  it('clamps an over-drag to the ends', () => {
    expect(railToScrollTop(-0.3, 1000, 200)).toBe(0)
    expect(railToScrollTop(1.4, 1000, 200)).toBe(800)
  })
  it('is 0 when there is nothing to scroll', () => {
    expect(railToScrollTop(0.5, 200, 200)).toBe(0)
  })
  it('round-trips with scrollTopToFraction', () => {
    const top = railToScrollTop(0.375, 1000, 200)
    expect(scrollTopToFraction(top, 1000, 200)).toBeCloseTo(0.375)
  })
})

describe('railPointerFraction (item 4 rail drag → fraction)', () => {
  // rail rect top=100, height=300, inset=16 → track = 300 - 32 = 268
  it('maps a pointer inside the track to a fraction', () => {
    expect(railPointerFraction(116, 100, 300, 16)).toBe(0)
    expect(railPointerFraction(384, 100, 300, 16)).toBe(1)
    expect(railPointerFraction(250, 100, 300, 16)).toBeCloseTo(0.5)
  })
  it('clamps a drag past either inset', () => {
    expect(railPointerFraction(90, 100, 300, 16)).toBe(0)
    expect(railPointerFraction(500, 100, 300, 16)).toBe(1)
  })
  it('is 0 when the track has collapsed', () => {
    expect(railPointerFraction(150, 100, 20, 16)).toBe(0)
  })
})

describe('scrollTopToFraction (item 4 here-marker over combined extent)', () => {
  it('maps a scroll position to a fraction (top 0 → live 1)', () => {
    expect(scrollTopToFraction(0, 1000, 200)).toBe(0)
    expect(scrollTopToFraction(800, 1000, 200)).toBe(1)
    expect(scrollTopToFraction(400, 1000, 200)).toBeCloseTo(0.5)
  })
  it('pins to live (1) when there is no overflow to scroll', () => {
    expect(scrollTopToFraction(0, 200, 200)).toBe(1)
    expect(scrollTopToFraction(0, 150, 200)).toBe(1)
  })
  it('clamps a rubber-band overscroll', () => {
    expect(scrollTopToFraction(-40, 1000, 200)).toBe(0)
    expect(scrollTopToFraction(900, 1000, 200)).toBe(1)
  })
})

describe('tailClipRows (item 1 live-tail-only clip)', () => {
  it('clips to the tail boundary when the turn is at rest', () => {
    expect(tailClipRows('idle', 12)).toBe(12)
    expect(tailClipRows('replied', 8)).toBe(8)
  })
  it('never clips while a turn is running (nothing hidden mid-task)', () => {
    expect(tailClipRows('thinking', 12)).toBeNull()
    expect(tailClipRows('waiting', 12)).toBeNull()
  })
  it('shows everything when Forge found no boundary', () => {
    expect(tailClipRows('idle', null)).toBeNull()
    expect(tailClipRows('replied', 0)).toBeNull()
  })
})
