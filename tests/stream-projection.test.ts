// THE STATELESS PROJECTION (one-stream T2.5, panel C ① and ③).
//
// The claims under test are the two Codex properties this borrows:
//   · project_rollout_line is PURE — one line in, a change set out, no `this`
//     — so replaying any suffix twice is a no-op (thread_history_projection.rs);
//   · everything it does not understand yields an EMPTY set and an ANOMALY,
//     never an abort, so one bad line costs one row and not the rail.
//
// And the one deliberate deviation, tested so it cannot rot: a RegressedOrdinal
// still upserts (at the continuing ordinal) rather than dropping the record.

import { describe, expect, it } from 'vitest'
import {
  EMPTY_CHANGE_SET,
  PROJECTION_ANOMALIES,
  applyChangeSet,
  checkpointKey,
  countAnomalies,
  markRolledBack,
  projectLine,
  type ProjectedCheckpoint,
  type StreamLine
} from '../src/shared/stream-projection'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')

function line(ordinal: number, identity: string, over: Partial<StreamLine> = {}): StreamLine {
  return {
    file: '/tmp/s1.jsonl',
    byteOffset: ordinal * 100,
    at: T0 + ordinal * 1000,
    ordinal,
    entry: {
      identity,
      startedAt: T0 + ordinal * 1000,
      endedAt: T0 + ordinal * 1000 + 500,
      promptHead: `prompt ${ordinal}`,
      compacted: false,
      file: '/tmp/s1.jsonl'
    },
    ...over
  }
}

describe('projectLine', () => {
  it('projects a well-formed line into one upsert and a cursor', () => {
    const change = projectLine(line(1, 'u1'), { lastOrdinal: 0 })
    expect(change.anomalies).toEqual([])
    expect(change.upserts.map((row) => [row.identity, row.ordinal])).toEqual([['u1', 1]])
    expect(change.cursor).toEqual({ file: '/tmp/s1.jsonl', byteOffset: 100, ordinal: 1 })
    expect(change.upserts[0].firstAt).toBe(T0 + 1000)
    expect(change.upserts[0].latestAt).toBe(T0 + 1000)
  })

  it('is pure — the same line and state give the same change set', () => {
    const once = projectLine(line(4, 'u4'), { lastOrdinal: 3 })
    const twice = projectLine(line(4, 'u4'), { lastOrdinal: 3 })
    expect(twice).toEqual(once)
  })

  it('never mutates the line it read', () => {
    const input = line(1, 'u1')
    const frozen = JSON.parse(JSON.stringify(input))
    projectLine(input, { lastOrdinal: 0 })
    expect(input).toEqual(frozen)
  })

  describe('anomalies — counted and skipped, never thrown', () => {
    it('MissingFile: a line naming no transcript', () => {
      const change = projectLine(line(1, 'u1', { file: '' }), { lastOrdinal: 0 })
      expect(change.anomalies).toEqual(['MissingFile'])
      expect(change.upserts).toEqual([])
      expect(change.cursor).toBeUndefined()
    })

    it('UnknownLine: no entry, or an entry with no identity', () => {
      const noEntry = projectLine({ ...line(1, 'u1'), entry: undefined }, { lastOrdinal: 0 })
      expect(noEntry.anomalies).toEqual(['UnknownLine'])
      const blank = line(1, '')
      expect(projectLine(blank, { lastOrdinal: 0 }).anomalies).toEqual(['UnknownLine'])
      expect(projectLine(blank, { lastOrdinal: 0 }).upserts).toEqual([])
    })

    it('MissingOrdinal: the walker could not place the record', () => {
      const change = projectLine({ ...line(1, 'u1'), ordinal: undefined }, { lastOrdinal: 0 })
      expect(change.anomalies).toEqual(['MissingOrdinal'])
      expect(change.upserts).toEqual([])
    })

    it('InvalidTimestamp: a non-finite or negative clock reading', () => {
      const bad = line(1, 'u1')
      expect(projectLine({ ...bad, at: Number.NaN }, { lastOrdinal: 0 }).anomalies).toEqual([
        'InvalidTimestamp'
      ])
      expect(
        projectLine(
          { ...bad, entry: { ...bad.entry!, startedAt: -1 } },
          { lastOrdinal: 0 }
        ).anomalies
      ).toEqual(['InvalidTimestamp'])
    })

    it('ForwardGap: a jump, counted, and the record KEEPS its own ordinal', () => {
      const change = projectLine(line(9, 'u9'), { lastOrdinal: 4 })
      expect(change.anomalies).toEqual(['ForwardGap'])
      expect(change.upserts[0].ordinal).toBe(9)
      expect(change.cursor?.ordinal).toBe(9)
    })

    it('RegressedOrdinal: counted, and the record still lands — at the CONTINUING ordinal', () => {
      // The deliberate deviation from Codex, which drops a regressed record.
      // Ours are DERIVED, so a stale candidate is our arithmetic being wrong,
      // not a record being absent — and dropping a real exchange is the
      // 400-checkpoint incident with better logging.
      const change = projectLine(line(2, 'u2'), { lastOrdinal: 7 })
      expect(change.anomalies).toEqual(['RegressedOrdinal'])
      expect(change.upserts[0].ordinal).toBe(8)
      expect(change.cursor?.ordinal).toBe(8)
    })

    it('every declared class is reachable', () => {
      expect([...PROJECTION_ANOMALIES].sort()).toEqual(
        [
          'ForwardGap',
          'InvalidTimestamp',
          'MissingFile',
          'MissingOrdinal',
          'RegressedOrdinal',
          'UnknownLine'
        ].sort()
      )
    })
  })
})

describe('applyChangeSet — the upsert guard', () => {
  const first = projectLine(line(1, 'u1'), { lastOrdinal: 0 })

  it('inserts, then keeps the CREATION ordinal and first timestamp on conflict', () => {
    const inserted = applyChangeSet(new Map(), first)
    const grown: StreamLine = {
      ...line(1, 'u1'),
      at: T0 + 90_000,
      entry: { ...line(1, 'u1').entry!, endedAt: T0 + 90_000, promptHead: 'prompt 1' }
    }
    const again = applyChangeSet(inserted, projectLine({ ...grown, ordinal: 1 }, { lastOrdinal: 0 }))
    const row = again.get(checkpointKey({ file: '/tmp/s1.jsonl', identity: 'u1' })) as ProjectedCheckpoint
    expect(row.ordinal).toBe(1)
    expect(row.firstAt).toBe(T0 + 1000)
    expect(row.latestAt).toBe(T0 + 90_000)
    expect(row.endedAt).toBe(T0 + 90_000)
  })

  it('latest never goes backwards', () => {
    const inserted = applyChangeSet(new Map(), projectLine(line(1, 'u1'), { lastOrdinal: 0 }))
    const stale = applyChangeSet(
      inserted,
      projectLine({ ...line(1, 'u1'), at: T0 - 5000 }, { lastOrdinal: 0 })
    )
    const key = checkpointKey({ file: '/tmp/s1.jsonl', identity: 'u1' })
    expect((stale.get(key) as ProjectedCheckpoint).latestAt).toBe(T0 + 1000)
  })

  it('replaying the same suffix twice is a no-op', () => {
    const suffix = [line(1, 'u1'), line(2, 'u2'), line(3, 'u3')]
    const replay = (from: Map<string, ProjectedCheckpoint>): Map<string, ProjectedCheckpoint> =>
      suffix.reduce(
        (snapshot, one) =>
          applyChangeSet(snapshot, projectLine(one, { lastOrdinal: (one.ordinal as number) - 1 })),
        from
      )
    const once = replay(new Map())
    const twice = replay(once)
    expect([...twice.values()]).toEqual([...once.values()])
  })

  it('an empty change set leaves the snapshot alone', () => {
    const inserted = applyChangeSet(new Map(), first)
    expect([...applyChangeSet(inserted, EMPTY_CHANGE_SET).values()]).toEqual([
      ...inserted.values()
    ])
  })

  it('does not mutate the snapshot it was given', () => {
    const before = applyChangeSet(new Map(), first)
    applyChangeSet(before, projectLine(line(2, 'u2'), { lastOrdinal: 1 }))
    expect(before.size).toBe(1)
  })
})

describe('the snapshot key is (file, identity)', () => {
  it('keeps a CROSS-FILE repeat as two rows — Claude replays a prefix on rotation', () => {
    // Measured on the owner's busiest card: 1,239 blocks, 1,046 distinct
    // identities, every repeat spanning more than one file. Folding them would
    // change what the rail shows; that decision is T3's, with the numbers.
    const inFirst = projectLine(line(1, 'u1'), { lastOrdinal: 0 })
    const replayed = line(2, 'u1', {
      file: '/tmp/s2.jsonl',
      entry: { ...line(2, 'u1').entry!, file: '/tmp/s2.jsonl' }
    })
    const snapshot = applyChangeSet(
      applyChangeSet(new Map(), inFirst),
      projectLine(replayed, { lastOrdinal: 1 })
    )
    expect(snapshot.size).toBe(2)
    expect([...snapshot.values()].map((row) => [row.file, row.ordinal])).toEqual([
      ['/tmp/s1.jsonl', 1],
      ['/tmp/s2.jsonl', 2]
    ])
  })

  it('a repeat WITHIN one file upserts — that is what replaying a suffix is', () => {
    const once = applyChangeSet(new Map(), projectLine(line(1, 'u1'), { lastOrdinal: 0 }))
    expect(applyChangeSet(once, projectLine(line(1, 'u1'), { lastOrdinal: 0 })).size).toBe(1)
  })
})

describe('markRolledBack', () => {
  it('flags every checkpoint from `fromOrdinal` on, and leaves the rest', () => {
    const snapshot = [1, 2, 3, 4].reduce(
      (acc, ordinal) =>
        applyChangeSet(acc, projectLine(line(ordinal, `u${ordinal}`), { lastOrdinal: ordinal - 1 })),
      new Map<string, ProjectedCheckpoint>()
    )
    const rolled = markRolledBack(snapshot, 3)
    expect([...rolled.values()].map((row) => [row.ordinal, row.rolledBack === true])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, true]
    ])
    // and the originals are untouched
    expect([...snapshot.values()].every((row) => row.rolledBack === undefined)).toBe(true)
  })
})

describe('countAnomalies', () => {
  it('accumulates by class and never records a zero', () => {
    const once = countAnomalies({}, ['UnknownLine', 'ForwardGap'])
    expect(countAnomalies(once, ['UnknownLine'])).toEqual({ UnknownLine: 2, ForwardGap: 1 })
    expect(countAnomalies({}, [])).toEqual({})
  })
})
