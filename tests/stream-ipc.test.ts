// ONE STREAM, THE DESKTOP'S DOOR (T3).
//
// T2 put the stream behind HTTP, which is the wire the COMPANION has. The
// desktop renderer has no origin to fetch, so without these five reads "the
// renderer reads one stream" would have been true of the phone and false of
// the Mac — and the desktop rail would have rendered nothing at all.
//
// What is asserted is the CONTRACT the hook is written against, not the
// plumbing: an open that carries the newest screenful plus a cursor for the
// rest, pages named by identity in both directions, an unknown cursor that is
// an empty page rather than a silent restart, anomalies counted rather than
// swallowed, and a door card answering the same shape as a file card.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { markFileFor, readMarks, writeMark } from '../src/main/marks'
import {
  STREAM_OPEN_ROWS,
  streamBlocks,
  streamIndex,
  streamMarks,
  streamOpen,
  streamTail,
  type StreamIpcDeps
} from '../src/main/stream-ipc'
import type { StreamBlock } from '../src/main/stream'
import type { StreamService, StreamTailState } from '../src/main/stream-service'
import type { StreamChain } from '../src/main/stream-chain'
import type { TranscriptSource } from '../src/main/transcript-source'
import type { TurnRecord } from '../src/shared/turn'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')

const block = (ordinal: number): StreamBlock => ({
  id: `u${ordinal}`,
  index: ordinal,
  ordinal,
  prompt: `prompt ${ordinal}`,
  reply: `reply ${ordinal}`,
  activity: [],
  startedAt: T0 + ordinal,
  endedAt: T0 + ordinal + 1,
  compacted: false,
  file: '/tmp/s1.jsonl',
  sessionId: 's1'
})

const CHAIN: StreamChain = {
  files: [{ sessionId: 's1', file: '/tmp/s1.jsonl', kind: 'claude' }],
  missing: []
}

let marksDir = ''

function deps(options: {
  blocks?: StreamBlock[]
  source?: TranscriptSource
  missing?: StreamChain['missing']
  history?: TurnRecord[]
}): StreamIpcDeps {
  const all = options.blocks ?? []
  const markOptions = { dir: marksDir }
  const stream: StreamService = {
    sourceOf: () => options.source ?? 'file',
    chain: async () => ({ ...CHAIN, missing: options.missing ?? [] }),
    async checkpoints(terminalId) {
      const marks = readMarks(terminalId, markOptions)
      const placed = new Set(all.map((b) => b.id))
      return {
        checkpoints: all.map((b) => ({
          identity: b.id,
          ordinal: b.ordinal,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          promptHead: b.prompt,
          compacted: b.compacted,
          file: b.file
        })),
        missing: options.missing ?? [],
        orphanMarks: [...marks.keys()].filter((identity) => !placed.has(identity))
      }
    },
    async blocks(_terminalId, request = {}) {
      const limit = request.limit ?? 20
      if (request.after !== undefined) {
        const at = all.findIndex((b) => b.id === request.after)
        if (at < 0) return { blocks: [], total: all.length, missing: [], unknownAfter: true }
        return { blocks: all.slice(at + 1, at + 1 + limit), total: all.length, missing: [] }
      }
      return { blocks: all.slice(0, limit), total: all.length, missing: [] }
    },
    async tailState(): Promise<StreamTailState> {
      return {
        block: all[all.length - 1] ?? null,
        open: true,
        missing: [],
        final: false,
        kind: 'claude',
        total: all.length
      }
    },
    marks: (terminalId) => readMarks(terminalId, markOptions),
    writeMark: (terminalId, patch) => writeMark(terminalId, patch, markOptions),
    marksFile: (terminalId) => markFileFor(terminalId, markOptions),
    rewindPoints: () => []
  }
  return { stream, turnHistory: async () => options.history ?? [] }
}

const many = (n: number): StreamBlock[] => Array.from({ length: n }, (_, i) => block(i + 1))

beforeEach(() => {
  marksDir = mkdtempSync(path.join(tmpdir(), 'stream-ipc-marks-'))
})

describe('open — the whole first paint, bounded', () => {
  it('carries the NEWEST screenful, never the whole chain', async () => {
    const open = await streamOpen('t1', deps({ blocks: many(250) }))
    expect(open?.index).toHaveLength(STREAM_OPEN_ROWS)
    expect(open?.index[0].ordinal).toBe(151)
    expect(open?.index[STREAM_OPEN_ROWS - 1].ordinal).toBe(250)
  })

  it('hands back a backwards cursor only when there IS more behind it', async () => {
    expect((await streamOpen('t1', deps({ blocks: many(250) })))?.backwardsCursor).toBe('u151')
    expect((await streamOpen('t1', deps({ blocks: many(4) })))?.backwardsCursor).toBeNull()
  })

  it('says how long the whole stream is, which is not how many rows it sent', async () => {
    const open = await streamOpen('t1', deps({ blocks: many(250) }))
    expect(open?.tail?.total).toBe(250)
  })

  it('an unknown card is null — the caller answers 404, never an empty rail', async () => {
    const bare = deps({})
    const missing = { ...bare, stream: { ...bare.stream, sourceOf: () => null } }
    expect(await streamOpen('t1', missing as StreamIpcDeps)).toBeNull()
  })

  it('counts a chain member with no transcript as an anomaly rather than dropping it', async () => {
    const open = await streamOpen(
      't1',
      deps({
        blocks: many(3),
        missing: [{ sessionId: 's0', file: '/gone.jsonl', reason: 'no-transcript' }]
      })
    )
    expect(open?.anomalies).toEqual({ missingFile: 1 })
  })

  it('counts a mark the stream cannot place, instead of silently losing the title', async () => {
    writeMark('t1', { identity: 'u-gone', title: 'orphan' }, { dir: marksDir })
    const open = await streamOpen('t1', deps({ blocks: many(3) }))
    expect(open?.anomalies).toEqual({ orphanMark: 1 })
  })

  it('folds the marks onto the rows — the one join, already done', async () => {
    writeMark('t1', { identity: 'u2', title: 'fixed the seam' }, { dir: marksDir })
    const open = await streamOpen('t1', deps({ blocks: many(3) }))
    expect(open?.index[1].marks?.title).toBe('fixed the seam')
  })
})

describe('the index pages by identity, in both directions', () => {
  it('before= returns the page that ENDS at the cursor', async () => {
    const page = await streamIndex('t1', { before: 'u50', limit: 10 }, deps({ blocks: many(100) }))
    expect(page.checkpoints.map((r) => r.ordinal)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
    expect(page.backwardsCursor).toBe('u40')
  })

  it('after= returns the page that STARTS past the cursor', async () => {
    const page = await streamIndex('t1', { after: 'u50', limit: 3 }, deps({ blocks: many(100) }))
    expect(page.checkpoints.map((r) => r.ordinal)).toEqual([51, 52, 53])
  })

  it('stops offering a backwards cursor at the stream’s oldest', async () => {
    const page = await streamIndex('t1', { before: 'u5', limit: 10 }, deps({ blocks: many(100) }))
    expect(page.checkpoints.map((r) => r.ordinal)).toEqual([1, 2, 3, 4])
    expect(page.backwardsCursor).toBeNull()
  })

  it('an unknown cursor is an EMPTY page, never a silent restart at the top', async () => {
    const page = await streamIndex('t1', { before: 'nope' }, deps({ blocks: many(10) }))
    expect(page.checkpoints).toEqual([])
    expect(page.total).toBe(10)
  })
})

describe('blocks come back by identity, with the marks for that window only', () => {
  it('windows forward from a cursor', async () => {
    const page = await streamBlocks('t1', { after: 'u2', limit: 2 }, deps({ blocks: many(9) }))
    expect(page.blocks.map((b) => b.ordinal)).toEqual([3, 4])
    expect(page.total).toBe(9)
  })

  it('carries only the marks of the identities IN the window, never the ledger', async () => {
    writeMark('t1', { identity: 'u1', title: 'outside' }, { dir: marksDir })
    writeMark('t1', { identity: 'u3', title: 'inside' }, { dir: marksDir })
    const page = await streamBlocks('t1', { after: 'u2', limit: 2 }, deps({ blocks: many(9) }))
    expect(Object.keys(page.marks)).toEqual(['u3'])
  })

  it('says an unknown cursor out loud rather than falling back to the start', async () => {
    const page = await streamBlocks('t1', { after: 'nope' }, deps({ blocks: many(9) }))
    expect(page.unknownAfter).toBe(true)
    expect(page.blocks).toEqual([])
  })
})

describe('a door or scrape card answers the SAME contract', () => {
  const history: TurnRecord[] = [
    { index: 1, prompt: 'first', reply: 'a', uuid: 'd1', startedAt: T0, endedAt: T0 + 1 },
    { index: 2, prompt: 'second', reply: 'b', uuid: 'd2', startedAt: T0, endedAt: T0 + 1 }
  ]

  it('opens with rows, a tail and a source, from the provider the old routes use', async () => {
    const open = await streamOpen('t1', deps({ source: 'door', history }))
    expect(open?.source).toBe('door')
    expect(open?.index.map((r) => r.identity)).toEqual(['d1', 'd2'])
    expect(open?.tail?.total).toBe(2)
  })

  it('windows its blocks by identity too', async () => {
    const page = await streamBlocks('t1', { after: 'd1' }, deps({ source: 'scrape', history }))
    expect(page.blocks.map((b) => b.id)).toEqual(['d2'])
  })

  it('reports the tail as final only when the record says so', async () => {
    const tail = await streamTail('t1', deps({ source: 'door', history }))
    expect(tail?.final).toBe(false)
  })
})

describe('marks, folded for the bridge’s live diff', () => {
  it('returns the five fields, keyed by identity, and never the ledger’s bookkeeping', async () => {
    writeMark('t1', { identity: 'u1', title: 'kept', seenAt: 7 }, { dir: marksDir })
    const marks = streamMarks('t1', deps({ blocks: many(3) }))
    expect(marks).toEqual({ u1: { title: 'kept', seenAt: 7 } })
  })
})
