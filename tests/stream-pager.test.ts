// THE DRAWER'S WINDOWS, AND THE ONE FLAG THAT SEPARATES LIVE FROM REPLAY.
//
// Two things are asserted here and they are the two the old pager got wrong.
//
//   THE COORDINATE. A block off the wire carries `index` (its position inside
//   its own file) AND `ordinal` (its position in the whole chain). The drawer
//   is laid out in ordinals, so a window that forwarded `index` untouched
//   would render two different blocks at T1 on any card that has compacted.
//
//   THE SIDE EFFECTS. Live and replay render through the same code — same
//   blocks, same view model, same markup — and differ only by a flag. The
//   flag exists so that a page somebody scrolled to cannot move the view the
//   way the arrival of a live turn may.

import { describe, expect, it, vi } from 'vitest'
import { streamCoords, streamPagerOf } from '../src/renderer/src/stream/stream-pager'
import {
  mayFireSideEffects,
  renderSourceOf,
  streamBlockViewModel
} from '../src/renderer/src/stream/stream-view'
import type { StreamHandle } from '../src/renderer/src/stream/use-stream'
import type {
  StreamBlock,
  StreamCheckpoint,
  StreamTail
} from '../src/renderer/src/stream/stream-types'

/** A block whose in-file index and chain ordinal DISAGREE — the compacted
 *  card, which is the only interesting case. */
const block = (ordinal: number, inFile: number, over: Partial<StreamBlock> = {}): StreamBlock => ({
  id: `u${ordinal}`,
  index: inFile,
  ordinal,
  prompt: `prompt ${ordinal}`,
  reply: `reply ${ordinal}`,
  activity: [],
  startedAt: ordinal,
  endedAt: ordinal,
  compacted: false,
  file: '/s2.jsonl',
  sessionId: 's2',
  ...over
})

const row = (ordinal: number): StreamCheckpoint => ({
  identity: `u${ordinal}`,
  ordinal,
  startedAt: ordinal,
  endedAt: ordinal,
  promptHead: `prompt ${ordinal}`,
  compacted: false,
  file: '/s2.jsonl'
})

const handle = (
  over: Partial<StreamHandle> = {}
): { stream: StreamHandle; around: ReturnType<typeof vi.fn>; after: ReturnType<typeof vi.fn> } => {
  const around = vi.fn(async () => ({ blocks: [block(41, 1)], total: 60 }))
  const after = vi.fn(async () => ({ blocks: [block(42, 2)], total: 60 }))
  const stream = {
    index: [row(40), row(41), row(42)],
    rows: [],
    markers: [],
    tail: null,
    total: 60,
    blocks: {},
    blocksAround: around,
    blocksAfter: after,
    pageBack: async () => undefined,
    atOldest: true,
    markSeen: () => undefined,
    setTitle: () => undefined,
    pin: () => undefined,
    live: 'connected',
    anomalies: {},
    anomalyNote: null,
    rolledBack: [],
    error: null,
    opened: true,
    ...over
  } as unknown as StreamHandle
  return { stream, around, after }
}

describe('streamCoords — the drawer is laid out in chain ordinals', () => {
  it('replaces the in-file index with the ordinal', () => {
    expect(streamCoords(block(41, 1)).index).toBe(41)
  })

  it('passes every other field through untouched', () => {
    const source = block(41, 1, { reply: 'kept' })
    const mapped = streamCoords(source)
    expect(mapped.reply).toBe('kept')
    expect(mapped.prompt).toBe(source.prompt)
    expect(mapped.id).toBe(source.id)
  })

  it('never mutates the block it read — the reader extends its cache in place', () => {
    const source = block(41, 1)
    streamCoords(source)
    expect(source.index).toBe(1)
  })
})

describe('every window is named by an identity, never by an offset', () => {
  it('around() resolves the ordinal to its identity first', async () => {
    const { stream, around } = handle()
    await streamPagerOf(stream).around(41, 20)
    expect(around).toHaveBeenCalledWith('u41', 20)
  })

  it('after() asks for what FOLLOWS that identity', async () => {
    const { stream, after } = handle()
    await streamPagerOf(stream).after(41, 20)
    expect(after).toHaveBeenCalledWith('u41', 20)
  })

  it('tail() names the newest row — there is no "before the end" cursor', async () => {
    const { stream, around } = handle()
    await streamPagerOf(stream).tail(20)
    expect(around).toHaveBeenCalledWith('u42', 20)
  })

  it('an empty stream tails from the oldest rather than inventing a cursor', async () => {
    const { stream, after } = handle({ index: [] } as unknown as Partial<StreamHandle>)
    await streamPagerOf(stream).tail(20)
    expect(after).toHaveBeenCalledWith(null, 20)
  })

  it('an ordinal the index does not hold is an empty window, never a guess', async () => {
    const { stream, around } = handle()
    const page = await streamPagerOf(stream).around(999)
    expect(around).not.toHaveBeenCalled()
    expect(page.blocks).toEqual([])
  })

  it('windows come back in stream coordinates', async () => {
    const { stream } = handle()
    expect((await streamPagerOf(stream).around(41)).blocks.map((b) => b.index)).toEqual([41])
  })
})

describe('live and replay differ by a flag and by nothing else', () => {
  it('a window somebody scrolled or jumped to is replay', async () => {
    const { stream } = handle()
    expect((await streamPagerOf(stream).around(41)).render).toBe('replay')
  })

  it('ordinary growth and the tail are live', async () => {
    const { stream } = handle()
    expect((await streamPagerOf(stream).after(41)).render).toBe('live')
    expect((await streamPagerOf(stream).tail()).render).toBe('live')
  })

  it('only live may fire a side effect', () => {
    expect(mayFireSideEffects('live')).toBe(true)
    expect(mayFireSideEffects('replay')).toBe(false)
  })
})

describe('renderSourceOf — the OPEN tail is the only live block', () => {
  const openTail: StreamTail = { block: block(42, 2), final: false, ordinal: 42, total: 42 }
  const settled: StreamTail = { ...openTail, final: true }

  it('the open tail block is live', () => {
    expect(renderSourceOf(block(42, 2), openTail)).toBe('live')
  })

  it('a SETTLED tail is replay — a finished turn must not re-fire on a mark', () => {
    expect(renderSourceOf(block(42, 2), settled)).toBe('replay')
  })

  it('any earlier block is replay, however recently it closed', () => {
    expect(renderSourceOf(block(41, 1), openTail)).toBe('replay')
  })

  it('with no tail at all, everything is replay', () => {
    expect(renderSourceOf(block(41, 1), null)).toBe('replay')
    expect(renderSourceOf(block(41, 1), { ...openTail, block: null })).toBe('replay')
  })
})

describe('one view model, whichever way the block arrived (item 4)', () => {
  it('builds the same model from a block, with the title off the MARK', () => {
    const model = streamBlockViewModel(block(41, 1), { title: 'fixed the seam' })
    expect(model?.title).toBe('fixed the seam')
    expect(model?.ask).toBe('prompt 41')
    expect(model?.latest).toEqual({ text: 'reply 41', tone: 'done' })
  })

  it('a block with no mark still renders — the title is simply absent', () => {
    expect(streamBlockViewModel(block(41, 1))?.title).toBeNull()
  })

  it('nothing to show is null, not an empty card', () => {
    expect(streamBlockViewModel(null)).toBeNull()
    expect(streamBlockViewModel(block(41, 1, { prompt: '', reply: '' }))).toBeNull()
  })
})
