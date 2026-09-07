// THE VIEW'S HALF OF ONE STREAM, AS ARITHMETIC (one-stream T3).
//
// The thing this replaces failed in a way tests could not reach: two fetches
// were joined inside a component, so "what does the rail believe" had no name
// and no value you could assert on. Every transition is a pure function now,
// and this file is the whole contract — open, live tail, mark, rollback, page
// back — driven with no network, no clock and no React.

import { describe, expect, it } from 'vitest'
import {
  anomalyCount,
  initialStreamState,
  mergeIndex,
  rowOfBlock,
  streamReducer,
  type StreamState
} from '../src/renderer/src/stream/stream-reducer'
import type {
  StreamBlock,
  StreamCheckpoint,
  StreamOpen,
  StreamTail
} from '../src/renderer/src/stream/stream-types'

const row = (ordinal: number, extra: Partial<StreamCheckpoint> = {}): StreamCheckpoint => ({
  identity: `u${ordinal}`,
  ordinal,
  startedAt: 1000 + ordinal,
  endedAt: 1100 + ordinal,
  promptHead: `prompt ${ordinal}`,
  compacted: false,
  file: '/s1.jsonl',
  ...extra
})

const block = (ordinal: number, extra: Partial<StreamBlock> = {}): StreamBlock => ({
  id: `u${ordinal}`,
  index: ordinal,
  ordinal,
  prompt: `prompt ${ordinal}`,
  reply: `reply ${ordinal}`,
  activity: [],
  startedAt: 1000 + ordinal,
  endedAt: 1100 + ordinal,
  compacted: false,
  file: '/s1.jsonl',
  sessionId: 's1',
  ...extra
})

const openPayload = (over: Partial<StreamOpen> = {}): StreamOpen => ({
  index: [row(1), row(2), row(3)],
  tail: { block: block(3), final: true, ordinal: 3, total: 3 },
  backwardsCursor: null,
  source: 'file',
  anomalies: {},
  rolledBack: [],
  ...over
})

const opened = (over: Partial<StreamOpen> = {}): StreamState =>
  streamReducer(initialStreamState('t1'), { kind: 'open', open: openPayload(over) })

describe('open — the whole first paint, in one answer', () => {
  it('seeds the rail ascending by ordinal, whatever order the page arrived in', () => {
    const state = streamReducer(initialStreamState('t1'), {
      kind: 'open',
      open: openPayload({ index: [row(3), row(1), row(2)] })
    })
    expect(state.index.map((r) => r.ordinal)).toEqual([1, 2, 3])
    expect(state.opened).toBe(true)
  })

  it('caches the tail block by identity so the drawer needs no second read', () => {
    expect(Object.keys(opened().blocks)).toEqual(['u3'])
  })

  it('takes the stream length from the tail, not from how many rows arrived', () => {
    const state = streamReducer(initialStreamState('t1'), {
      kind: 'open',
      open: openPayload({
        index: [row(98), row(99), row(100)],
        tail: { block: block(100), final: true, ordinal: 100, total: 100 }
      })
    })
    expect(state.total).toBe(100)
    expect(state.index).toHaveLength(3)
  })

  it('carries the anomaly counts and the rollback notes rather than dropping them', () => {
    const state = opened({ anomalies: { UnknownLine: 2, Gap: 1 }, rolledBack: [] })
    expect(anomalyCount(state.anomalies)).toBe(3)
  })

  it('replays the open rollback notes over rows a server had not flagged yet', () => {
    const state = opened({
      index: [row(1), row(2), row(3)],
      rolledBack: [{ fromOrdinal: 3, at: 5 }]
    })
    expect(state.index.map((r) => r.rolledBack === true)).toEqual([false, false, true])
  })
})

describe('the live tail patches the last row, or appends a new one', () => {
  it('patches the row it already holds instead of adding a duplicate', () => {
    const growing: StreamTail = {
      block: block(3, { reply: 'reply 3 — longer now' }),
      final: false,
      ordinal: 3,
      total: 3
    }
    const state = streamReducer(opened(), { kind: 'tail', tail: growing })
    expect(state.index).toHaveLength(3)
    expect(state.blocks.u3.reply).toBe('reply 3 — longer now')
  })

  it('appends the new position when a turn starts, without an index re-read', () => {
    const started: StreamTail = { block: block(4), final: false, ordinal: 4, total: 4 }
    const state = streamReducer(opened(), { kind: 'tail', tail: started })
    expect(state.index.map((r) => r.ordinal)).toEqual([1, 2, 3, 4])
    expect(state.total).toBe(4)
  })

  it('keeps the marks already on a row when its block is refreshed', () => {
    const titled = streamReducer(opened(), {
      kind: 'mark',
      identity: 'u3',
      mark: { title: 'fixed the seam' }
    })
    const state = streamReducer(titled, {
      kind: 'tail',
      tail: { block: block(3, { reply: 'more' }), final: false, ordinal: 3, total: 3 }
    })
    expect(state.index[2].marks?.title).toBe('fixed the seam')
  })

  it('an empty tail is a length, not a row — nothing is invented', () => {
    const state = streamReducer(initialStreamState('t1'), {
      kind: 'tail',
      tail: { block: null, final: false, ordinal: null, total: 0 }
    })
    expect(state.index).toEqual([])
    expect(state.total).toBe(0)
  })
})

describe('a mark patches exactly one row', () => {
  it('sets a title on its own identity and leaves its neighbours alone', () => {
    const state = streamReducer(opened(), {
      kind: 'mark',
      identity: 'u2',
      mark: { title: 'wired the parser' }
    })
    expect(state.index.map((r) => r.marks?.title)).toEqual([
      undefined,
      'wired the parser',
      undefined
    ])
  })

  it('a null mark CLEARS — a withdrawn title is a change, not an absence', () => {
    const titled = streamReducer(opened(), {
      kind: 'mark',
      identity: 'u2',
      mark: { title: 'wired the parser' }
    })
    const cleared = streamReducer(titled, { kind: 'mark', identity: 'u2', mark: null })
    expect(cleared.index[1].marks).toBeUndefined()
  })

  it('a mark for an identity the rail does not hold changes nothing', () => {
    const state = streamReducer(opened(), { kind: 'mark', identity: 'nope', mark: { pin: 4 } })
    expect(state.index.map((r) => r.marks)).toEqual([undefined, undefined, undefined])
  })
})

describe('rollback marks, and never removes', () => {
  it('flags every row from the rewound ordinal onward and keeps them all', () => {
    const state = streamReducer(opened(), { kind: 'rollback', fromOrdinal: 2, at: 9 })
    expect(state.index).toHaveLength(3)
    expect(state.index.map((r) => r.rolledBack === true)).toEqual([false, true, true])
  })

  it('records the note so the rail can draw a ⟲ boundary for it', () => {
    const state = streamReducer(opened(), { kind: 'rollback', fromOrdinal: 2, at: 9 })
    expect(state.rolledBack).toEqual([{ fromOrdinal: 2, at: 9 }])
  })

  it('the same note twice is one note — a re-open must not double the ledger', () => {
    const once = streamReducer(opened(), { kind: 'rollback', fromOrdinal: 2, at: 9 })
    const twice = streamReducer(once, { kind: 'rollback', fromOrdinal: 2, at: 11 })
    expect(twice.rolledBack).toHaveLength(1)
  })

  it('a rolled-back row stays addressable — its identity is still in the index', () => {
    const state = streamReducer(opened(), { kind: 'rollback', fromOrdinal: 3, at: 9 })
    expect(state.index.find((r) => r.identity === 'u3')).toBeDefined()
  })
})

describe('paging back', () => {
  it('prepends older rows and keeps one ascending order', () => {
    const newest = opened({
      index: [row(5), row(6), row(7)],
      tail: { block: block(7), final: true, ordinal: 7, total: 7 },
      backwardsCursor: 'u5'
    })
    const state = streamReducer(newest, {
      kind: 'index',
      checkpoints: [row(4), row(3)],
      backwardsCursor: null
    })
    expect(state.index.map((r) => r.ordinal)).toEqual([3, 4, 5, 6, 7])
    expect(state.backwardsCursor).toBeNull()
  })

  it('a page that carries no marks does not erase the ones already shown', () => {
    const titled = streamReducer(opened(), {
      kind: 'mark',
      identity: 'u2',
      mark: { title: 'kept' }
    })
    const paged = streamReducer(titled, { kind: 'index', checkpoints: [row(2)] })
    expect(paged.index[1].marks?.title).toBe('kept')
  })

  it('an incoming row wins on the stream’s own facts', () => {
    const paged = streamReducer(opened(), {
      kind: 'index',
      checkpoints: [row(2, { promptHead: 'corrected', compacted: true })]
    })
    expect(paged.index[1].promptHead).toBe('corrected')
    expect(paged.index[1].compacted).toBe(true)
  })
})

describe('block pages fold into the same one index', () => {
  it('caches by identity and derives the rows it did not have', () => {
    const state = streamReducer(initialStreamState('t1'), {
      kind: 'blocks',
      blocks: [block(1), block(2)],
      marks: { u2: { title: 'from the page' } },
      total: 9
    })
    expect(Object.keys(state.blocks).sort()).toEqual(['u1', 'u2'])
    expect(state.index.map((r) => r.ordinal)).toEqual([1, 2])
    expect(state.index[1].marks?.title).toBe('from the page')
    expect(state.total).toBe(9)
  })

  it('a page over a rolled-back row does not resurrect it', () => {
    const rolled = streamReducer(opened(), { kind: 'rollback', fromOrdinal: 3, at: 1 })
    const state = streamReducer(rolled, { kind: 'blocks', blocks: [block(3)] })
    expect(state.index[2].rolledBack).toBe(true)
  })
})

describe('immutability — the reader extends its cache in place, so we never touch it', () => {
  it('every transition returns a new state and leaves the old one intact', () => {
    const before = opened()
    const snapshot = JSON.stringify(before)
    const after = streamReducer(before, { kind: 'rollback', fromOrdinal: 1, at: 1 })
    expect(after).not.toBe(before)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('mergeIndex does not mutate either input array', () => {
    const current = [row(1)]
    const incoming = [row(2)]
    mergeIndex(current, incoming)
    expect(current).toHaveLength(1)
    expect(incoming).toHaveLength(1)
  })
})

describe('reset — switching cards cannot leak the previous one', () => {
  it('clears every field, including the anomalies and the rollback notes', () => {
    const dirty = streamReducer(opened({ anomalies: { Gap: 3 } }), {
      kind: 'rollback',
      fromOrdinal: 1,
      at: 1
    })
    const fresh = streamReducer(dirty, { kind: 'reset', terminalId: 't2' })
    expect(fresh).toEqual(initialStreamState('t2'))
  })
})

describe('rowOfBlock — the rail row a live tail implies', () => {
  it('heads the prompt the way the light index does, and never blank', () => {
    expect(rowOfBlock(block(1, { prompt: '' }), undefined).promptHead).toBe('(empty prompt)')
    expect(rowOfBlock(block(1, { prompt: '\n  second line' }), undefined).promptHead).toBe(
      'second line'
    )
  })

  it('caps a long first line at the index’s own 120 characters', () => {
    const long = 'x'.repeat(400)
    expect(rowOfBlock(block(1, { prompt: long }), undefined).promptHead).toHaveLength(120)
  })
})
