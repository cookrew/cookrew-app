import { describe, expect, it } from 'vitest'
import {
  activeCheckpointIndex,
  checkpointDepth,
  checkpointProgress,
  checkpointTitle,
  gotoCursor,
  markerFraction
} from '../src/renderer/src/checkpoint-sync'
import type { TurnRecord } from '../src/shared/turn'

const record = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  index: 1,
  prompt: 'do the thing\nwith a newline',
  reply: 'done',
  startedAt: 0,
  endedAt: 1,
  ...over
})

describe('checkpointTitle (item 3 dual title mode)', () => {
  it('conclusion mode prefers the Sous title', () => {
    expect(checkpointTitle(record({ title: 'Did the thing' }), 'conclusion')).toBe('Did the thing')
  })

  it('conclusion mode falls back to the prompt when no title', () => {
    expect(checkpointTitle(record({ title: undefined }), 'conclusion')).toBe(
      'do the thing\nwith a newline'
    )
  })

  it('precise mode always shows the exact prompt incl. newlines', () => {
    expect(checkpointTitle(record({ title: 'Did the thing' }), 'precise')).toBe(
      'do the thing\nwith a newline'
    )
  })

  it('handles an empty prompt gracefully', () => {
    expect(checkpointTitle(record({ title: undefined, prompt: '' }), 'precise')).toBe(
      '(empty prompt)'
    )
  })
})

// Monotonic contract: scrollBase = current tmux history_size; a checkpoint's
// depth (lines above the live bottom) = scrollBase − scrollLine. Older = larger
// depth. Here scrollBase = 100, so T1 depth 100, T2 depth 50, T3 depth 10.
const records = [
  { index: 1, scrollLine: 0 }, // oldest, depth 100
  { index: 2, scrollLine: 50 }, // depth 50
  { index: 3, scrollLine: 90 } // newest, depth 10
]
const BASE = 100

describe('activeCheckpointIndex (item 2 scroll→checkpoint, monotonic units)', () => {
  it('is null without a scroll base', () => {
    expect(activeCheckpointIndex(records, null, 30)).toBeNull()
  })

  it('maps a scroll position to the checkpoint whose content contains it', () => {
    expect(activeCheckpointIndex(records, BASE, 5)).toBe(3) // [0,10) → newest
    expect(activeCheckpointIndex(records, BASE, 30)).toBe(2) // [10,50) → T2
    expect(activeCheckpointIndex(records, BASE, 70)).toBe(1) // [50,100) → oldest
  })

  it('at a boundary belongs to the newer checkpoint above it', () => {
    expect(activeCheckpointIndex(records, BASE, 10)).toBe(2) // depth 10 is T3's prompt; 10 → T2 region
    expect(activeCheckpointIndex(records, BASE, 50)).toBe(1)
  })

  it('scrolled above the oldest clamps to the oldest', () => {
    expect(activeCheckpointIndex(records, BASE, 999)).toBe(1)
  })

  it('skips records without an offset', () => {
    const mixed = [{ index: 1, scrollLine: 0 }, { index: 2 }, { index: 3, scrollLine: 90 }]
    expect(activeCheckpointIndex(mixed, BASE, 5)).toBe(3)
    expect(activeCheckpointIndex(mixed, BASE, 40)).toBe(1)
  })
})

describe('markerFraction (item 4 you-are-here marker)', () => {
  it('pins to the live bottom (1) at the tail', () => {
    expect(markerFraction(null, BASE)).toBe(1)
    expect(markerFraction(0, BASE)).toBe(1)
  })

  it('moves toward the top (0) as the scroll goes up', () => {
    expect(markerFraction(50, BASE)).toBeCloseTo(0.5)
    expect(markerFraction(100, BASE)).toBe(0)
  })

  it('clamps and degrades gracefully', () => {
    expect(markerFraction(200, BASE)).toBe(0)
    expect(markerFraction(20, null)).toBe(1)
    expect(markerFraction(20, 0)).toBe(1)
  })
})

describe('checkpointProgress (item 4 intra-checkpoint --p)', () => {
  it('is 0 at the checkpoint start (floor) and 1 at its prompt (top)', () => {
    // T2 content = [10, 50): floor 10, top 50.
    expect(checkpointProgress(records, 2, BASE, 10)).toBe(0)
    expect(checkpointProgress(records, 2, BASE, 50)).toBe(1)
    expect(checkpointProgress(records, 2, BASE, 30)).toBeCloseTo(0.5)
  })

  it('the newest checkpoint runs from the bottom (floor 0)', () => {
    // T3 content = [0, 10).
    expect(checkpointProgress(records, 3, BASE, 5)).toBeCloseTo(0.5)
  })

  it('is 0 without data or for an unknown checkpoint', () => {
    expect(checkpointProgress(records, 2, null, 30)).toBe(0)
    expect(checkpointProgress(records, 2, BASE, null)).toBe(0)
    expect(checkpointProgress(records, 99, BASE, 30)).toBe(0)
  })
})

describe('checkpointDepth (forward-jump echo prediction)', () => {
  it('returns the checkpoint depth = scrollBase − scrollLine', () => {
    expect(checkpointDepth(records, 2, BASE)).toBe(50)
    expect(checkpointDepth(records, 3, BASE)).toBe(10)
  })

  it('is null without a base or offset', () => {
    expect(checkpointDepth(records, 2, null)).toBeNull()
    expect(checkpointDepth([{ index: 1 }], 1, BASE)).toBeNull()
  })
})

/**
 * REFACTOR GUARD (checkpoint-as-identity) — the card pager / TurnPagerBar.
 *
 * useTurnPaging holds a `cursor`, which is an ARRAY POSITION into the fetched
 * records, but everything the user sees and acts on is an IDENTITY:
 * TurnPagerBar prints `CHECKPOINT {viewing.index}` and fork sends
 * `records[cursor].index`. gotoCursor is the one place those two coordinate
 * systems meet, so it is where a position/identity mix-up becomes a silent
 * wrong-checkpoint action rather than a crash.
 *
 * The hook itself needs a DOM (this repo has no jsdom), so these pin its pure
 * resolver — which is the part the refactor can actually break.
 */
describe('gotoCursor — the pager resolves identity, never array position', () => {
  /** A capped/rewound history: indexes are sparse and do NOT equal positions. */
  const sparse = [{ index: 7 }, { index: 8 }, { index: 12 }, { index: 30 }]

  it('resolves a checkpoint index to its position, not to itself', () => {
    // The whole bug class in one line: checkpoint 12 lives at position 2.
    expect(gotoCursor(sparse, 12)).toBe(2)
    expect(gotoCursor(sparse, 7)).toBe(0)
    expect(gotoCursor(sparse, 30)).toBe(3)
  })

  it('never treats the index as an offset into the array', () => {
    // If identity ever collapsed back into position, asking for checkpoint 30
    // on a 4-element list would read past the end (or clamp to the tail).
    const at = gotoCursor(sparse, 30)
    expect(at).not.toBeNull()
    expect(sparse[at as number].index).toBe(30)
  })

  it('returns null for a checkpoint that is not loaded, so the caller can stay put', () => {
    // A trace-only row below the record window: the rail may offer it, the
    // pager cannot page to it. Null is the honest answer — clamping to 0 would
    // silently show checkpoint 7 while the rail says 3.
    expect(gotoCursor(sparse, 3)).toBeNull()
    expect(gotoCursor(sparse, 31)).toBeNull()
    expect(gotoCursor([], 1)).toBeNull()
  })

  it('survives a rewind that shifts every position under a stable identity', () => {
    // Same checkpoints, earlier ones dropped: identity 12 keeps resolving to
    // whatever position it now occupies.
    const afterRewind = [{ index: 12 }, { index: 30 }]
    expect(gotoCursor(afterRewind, 12)).toBe(0)
    expect(gotoCursor(sparse, 12)).toBe(2)
  })

  it('is exact: a near-miss index is a miss, not the nearest row', () => {
    expect(gotoCursor(sparse, 11)).toBeNull()
    expect(gotoCursor(sparse, 13)).toBeNull()
  })
})
