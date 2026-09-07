// F6 — MARKER ↔ FOCUSED ROW, SAME Y, IN EVERY STATE (permanent gate).
//
// The owner's standing rule: the here-marker on the bar and the FOCUSED
// checkpoint tag must sit on the same horizontal line, and this has regressed
// before. The eval that proves it is a screenshot at phone width; this file is
// the arithmetic underneath it, so a regression fails a unit run in seconds
// instead of waiting for a device.
//
// WHY IT KEPT REGRESSING. Two places computed a `top`. They agreed for the
// states somebody looked at, and a new state made them disagree by a pixel —
// a fan that centred itself near a boundary, a marker clamped onto an end of
// the bar for an ordinal no row held, the focused row drawn twice because the
// sampler also picked it. So the states are enumerated here from the STREAM
// REDUCER — every shape it can produce, including the two the old rail could
// not represent at all (a rolled-back row, and a row after a compaction).

import { describe, expect, it } from 'vitest'
import { fillRows, railAnchors } from '../src/renderer/src/rail-fill'
import { rowsOfIndex } from '../src/renderer/src/stream/stream-rows'
import {
  initialStreamState,
  streamReducer,
  type StreamState
} from '../src/renderer/src/stream/stream-reducer'
import type {
  StreamBlock,
  StreamCheckpoint,
  StreamOpen
} from '../src/renderer/src/stream/stream-types'

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

const block = (ordinal: number): StreamBlock => ({
  id: `u${ordinal}`,
  index: ordinal,
  ordinal,
  prompt: `prompt ${ordinal}`,
  reply: `reply ${ordinal}`,
  activity: [],
  startedAt: ordinal,
  endedAt: ordinal,
  compacted: false,
  file: '/s1.jsonl',
  sessionId: 's1'
})

const open = (index: StreamCheckpoint[]): StreamOpen => ({
  index,
  tail:
    index.length === 0
      ? null
      : {
          block: block(index[index.length - 1].ordinal),
          final: true,
          ordinal: index[index.length - 1].ordinal,
          total: index[index.length - 1].ordinal
        },
  backwardsCursor: null,
  source: 'file',
  anomalies: {},
  rolledBack: []
})

const from = (index: StreamCheckpoint[]): StreamState =>
  streamReducer(initialStreamState('t1'), { kind: 'open', open: open(index) })

const many = (n: number): StreamCheckpoint[] => Array.from({ length: n }, (_, i) => row(i + 1))

/** Every shape the reducer can hand the rail, named. */
const states: { name: string; state: StreamState }[] = [
  { name: 'empty', state: from([]) },
  { name: 'one row', state: from(many(1)) },
  { name: 'two rows', state: from(many(2)) },
  { name: 'a screenful', state: from(many(19)) },
  { name: 'a long history', state: from(many(122)) },
  {
    name: 'a compaction in the middle',
    state: from([row(1), row(2), row(3, { compacted: true }), row(4)])
  },
  {
    name: 'a rolled-back tail',
    state: streamReducer(from(many(6)), { kind: 'rollback', fromOrdinal: 4, at: 1 })
  },
  {
    name: 'a rolled-back tail that then grew again',
    state: streamReducer(
      streamReducer(from(many(6)), { kind: 'rollback', fromOrdinal: 4, at: 1 }),
      { kind: 'tail', tail: { block: block(7), final: false, ordinal: 7, total: 7 } }
    )
  },
  {
    name: 'a titled row',
    state: streamReducer(from(many(5)), {
      kind: 'mark',
      identity: 'u3',
      mark: { title: 'fixed the seam' }
    })
  }
]

/** Rail heights that have mattered: a phone overlay, a desktop sidebar, and
 *  the degenerate one that used to collapse the reveal to its two ends. */
const HEIGHTS = [0, 60, 136, 320, 669, 1080]

describe('F6 — the marker and the focused row are laid by ONE fraction', () => {
  for (const { name, state } of states) {
    const rows = rowsOfIndex(state.index)
    it(`agrees for every focusable row: ${name}`, () => {
      for (const target of rows) {
        // The fraction the rail feeds both is the focused row's own position
        // in identity space — the ONE position source of truth.
        const frac = rows.length <= 1 ? 1 : rows.indexOf(target) / (rows.length - 1)
        const { marker, focus } = railAnchors(frac, 1)
        expect(focus).not.toBeNull()
        expect(marker).toBe(focus)
      }
    })

    it(`draws no tab, and no second anchor, at the live tail: ${name}`, () => {
      const { marker, focus } = railAnchors(null, 1)
      expect(focus).toBeNull()
      expect(marker).toBe('calc(16px + 1 * (100% - 32px))')
    })
  }

  it('a fraction outside 0..1 still resolves ON the line, for both', () => {
    for (const frac of [-3, -0.0001, 1.0001, 42]) {
      const { marker, focus } = railAnchors(frac, 1)
      expect(marker).toBe(focus)
      expect(marker).toMatch(/^calc\(16px \+ [01] \* \(100% - 32px\)\)$/)
    }
  })
})

describe('F6 — the focused row is never drawn twice', () => {
  for (const { name, state } of states) {
    const rows = rowsOfIndex(state.index)
    if (rows.length === 0) continue
    it(`the laid reveal excludes the focus at every height: ${name}`, () => {
      for (const height of HEIGHTS) {
        for (const target of rows) {
          const laid = fillRows(rows, height, target.index)
          expect(laid.filter((entry) => entry.row?.index === target.index)).toHaveLength(0)
        }
      }
    })
  }
})

describe('F6 — a rolled-back row is still focusable, and still aligns', () => {
  const state = streamReducer(from(many(6)), { kind: 'rollback', fromOrdinal: 4, at: 1 })
  const rows = rowsOfIndex(state.index)

  it('keeps every rolled-back position in the list', () => {
    expect(rows).toHaveLength(6)
    expect(rows.filter((r) => r.rolledBack).map((r) => r.index)).toEqual([4, 5, 6])
  })

  it('anchors a rolled-back focus exactly as it anchors any other', () => {
    const at = rows.findIndex((r) => r.index === 5)
    const frac = at / (rows.length - 1)
    const { marker, focus } = railAnchors(frac, 1)
    expect(marker).toBe(focus)
  })
})
