import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeBlockForScroll,
  coalescingSingleFlight,
  evictTrace,
  isAtBottom,
  firstUnloadedInView,
  fractionOfIdentity,
  identityAtFraction,
  jumpScrollBehavior,
  checkpointRowTitle,
  createHoldReveal,
  focusedCheckpoint,
  mergeCheckpointRows,
  mergeTrace,
  railDrive,
  scrubPreviewRow,
  pruneToTotal,
  railPointerFraction,
  refineEstimate,
  tailClipRows,
  traceRowLabel,
  warnAbsentBridge,
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

  it('cap-full jump: ingesting a far window keeps length at the cap yet loads the target', () => {
    // The effect-dep trap: with the cap FULL, merging the aroundIndex window
    // then evicting back leaves blocks.length UNCHANGED (60 → 60), so a
    // length-keyed effect never re-fires — but the target IS present, so the
    // jump must scroll imperatively rather than wait on a length change.
    const loaded = Array.from({ length: 60 }, (_, i) => block(i + 54)) // T54..T113
    const jumpWindow = Array.from({ length: 20 }, (_, i) => block(i + 1)) // T1..T20
    const kept = evictTrace(mergeTrace(loaded, jumpWindow), 1, 60) // anchor on target T1
    expect(kept).toHaveLength(60) // length did NOT change
    expect(kept.some((b) => b.index === 1)).toBe(true) // …yet T1 is now loaded
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
  it('clamps phantom record rows beyond the trace ceiling (root dependency)', () => {
    // Interim coordinate mismatch: records number to T40 while the trace ceils
    // at T38 → the two extra record rows are phantoms that map to no block.
    const recs = Array.from({ length: 40 }, (_, i) => record(i + 1)) // T1..T40
    const idx = Array.from({ length: 38 }, (_, i) => ({ index: i + 1, title: `t${i + 1}` })) // T1..T38
    const rows = mergeCheckpointRows(recs, idx)
    expect(rows[rows.length - 1].index).toBe(38) // rail ceiling == trace ceiling
    expect(rows.find((r) => r.index === 39)).toBeUndefined()
    expect(rows.find((r) => r.index === 40)).toBeUndefined()
  })
})

describe('scrub-preview title (bug 1 redo: titles visible while scrubbing)', () => {
  const record = (index: number, title?: string): TurnRecord => ({
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    ...(title ? { title } : {}),
    startedAt: 0,
    endedAt: 1
  })
  // Sparse rows: T1 trace-only (no record), T2..T4 record-backed with titles.
  const rows = mergeCheckpointRows(
    [record(2, 'wired the parser'), record(3, 'fixed the seam'), record(4, 'shipped it')],
    [
      { index: 1, title: 't1 snippet' },
      { index: 2, title: '' },
      { index: 3, title: '' },
      { index: 4, title: '' }
    ]
  )

  describe('scrubPreviewRow (fraction/position → row)', () => {
    it('maps the ends and the middle of the drag to a row', () => {
      expect(scrubPreviewRow(rows, 0)?.index).toBe(1)
      expect(scrubPreviewRow(rows, 1)?.index).toBe(4)
      expect(scrubPreviewRow(rows, 0.5)?.index).toBe(3) // rounds to list middle
    })
    it('clamps an over-drag and is null for no rows', () => {
      expect(scrubPreviewRow(rows, 1.5)?.index).toBe(4)
      expect(scrubPreviewRow([], 0.5)).toBeNull()
    })
  })

  describe('checkpointRowTitle (row → title)', () => {
    it('uses the record title in conclusion mode', () => {
      const t3 = scrubPreviewRow(rows, 0.5)! // T3
      expect(checkpointRowTitle(t3, 'conclusion')).toBe('fixed the seam')
    })
    it('uses the precise prompt in precise mode', () => {
      const t3 = scrubPreviewRow(rows, 0.5)!
      expect(checkpointRowTitle(t3, 'precise')).toBe('prompt 3')
    })
    it('falls back to the trace snippet / T<n> for a trace-only row', () => {
      const t1 = scrubPreviewRow(rows, 0)! // trace-only
      expect(checkpointRowTitle(t1, 'conclusion')).toBe('t1 snippet')
    })
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

describe('jumpScrollBehavior (item 2b: touch cancels smooth mid-flight)', () => {
  it('snaps instantly on a coarse pointer or an active touch', () => {
    expect(jumpScrollBehavior({ landed: false, coarsePointer: true, touchActive: false })).toBe('auto')
    expect(jumpScrollBehavior({ landed: false, coarsePointer: false, touchActive: true })).toBe('auto')
  })
  it('snaps instantly for a just-landed far fetch', () => {
    expect(jumpScrollBehavior({ landed: true, coarsePointer: false, touchActive: false })).toBe('auto')
  })
  it('is smooth only for a nearby mouse-driven target', () => {
    expect(jumpScrollBehavior({ landed: false, coarsePointer: false, touchActive: false })).toBe('smooth')
  })
})

describe('traceRowLabel (item 2c: never blank before the index lands)', () => {
  it('falls back to the T<n> identity when the trace title is empty', () => {
    expect(traceRowLabel(5, '')).toBe('T5')
    expect(traceRowLabel(5, '   ')).toBe('T5')
  })
  it('uses the trace title when present', () => {
    expect(traceRowLabel(5, 'wired the parser')).toBe('wired the parser')
  })
})

describe('warnAbsentBridge (LOUD absent-bridge rule)', () => {
  afterEach(() => vi.restoreAllMocks())
  it('logs once per method name, then stays quiet', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnAbsentBridge('bridgeTestAlpha')
    warnAbsentBridge('bridgeTestAlpha')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('bridgeTestAlpha')
  })
  it('logs each distinct method the first time', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnAbsentBridge('bridgeTestBeta')
    warnAbsentBridge('bridgeTestGamma')
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

// ---- identity-space virtualization (scroll-model rebuild) ----
// SPARSE fixture: 113 identities, only the T1 group + the tail loaded, the whole
// middle (T2..T99) unloaded — the exact geometry that broke the old model.
describe('identity-space virtualization (sparse fixtures)', () => {
  const identities = Array.from({ length: 113 }, (_, i) => i + 1) // T1..T113 (contiguous)
  const loaded = new Set<number>([1, ...Array.from({ length: 14 }, (_, i) => i + 100)]) // T1 + T100..T113

  describe('identityAtFraction (scrub → target identity)', () => {
    it('maps the ends and the MIDDLE of a huge unloaded gap', () => {
      expect(identityAtFraction(identities, 0)).toBe(1)
      expect(identityAtFraction(identities, 1)).toBe(113)
      // scrub-to-middle lands on a MIDDLE identity (a placeholder) — not a
      // loaded-group edge (T1 or T100) as the old pixel model did.
      expect(identityAtFraction(identities, 0.5)).toBe(57)
    })
    it('clamps out-of-range fractions', () => {
      expect(identityAtFraction(identities, -1)).toBe(1)
      expect(identityAtFraction(identities, 2)).toBe(113)
    })
    it('works on NON-contiguous identities (sibling-collapse gaps)', () => {
      const sparse = [1, 2, 5, 6, 100]
      expect(identityAtFraction(sparse, 0.5)).toBe(5) // list position, not value
      expect(identityAtFraction([], 0.5)).toBeNull()
    })
  })

  describe('fractionOfIdentity (here-marker, linear in identity)', () => {
    it('is linear over the list position, spanning the full range', () => {
      expect(fractionOfIdentity(identities, 1)).toBe(0)
      expect(fractionOfIdentity(identities, 113)).toBe(1)
      expect(fractionOfIdentity(identities, 57)).toBeCloseTo(0.5)
    })
    it('round-trips with identityAtFraction at the middle', () => {
      const mid = identityAtFraction(identities, 0.5)!
      expect(fractionOfIdentity(identities, mid)).toBeCloseTo(0.5, 1)
    })
    it('pins to live (1) for an unknown id or a degenerate list', () => {
      expect(fractionOfIdentity(identities, 9999)).toBe(1)
      expect(fractionOfIdentity([1], 1)).toBe(1)
    })
  })

  describe('firstUnloadedInView (scroll into a placeholder → fetch it)', () => {
    it('returns the first placeholder identity scrolled into', () => {
      // scrolling down out of the T1 group into the gap → next visible is T2..
      expect(firstUnloadedInView([1, 2, 3], loaded)).toBe(2)
      // scrubbed to the middle → the middle identities are placeholders
      expect(firstUnloadedInView([56, 57, 58], loaded)).toBe(56)
    })
    it('is null when every visible identity is already loaded', () => {
      expect(firstUnloadedInView([100, 101, 102], loaded)).toBeNull()
      expect(firstUnloadedInView([1], loaded)).toBeNull()
    })
  })

  describe('refineEstimate (placeholder height refines as blocks measure)', () => {
    it('averages usable measurements', () => {
      expect(refineEstimate(90, [100, 140])).toBe(120)
    })
    it('keeps the prior estimate when nothing usable was measured (no layout)', () => {
      expect(refineEstimate(90, [])).toBe(90)
      expect(refineEstimate(90, [0, 0])).toBe(90) // jsdom-style zero heights
    })
  })
})

describe('coalescingSingleFlight (HIGH: rapid second far-jump not starved)', () => {
  it('runs the first, skips the intermediate, serves the LATEST', async () => {
    const calls: number[] = []
    const resolvers: Record<number, () => void> = {}
    const run = (id: number): Promise<void> => {
      calls.push(id)
      return new Promise<void>((res) => {
        resolvers[id] = res
      })
    }
    const sf = coalescingSingleFlight(run)
    sf.request(1) // fires immediately (A in flight)
    sf.request(2) // deferred
    sf.request(3) // deferred, latest wanted = 3
    expect(calls).toEqual([1]) // single-flight: only A running

    resolvers[1]() // A settles
    await Promise.resolve()
    await Promise.resolve()
    // The intermediate (2) is skipped; the LATEST (3) is served — never starved.
    expect(calls).toEqual([1, 3])

    resolvers[3]()
    await Promise.resolve()
    await Promise.resolve()
    // Nothing pending → no further runs.
    sf.request(3)
    // already the last-run id but flight is idle → it re-runs on explicit request
    expect(calls).toEqual([1, 3, 3])
  })

  it('runs a lone request immediately and settles clean', async () => {
    const calls: number[] = []
    const run = (id: number): Promise<void> => {
      calls.push(id)
      return Promise.resolve()
    }
    const sf = coalescingSingleFlight(run)
    sf.request(7)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([7])
  })
})

describe('focusedCheckpoint (v3 State A: single-tab tracks the focused chapter)', () => {
  const rows = mergeCheckpointRows(
    [],
    [
      { index: 7, title: 'seven' },
      { index: 8, title: 'eight' },
      { index: 9, title: 'nine' }
    ]
  )
  it('returns the row for the active identity in view', () => {
    expect(focusedCheckpoint(rows, 8)?.index).toBe(8)
  })
  it('is null at the live tail (no checkpoint focused)', () => {
    expect(focusedCheckpoint(rows, null)).toBeNull()
  })
  it('is null for an identity not among the rows', () => {
    expect(focusedCheckpoint(rows, 999)).toBeNull()
  })
})

describe('createHoldReveal (v3: hold a tab/row to reveal its actions)', () => {
  afterEach(() => vi.useRealTimers())

  it('reveals the index after the hold duration', () => {
    vi.useFakeTimers()
    const revealed: number[] = []
    const hr = createHoldReveal((i) => revealed.push(i), 1500)
    hr.start(42)
    vi.advanceTimersByTime(1499)
    expect(revealed).toEqual([]) // not yet
    vi.advanceTimersByTime(1)
    expect(revealed).toEqual([42]) // held long enough
  })
  it('a release BEFORE the hold (a plain tap) reveals nothing', () => {
    vi.useFakeTimers()
    const revealed: number[] = []
    const hr = createHoldReveal((i) => revealed.push(i), 1500)
    hr.start(42)
    vi.advanceTimersByTime(600)
    hr.cancel() // tap released early
    vi.advanceTimersByTime(2000)
    expect(revealed).toEqual([])
  })
  it('a new press supersedes the previous pending hold', () => {
    vi.useFakeTimers()
    const revealed: number[] = []
    const hr = createHoldReveal((i) => revealed.push(i), 1500)
    hr.start(1)
    vi.advanceTimersByTime(1000)
    hr.start(2) // moved to another row before the first fired
    vi.advanceTimersByTime(1500)
    expect(revealed).toEqual([2]) // only the latest hold reveals
  })
})

describe('railDrive (v3 two-zone routing: rail-drag opens+drives the full list)', () => {
  const rows = mergeCheckpointRows(
    [],
    [
      { index: 1, title: 'a' },
      { index: 2, title: 'b' },
      { index: 3, title: 'c' }
    ]
  )
  it('a rail DRAG opens the list and anchors on the checkpoint under the drag', () => {
    expect(railDrive(rows, 0, true)).toEqual({ openList: true, anchorIndex: 1 })
    expect(railDrive(rows, 0.5, true)).toEqual({ openList: true, anchorIndex: 2 })
    expect(railDrive(rows, 1, true)).toEqual({ openList: true, anchorIndex: 3 })
  })
  it('a non-drag (tap / no travel) does NOT open the list (that is the tap-opener)', () => {
    expect(railDrive(rows, 0.5, false)).toEqual({ openList: false, anchorIndex: null })
  })
  it('opens with a null anchor on an empty list', () => {
    expect(railDrive([], 0.5, true)).toEqual({ openList: true, anchorIndex: null })
  })
})
