import { describe, expect, it } from 'vitest'
import {
  activeBlockForScroll,
  blockMarkerFraction,
  evictTrace,
  isAtBottom,
  mergeTrace,
  pruneToTotal,
  railPointerFraction,
  railToScrollTop,
  scrollTopToFraction,
  tailClipRows,
  type TraceBlock
} from '../src/renderer/src/transcript'
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

describe('blockMarkerFraction (here-marker → block identity)', () => {
  it('pins to the live tail (1) when no block is active', () => {
    expect(blockMarkerFraction(null, 10)).toBe(1)
  })
  it('maps a global position to a fraction (oldest 0 → live 1)', () => {
    expect(blockMarkerFraction(0, 10)).toBe(0)
    expect(blockMarkerFraction(5, 10)).toBeCloseTo(0.5)
  })
  it('degrades gracefully with no blocks', () => {
    expect(blockMarkerFraction(0, 0)).toBe(1)
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
