import { describe, expect, it } from 'vitest'
import {
  activeBlockForScroll,
  blockMarkerFraction,
  evictTrace,
  isAtBottom,
  mergeTrace,
  pruneToTotal,
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
