// MATERIALISING FROM THE CURSOR (one-stream T2.5, panel C ① ② ③).
//
// The four claims, in the order they matter:
//   · the cursor advances with the rows it covers, in one atomic write, and a
//     failed write leaves the store BEHIND the transcript, never ahead of it;
//   · replaying any suffix twice is a no-op (first/latest kept apart);
//   · a /rewind is an APPENDED fact: the rolled-back rows stay addressable at
//     their own ordinals with their marks, and new blocks continue the count;
//   · every anomaly class is counted and skipped, and every read-repair class
//     writes exactly one log line.
//
// The reader is a fixture: this file is about the projection + cursor, and a
// real transcript would only make the rewind unobservable.

import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStreamIndexStore } from '../src/main/stream-materialise'
import {
  emptyStreamState,
  readStreamState,
  writeStreamState,
  type StreamState
} from '../src/main/stream-state'
import type { StreamLinesResult } from '../src/main/stream'
import type { StreamLine } from '../src/shared/stream-projection'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const S1 = '/tmp/s1.jsonl'
const S2 = '/tmp/s2.jsonl'

function line(n: number, file = S1, over: Partial<StreamLine> = {}): StreamLine {
  return {
    file,
    byteOffset: n * 100,
    at: T0 + n * 1000,
    ordinal: n,
    entry: {
      identity: `u${n}`,
      startedAt: T0 + n * 1000,
      endedAt: T0 + n * 1000 + 500,
      promptHead: `prompt ${n}`,
      compacted: false,
      file
    },
    ...over
  }
}

/** A chain read, with every file the lines came from declared in order. */
function read(lines: StreamLine[], over: Partial<StreamLinesResult> = {}): StreamLinesResult {
  const files: { file: string; bytesRead: number }[] = []
  for (const one of lines) {
    const at = files.findIndex((entry) => entry.file === one.file)
    if (at < 0) files.push({ file: one.file, bytesRead: one.byteOffset })
    else files[at] = { file: one.file, bytesRead: Math.max(files[at].bytesRead, one.byteOffset) }
  }
  return { lines, files, missing: [], ...over }
}

let dir = ''
let logged: string[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'stream-materialise-'))
  logged = []
})

function store(reads: () => StreamLinesResult, options: { now?: () => number } = {}) {
  return createStreamIndexStore({
    lines: async () => reads(),
    readState: (terminalId) => readStreamState(terminalId, { dir }),
    writeState: (terminalId, state) => writeStreamState(terminalId, state, { dir }),
    now: options.now ?? (() => T0 + 999_999),
    log: (message) => logged.push(message)
  })
}

describe('materialise — the cursor', () => {
  it('advances the cursor and persists the rows it covers, in one write', async () => {
    let lines = [line(1), line(2)]
    const index = store(() => read(lines))
    const first = await index.materialise('term-1')
    expect(first.entries.map((row) => [row.identity, row.ordinal])).toEqual([
      ['u1', 1],
      ['u2', 2]
    ])
    expect(first.cursor).toEqual({ file: S1, byteOffset: 200, ordinal: 2 })
    expect(readStreamState('term-1', { dir }).cursor).toEqual(first.cursor)

    lines = [line(1), line(2), line(3)]
    const second = await index.materialise('term-1')
    expect(second.cursor).toEqual({ file: S1, byteOffset: 300, ordinal: 3 })
    expect(second.entries.map((row) => row.ordinal)).toEqual([1, 2, 3])
  })

  it('a failed write leaves the PREVIOUS cursor — behind the transcript, never ahead', async () => {
    const lines = [line(1), line(2)]
    const failing = createStreamIndexStore({
      lines: async () => read(lines),
      readState: (terminalId) => readStreamState(terminalId, { dir }),
      writeState: (terminalId, state) =>
        writeStreamState(terminalId, state, {
          dir,
          rename: () => {
            throw new Error('simulated crash before rename')
          }
        }),
      log: (message) => logged.push(message)
    })
    const result = await failing.materialise('term-1')
    // The rail still renders what was just read…
    expect(result.entries).toHaveLength(2)
    // …and the store admits it did not materialise it.
    expect(readStreamState('term-1', { dir })).toEqual(emptyStreamState())
    expect(logged.some((message) => message.includes('stayed behind the transcript'))).toBe(true)
  })

  it('an unchanged transcript costs no write at all', async () => {
    const lines = [line(1), line(2)]
    let writes = 0
    const counting = createStreamIndexStore({
      lines: async () => read(lines),
      readState: (terminalId) => readStreamState(terminalId, { dir }),
      writeState: (terminalId, state) => {
        writes += 1
        return writeStreamState(terminalId, state, { dir })
      }
    })
    await counting.materialise('term-1')
    await counting.materialise('term-1')
    await counting.materialise('term-1')
    expect(writes).toBe(1)
  })

  it('a chain that will not resolve keeps the last materialised index', async () => {
    let lines = [line(1), line(2)]
    const index = store(() => read(lines))
    await index.materialise('term-1')
    lines = []
    const blind = await index.materialise('term-1')
    expect(blind.entries.map((row) => row.identity)).toEqual(['u1', 'u2'])
    expect(blind.cursor.ordinal).toBe(2)
  })
})

describe('materialise — idempotent replay', () => {
  it('replaying the same suffix twice changes nothing', async () => {
    const lines = [line(1), line(2), line(3)]
    const index = store(() => read(lines))
    const once = await index.materialise('term-1')
    const twice = await index.materialise('term-1')
    expect(twice.entries).toEqual(once.entries)
    expect(twice.cursor).toEqual(once.cursor)
  })

  it('keeps the FIRST timestamp and moves the LATEST as the open block grows', async () => {
    const open = line(2)
    let lines: StreamLine[] = [line(1), open]
    const index = store(() => read(lines))
    const before = (await index.materialise('term-1')).entries[1]
    expect(before.firstAt).toBe(T0 + 2000)

    lines = [
      line(1),
      { ...open, at: T0 + 60_000, entry: { ...open.entry!, endedAt: T0 + 60_000 } }
    ]
    const after = (await index.materialise('term-1')).entries[1]
    expect(after.ordinal).toBe(2)
    expect(after.firstAt).toBe(T0 + 2000)
    expect(after.latestAt).toBe(T0 + 60_000)
    expect(after.endedAt).toBe(T0 + 60_000)
  })

  it('a rotation into a second file continues the ordinal, never restarts it', async () => {
    let lines = [line(1), line(2)]
    const index = store(() => read(lines))
    await index.materialise('term-1')
    lines = [line(1), line(2), { ...line(1, S2), ordinal: 3 }, { ...line(2, S2), ordinal: 4 }]
    // the second file's own records carry their own identities
    lines[2] = { ...lines[2], entry: { ...lines[2].entry!, identity: 'v1', file: S2 } }
    lines[3] = { ...lines[3], entry: { ...lines[3].entry!, identity: 'v2', file: S2 } }
    const grown = await index.materialise('term-1')
    expect(grown.entries.map((row) => [row.identity, row.ordinal])).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['v1', 3],
      ['v2', 4]
    ])
    expect(grown.cursor.file).toBe(S2)
  })
})

describe('materialise — /rewind is an appended mark', () => {
  it('keeps the rolled-back rows addressable, and the next block continues the count', async () => {
    let lines = [line(1), line(2), line(3), line(4)]
    const index = store(() => read(lines))
    await index.materialise('term-1')

    // /rewind: the transcript SHRINKS back to two exchanges.
    lines = [line(1), line(2)]
    const rewound = await index.materialise('term-1')
    expect(rewound.rolledBack).toEqual([{ fromOrdinal: 3, at: T0 + 999_999 }])
    expect(rewound.entries.map((row) => [row.ordinal, row.rolledBack === true])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, true]
    ])
    // the file won and the cursor was repaired, out loud, once
    expect(logged.filter((message) => message.includes('cursor-beyond-eof'))).toHaveLength(1)

    // and the agent runs again: a NEW ordinal, above the rolled-back ones.
    lines = [line(1), line(2), { ...line(3), entry: { ...line(3).entry!, identity: 'w1' } }]
    const after = await index.materialise('term-1')
    expect(after.entries.map((row) => [row.identity, row.ordinal])).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['u3', 3],
      ['u4', 4],
      ['w1', 5]
    ])
    expect(after.entries[4].rolledBack).toBeUndefined()
  })

  it('a rolled-back row keeps its identity, so its mark still finds it', async () => {
    let lines = [line(1), line(2), line(3)]
    const index = store(() => read(lines))
    await index.materialise('term-1')
    lines = [line(1)]
    const rewound = await index.materialise('term-1')
    expect(rewound.entries.filter((row) => row.rolledBack === true).map((row) => row.identity)).toEqual([
      'u2',
      'u3'
    ])
    expect(rewound.entries[1].promptHead).toBe('prompt 2')
  })

  it('a shrink that costs no whole checkpoint records no rollback', async () => {
    let lines = [line(1), line(2)]
    const index = store(() => read(lines))
    await index.materialise('term-1')
    // the same two records, read from fewer bytes (a torn tail line dropped)
    lines = [line(1), { ...line(2), byteOffset: 150 }]
    const trimmed = await index.materialise('term-1')
    expect(trimmed.rolledBack).toEqual([])
    expect(trimmed.entries.every((row) => row.rolledBack === undefined)).toBe(true)
  })
})

describe('materialise — anomalies are counted and skipped', () => {
  it('UnknownLine and InvalidTimestamp cost their row and nothing else', async () => {
    const lines = [
      line(1),
      { ...line(2), entry: undefined },
      { ...line(3), at: Number.NaN },
      line(4)
    ]
    const index = store(() => read(lines))
    const result = await index.materialise('term-1')
    expect(result.anomalies).toEqual({ UnknownLine: 1, InvalidTimestamp: 1 })
    expect(result.entries.map((row) => row.identity)).toEqual(['u1', 'u4'])
  })

  it('MissingOrdinal is skipped, and the rail still renders every other row', async () => {
    const lines = [line(1), { ...line(2), ordinal: undefined, entry: { ...line(2).entry! } }]
    // the walker could not place it: strip the identity the store would use to
    // number it, so the projection sees a line with no ordinal at all
    const index = createStreamIndexStore({
      lines: async () => ({
        lines: [lines[0], { ...lines[1], entry: undefined, ordinal: undefined }],
        files: [{ file: S1, bytesRead: 200 }],
        missing: []
      }),
      readState: (terminalId) => readStreamState(terminalId, { dir }),
      writeState: (terminalId, state) => writeStreamState(terminalId, state, { dir }),
      log: (message) => logged.push(message)
    })
    const result = await index.materialise('term-1')
    expect(result.entries.map((row) => row.identity)).toEqual(['u1'])
    expect(result.anomalies.UnknownLine).toBe(1)
  })

  it('MissingFile is a STATE — set from the chain, not accumulated per read', async () => {
    const missing = [{ sessionId: 'gone', file: '/tmp/gone.jsonl', reason: 'no-transcript' as const }]
    const index = store(() => read([line(1)], { missing }))
    await index.materialise('term-1')
    const twice = await index.materialise('term-1')
    expect(twice.anomalies.MissingFile).toBe(1)
    expect(twice.missing).toEqual(missing)
  })

  it('a bad line never stops the cursor from advancing past the good ones', async () => {
    const index = store(() => read([line(1), { ...line(2), entry: undefined }, line(3)]))
    const result = await index.materialise('term-1')
    expect(result.entries.map((row) => [row.identity, row.ordinal])).toEqual([
      ['u1', 1],
      ['u3', 2]
    ])
    // The cursor is past the bad line's BYTES — the record it could not use is
    // skipped, not waited for — and it counts what it skipped.
    expect(result.cursor).toEqual({ file: S1, byteOffset: 300, ordinal: 2 })
    expect(readStreamState('term-1', { dir }).anomalies).toEqual({ UnknownLine: 1 })
  })
})

describe('materialise — a replayed prefix is one exchange', () => {
  /** file 2 replays file 1's first `n` exchanges, then continues. */
  const replayChain = (n: number, extra: number): StreamLine[] => {
    const first = [1, 2, 3, 4].map((k) => line(k))
    const second = [
      ...first.slice(0, n).map((one, at) => ({
        ...one,
        file: S2,
        byteOffset: (at + 1) * 100,
        entry: { ...one.entry!, file: S2 }
      })),
      ...Array.from({ length: extra }, (_, at) => {
        const base = line(at + 5, S2)
        return { ...base, entry: { ...base.entry!, identity: `v${at + 1}`, file: S2 } }
      })
    ]
    return [...first, ...second]
  }

  it('draws each exchange once, keeps the first ordinal, continues the count', async () => {
    let lines = [1, 2, 3, 4].map((k) => line(k))
    const index = store(() => read(lines))
    await index.materialise('term-1')

    lines = replayChain(2, 2)
    const rotated = await index.materialise('term-1')
    expect(rotated.entries.map((row) => [row.identity, row.ordinal])).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['u3', 3],
      ['u4', 4],
      ['v1', 5],
      ['v2', 6]
    ])
    expect(rotated.anomalies).toEqual({})
  })

  it('a replayed exchange is read from the NEWEST file that holds it', async () => {
    const index = store(() => read(replayChain(2, 1)))
    const materialised = await index.materialise('term-1')
    const replayed = materialised.entries[0]
    expect(replayed.identity).toBe('u1')
    expect(replayed.ordinal).toBe(1)
    expect(replayed.file).toBe(S2)
    expect(replayed.replayedIn).toEqual([S2])
    expect(replayed.occurrences.map((one) => one.file)).toEqual([S1, S2])
    // an exchange that was never replayed says nothing
    expect(materialised.entries[2].replayedIn).toBeUndefined()
  })

  it('re-materialising the same rotation is a no-op', async () => {
    const lines = replayChain(2, 2)
    const index = store(() => read(lines))
    const once = await index.materialise('term-1')
    const twice = await index.materialise('term-1')
    expect(twice.entries).toEqual(once.entries)
    expect(twice.cursor).toEqual(once.cursor)
  })

  it('a uuid reused for a DIFFERENT exchange is counted, skipped and named', async () => {
    const first = [1, 2].map((k) => line(k))
    const collided = {
      ...line(1, S2),
      byteOffset: 100,
      entry: { ...line(1, S2).entry!, identity: 'u1', file: S2, promptHead: 'a different ask' }
    }
    const index = store(() => read([...first, collided]))
    const materialised = await index.materialise('term-1')
    expect(materialised.anomalies).toEqual({ IdentityCollision: 1 })
    // the row still describes the FIRST exchange
    expect(materialised.entries.map((row) => [row.identity, row.promptHead])).toEqual([
      ['u1', 'prompt 1'],
      ['u2', 'prompt 2']
    ])
    expect(materialised.entries[0].file).toBe(S1)
    expect(logged.filter((message) => message.startsWith('stream identity collision:'))).toHaveLength(
      1
    )
    expect(logged.find((message) => message.includes('identity collision'))).toContain('s2.jsonl')
  })
})

describe('materialise — read-repair', () => {
  it('a cursor naming a file the chain no longer holds is moved to the tail', async () => {
    writeStreamState(
      'term-1',
      { ...emptyStreamState(), cursor: { file: '/tmp/deleted.jsonl', byteOffset: 10, ordinal: 0 } },
      { dir }
    )
    const index = store(() => read([line(1), line(2)]))
    const result = await index.materialise('term-1')
    expect(logged.filter((message) => message.includes('missing-file'))).toHaveLength(1)
    expect(result.entries).toHaveLength(2)
  })

  it('a cursor ordinal behind its own rows is raised, and the rows keep theirs', async () => {
    const stale: StreamState = {
      ...emptyStreamState(),
      cursor: { file: S1, byteOffset: 200, ordinal: 1 },
      index: [
        {
          identity: 'u1',
          ordinal: 1,
          startedAt: T0,
          endedAt: T0 + 1,
          promptHead: 'prompt 1',
          compacted: false,
          file: S1,
          firstAt: T0,
          latestAt: T0 + 1,
          occurrences: [{ file: S1 }]
        },
        {
          identity: 'u2',
          ordinal: 9,
          startedAt: T0,
          endedAt: T0 + 1,
          promptHead: 'prompt 2',
          compacted: false,
          file: S1,
          firstAt: T0,
          latestAt: T0 + 1,
          occurrences: [{ file: S1 }]
        }
      ]
    }
    writeStreamState('term-1', stale, { dir })
    const index = store(() => read([line(1), line(2)]))
    const result = await index.materialise('term-1')
    expect(logged.filter((message) => message.includes('ordinal-regression'))).toHaveLength(1)
    expect(result.cursor.ordinal).toBe(9)
    expect(result.entries.map((row) => row.ordinal)).toEqual([1, 9])
  })

  it('a predecessor appearing BEHIND the cursor rebuilds the index from the files', async () => {
    let lines = [line(1, S2), line(2, S2)]
    const index = store(() => read(lines))
    await index.materialise('term-1')
    // a spilled id resolves: an older transcript now sits in front of S2
    lines = [
      { ...line(1), entry: { ...line(1).entry!, identity: 'old1' } },
      line(1, S2),
      line(2, S2)
    ]
    const rebuilt = await index.materialise('term-1')
    expect(logged.filter((message) => message.includes('chain-grew-behind'))).toHaveLength(1)
    expect(rebuilt.entries.map((row) => [row.identity, row.ordinal])).toEqual([
      ['old1', 1],
      ['u1', 2],
      ['u2', 3]
    ])
  })
})
