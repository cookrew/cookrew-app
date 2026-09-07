// THE RAIL'S ROWS, FROM ONE LISTING (one-stream T3).
//
// mergeCheckpointRows had a clamp, an earlier-segment drop and a uuid join
// because it was reconciling two coordinate systems. There is one listing
// now, so the interesting assertions are no longer "does the join survive a
// compaction" but "does the projection say the same thing the stream did" —
// including the two facts the old rail could not carry at all: a rolled-back
// position, and a compaction boundary derived from the row itself.

import { describe, expect, it } from 'vitest'
import {
  anomalyLine,
  checkpointRowTitle,
  focusedCheckpoint,
  identityOf,
  markersOfIndex,
  neighborWindow,
  rowsOfIndex,
  scrollFocusState,
  scrubPreviewRow,
  traceRowLabel
} from '../src/renderer/src/stream/stream-rows'
import type { StreamCheckpoint } from '../src/renderer/src/stream/stream-types'

const row = (ordinal: number, extra: Partial<StreamCheckpoint> = {}): StreamCheckpoint => ({
  identity: `u${ordinal}`,
  ordinal,
  startedAt: ordinal,
  endedAt: ordinal,
  promptHead: `prompt ${ordinal}`,
  compacted: false,
  file: '/s1.jsonl',
  ...extra
})

describe('rowsOfIndex — one position, one row, no phantoms', () => {
  it('keeps the stream ordinal as the rail coordinate', () => {
    const rows = rowsOfIndex([row(7), row(8)])
    expect(rows.map((r) => r.index)).toEqual([7, 8])
    expect(rows.map((r) => r.id)).toEqual(['u7', 'u8'])
  })

  it('carries the mark title and the seen-at onto the row', () => {
    const rows = rowsOfIndex([row(1, { marks: { title: 'fixed the seam', seenAt: 42 } })])
    expect(rows[0].title).toBe('fixed the seam')
    expect(rows[0].seenAt).toBe(42)
  })

  it('a rolled-back position is a row like any other, flagged', () => {
    const rows = rowsOfIndex([row(1), row(2, { rolledBack: true })])
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.rolledBack)).toEqual([false, true])
  })

  it('a compaction is an attribute of the row after it', () => {
    const rows = rowsOfIndex([row(1), row(2, { compacted: true })])
    expect(rows.map((r) => r.compacted)).toEqual([false, true])
  })
})

describe('markersOfIndex — the second fetch, replaced by arithmetic', () => {
  it('a declared boundary is a ◆ compact, carrying its token counts', () => {
    const markers = markersOfIndex([
      row(1),
      row(2, { compacted: true, compaction: { preTokens: 120_000, postTokens: 20_000 } })
    ])
    expect(markers).toEqual([
      { kind: 'compact', afterIndex: 1, preTokens: 120_000, postTokens: 20_000 }
    ])
  })

  it('a bare rotation with a predecessor is the ⇥ a /clear leaves behind', () => {
    const markers = markersOfIndex([row(1), row(2, { compacted: true, previousSessionId: 's0' })])
    expect(markers).toEqual([{ kind: 'clear', afterIndex: 1, previousSessionId: 's0' }])
  })

  it('a rollback note draws its own ⟲ boundary', () => {
    const markers = markersOfIndex([row(1), row(2), row(3)], [{ fromOrdinal: 3, at: 9 }])
    expect(markers).toEqual([{ kind: 'rewind', afterIndex: 2, toIndex: 2 }])
  })

  it('a rollback of the whole stream draws nothing — there is no row to sit after', () => {
    expect(markersOfIndex([row(1)], [{ fromOrdinal: 1, at: 9 }])).toEqual([])
  })

  it('markers come back ascending, whatever order they were found in', () => {
    const markers = markersOfIndex(
      [row(1), row(4, { compacted: true, compaction: {} })],
      [{ fromOrdinal: 3, at: 1 }]
    )
    expect(markers.map((m) => m.afterIndex)).toEqual([2, 3])
  })
})

describe('the dual title mode, now off the mark (item 5)', () => {
  const titled = rowsOfIndex([row(3, { marks: { title: 'fixed the seam' } })])[0]
  const untitled = rowsOfIndex([row(4)])[0]

  it('conclusion prefers the Sous title', () => {
    expect(checkpointRowTitle(titled, 'conclusion')).toBe('fixed the seam')
  })

  it('precise always shows the prompt, even where a title exists', () => {
    expect(checkpointRowTitle(titled, 'precise')).toBe('prompt 3')
  })

  it('conclusion falls back to the prompt when Sous has not titled it', () => {
    expect(checkpointRowTitle(untitled, 'conclusion')).toBe('prompt 4')
  })

  it('never blank: a row with neither reads as its ordinal', () => {
    const bare = rowsOfIndex([row(5, { promptHead: '   ' })])[0]
    expect(checkpointRowTitle(bare, 'conclusion')).toBe('T5')
    expect(checkpointRowTitle(bare, 'precise')).toBe('T5')
  })

  it('traceRowLabel keeps its own contract for the lineage panel', () => {
    expect(traceRowLabel(5, '')).toBe('T5')
    expect(traceRowLabel(5, 'wired the parser')).toBe('wired the parser')
  })
})

describe('focus and scrub over the row list', () => {
  const rows = rowsOfIndex([row(1), row(2), row(3), row(4)])

  it('a scrub fraction maps linearly onto the list', () => {
    expect(scrubPreviewRow(rows, 0)?.index).toBe(1)
    expect(scrubPreviewRow(rows, 1)?.index).toBe(4)
    expect(scrubPreviewRow(rows, 0.5)?.index).toBe(3)
  })

  it('an out-of-range fraction clamps rather than throwing', () => {
    expect(scrubPreviewRow(rows, -1)?.index).toBe(1)
    expect(scrubPreviewRow(rows, 1.5)?.index).toBe(4)
    expect(scrubPreviewRow([], 0.5)).toBeNull()
  })

  it('focus is null at the live tail and for an ordinal no row holds', () => {
    expect(focusedCheckpoint(rows, null)).toBeNull()
    expect(focusedCheckpoint(rows, 999)).toBeNull()
    expect(scrollFocusState(rows, null)).toEqual({ focusedIndex: null, listShown: false })
    expect(scrollFocusState(rows, 3)).toEqual({ focusedIndex: 3, listShown: true })
  })

  it('the neighbour window clamps at both ends', () => {
    expect(neighborWindow(rows, 1, 2).map((r) => r.index)).toEqual([1, 2, 3])
    expect(neighborWindow(rows, 4, 2).map((r) => r.index)).toEqual([2, 3, 4])
    expect(neighborWindow(rows, null, 2)).toEqual([])
  })

  it('identityOf turns a rail ordinal into the drawer’s page cursor', () => {
    expect(identityOf(rows, 3)).toBe('u3')
    expect(identityOf(rows, 99)).toBeNull()
  })
})

describe('the anomaly line — one quiet sentence, never a modal', () => {
  it('says nothing when the stream read every line', () => {
    expect(anomalyLine(0)).toBeNull()
    expect(anomalyLine(-1)).toBeNull()
  })

  it('counts, and says so in a sentence a person can read', () => {
    expect(anomalyLine(1)).toBe('1 line the stream could not read')
    expect(anomalyLine(12)).toBe('12 lines the stream could not read')
  })
})
