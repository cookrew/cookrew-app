// Sol r4 P1 (I3) — TurnTracker.applyHistoryDelta: the parser lane emits
// O(delta) history changes (shared/session-turns HistoryDelta) and the
// tracker applies them without rebuilding the whole reconcile. The apply
// contract is the shared type's: append splices at records[0].index - 1
// (|H| or |H|-1 — the finalized re-carry of the open tail), tail replaces
// the last record in place, reset falls back to the full replaceHistory.
// Every observer of replaceHistory — open-turn-fact clearing, the dispatch
// closure scan, the store save — must see a delta-applied history identically.

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker, type CompletedTurn } from '../src/main/turn-tracker'
import { TurnStore } from '../src/main/turn-store'
import { AnnotationStore } from '../src/main/turn-annotations'
import type { TurnRecord } from '../src/shared/turn'
import type { PtySession } from '../src/main/pty'

class FakeSession extends EventEmitter {
  terminalId = 'term-1'
  full = ''
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

function record(over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index: 1,
    prompt: 'do the task',
    reply: 'task done',
    startedAt: Date.now(),
    endedAt: Date.now() + 1,
    ...over
  }
}

function fixture(): { tracker: TurnTracker; seen: CompletedTurn[] } {
  const tracker = new TurnTracker(async () => null, null)
  const seen: CompletedTurn[] = []
  tracker.on('turn', (turn: CompletedTurn) => seen.push(turn))
  return { tracker, seen }
}

const noFull = (): TurnRecord[] => {
  throw new Error('fullRecords must not be consulted on the incremental path')
}

describe('applyHistoryDelta — append', () => {
  it('appends new records past the tail without touching fullRecords', () => {
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [record({ index: 1, uuid: 'u1' })])
    tracker.applyHistoryDelta(
      'term-1',
      {
        kind: 'append',
        records: [record({ index: 2, prompt: 'second ask', reply: 'second reply', uuid: 'u2' })]
      },
      noFull
    )
    expect(tracker.history('term-1').map((r) => [r.index, r.uuid])).toEqual([
      [1, 'u1'],
      [2, 'u2']
    ])
    tracker.disposeAll()
  })

  it('the finalized RE-CARRY of the open tail supersedes it and inherits title/seenAt', () => {
    const { tracker } = fixture()
    const open = record({ index: 2, uuid: 'u2', prompt: 'second ask', reply: '', title: 'Sous title', seenAt: 42 })
    tracker.replaceHistory('term-1', [record({ index: 1, uuid: 'u1', final: true }), open])
    // The next-user boundary landed finality and the next prompt in one feed:
    // records[0] is the finalized form of index 2, records[1] the new tail.
    tracker.applyHistoryDelta(
      'term-1',
      {
        kind: 'append',
        records: [
          record({ index: 2, uuid: 'u2', prompt: 'second ask', reply: 'finished', final: true }),
          record({ index: 3, uuid: 'u3', prompt: 'third ask', reply: '' })
        ]
      },
      noFull
    )
    const history = tracker.history('term-1')
    expect(history.map((r) => r.index)).toEqual([1, 2, 3])
    expect(history[1]).toMatchObject({
      reply: 'finished',
      final: true,
      title: 'Sous title',
      seenAt: 42
    })
    tracker.disposeAll()
  })

  it('an empty append is the no-op take', () => {
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [record({ index: 1, uuid: 'u1' })])
    tracker.applyHistoryDelta('term-1', { kind: 'append', records: [] }, noFull)
    expect(tracker.history('term-1')).toHaveLength(1)
    tracker.disposeAll()
  })

  it('a drifted premise (index lands neither on nor past the tail) falls back to the full reconcile', () => {
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [
      record({ index: 1, uuid: 'u1', final: true }),
      record({ index: 2, uuid: 'u2', final: true })
    ])
    const full = [record({ index: 1, uuid: 'u9', prompt: 'rewritten' })]
    tracker.applyHistoryDelta('term-1', { kind: 'append', records: [record({ index: 1, uuid: 'u9', prompt: 'rewritten' })] }, () => full)
    expect(tracker.history('term-1').map((r) => r.uuid)).toEqual(['u9'])
    tracker.disposeAll()
  })
})

describe('applyHistoryDelta — tail', () => {
  it('replaces the last record in place, carrying title/seenAt/scrollLine from the replaced one', () => {
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [
      record({ index: 1, uuid: 'u1', reply: '', title: 'live title', seenAt: 7, scrollLine: 120 })
    ])
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'tail', record: record({ index: 1, uuid: 'u1', reply: 'grew a reply', final: true }) },
      noFull
    )
    const [tail] = tracker.history('term-1')
    expect(tail).toMatchObject({
      reply: 'grew a reply',
      final: true,
      title: 'live title',
      seenAt: 7,
      scrollLine: 120
    })
    tracker.disposeAll()
  })

  it('a uuid mismatch is NOT a tail update — falls back to the full reconcile', () => {
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [record({ index: 1, uuid: 'u1', title: 'mine' })])
    const full = [record({ index: 1, uuid: 'u-other', prompt: 'different exchange' })]
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'tail', record: record({ index: 1, uuid: 'u-other', prompt: 'different exchange' }) },
      () => full
    )
    const [tail] = tracker.history('term-1')
    expect(tail.uuid).toBe('u-other')
    // The rewound-in stranger does not inherit the old exchange's title.
    expect(tail.title).toBeUndefined()
    tracker.disposeAll()
  })
})

describe('applyHistoryDelta — reset', () => {
  it('discards and re-reads the full projection', () => {
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [record({ index: 1, uuid: 'u1' }), record({ index: 2, uuid: 'u2' })])
    const full = [record({ index: 1, uuid: 'branch-root', prompt: 'the other branch' })]
    tracker.applyHistoryDelta('term-1', { kind: 'reset' }, () => full)
    expect(tracker.history('term-1').map((r) => r.uuid)).toEqual(['branch-root'])
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r5 P1 — O(delta) THROUGH PERSISTENCE. The parser lane emitting a
// one-record delta means nothing if applying it copies the whole prefix,
// hands the whole array to the annotation pass, and rewrites the whole file.
// This gate counts the work where it actually lands: records visited by the
// annotation pass, bytes written to the conversation file, and the identity
// of the tracker's backing buffer.
// ---------------------------------------------------------------------------

interface StoreInternals {
  annotations: AnnotationStore
  writeAll: (terminalId: string, records: TurnRecord[]) => void
}

interface TrackerInternals {
  histories: Map<string, TurnRecord[]>
  scrapeEmitted: Map<string, { uuid?: string }[]>
}

describe('O(delta) through persistence (Sol r5 P1)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cookrew-delta-gate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const HISTORY = 300

  /** A 300-turn, fully-titled, flushed history — the gate's baseline. */
  function seeded(): { store: TurnStore; tracker: TurnTracker } {
    const store = new TurnStore(path.join(dir, 'turns'))
    const tracker = new TurnTracker(async () => null, store)
    const base = Array.from({ length: HISTORY }, (_, i) =>
      record({
        index: i + 1,
        uuid: `u${i + 1}`,
        prompt: `ask ${i + 1}`,
        reply: `reply ${i + 1}`,
        title: `title ${i + 1}`,
        final: true
      })
    )
    tracker.replaceHistory('term-1', base)
    store.flushAll()
    return { store, tracker }
  }

  const turnsFile = (): string => path.join(dir, 'turns', 'term-1.jsonl')
  const sidecarFile = (): string => path.join(dir, 'checkpoint-annotations', 'term-1.json')
  const sidecarLog = (): string => path.join(dir, 'checkpoint-annotations', 'term-1.log.jsonl')
  /** What the sidecar reads back as across a restart: snapshot + op log. */
  const sidecarState = (): Map<number, unknown> =>
    new AnnotationStore(path.join(dir, 'checkpoint-annotations')).load('term-1')

  it('300-turn history + 1 appended turn: annotation pass visits the delta, file gains one line, no rewrite', () => {
    const { store, tracker } = seeded()
    const internals = store as unknown as StoreInternals
    const annSave = vi.spyOn(internals.annotations, 'save')
    const annUpdate = vi.spyOn(internals.annotations, 'update')
    const writeAll = vi.spyOn(internals, 'writeAll')
    const bytesBefore = readFileSync(turnsFile(), 'utf8')
    const sidecarBefore = readFileSync(sidecarFile(), 'utf8')

    tracker.applyHistoryDelta(
      'term-1',
      {
        kind: 'append',
        records: [record({ index: 301, uuid: 'u301', prompt: 'ask 301', reply: 'reply 301', title: 'title 301', final: true })]
      },
      noFull
    )
    store.flushAll()

    // The annotation pass never rebuilt from all 300 records — it folded in
    // only the delta window (the boundary record plus the landed one).
    expect(annSave).not.toHaveBeenCalled()
    expect(annUpdate).toHaveBeenCalledTimes(1)
    expect(annUpdate.mock.calls[0][1].length).toBeLessThanOrEqual(2)
    // The conversation write was an append of exactly one line: the original
    // bytes are untouched and no full rewrite happened.
    expect(writeAll).not.toHaveBeenCalled()
    const bytesAfter = readFileSync(turnsFile(), 'utf8')
    expect(bytesAfter.startsWith(bytesBefore)).toBe(true)
    expect(bytesAfter.trim().split('\n')).toHaveLength(HISTORY + 1)
    // The sidecar gained the appended turn's title as ONE op-log line; the
    // snapshot — the complete-map serialization Sol r6 P1 charged per update —
    // is byte-identical, and a fresh store replays snapshot + log back whole.
    expect(readFileSync(sidecarFile(), 'utf8')).toBe(sidecarBefore)
    expect(readFileSync(sidecarLog(), 'utf8').trim().split('\n')).toHaveLength(1)
    const sidecar = sidecarState()
    expect(sidecar.get(301)).toEqual({ title: 'title 301' })
    expect(sidecar.size).toBe(HISTORY + 1)
    // Snapshot envelope (Sol r7 P1): the map sits under `annotations`,
    // beside the epoch that keys log replay.
    expect(JSON.parse(sidecarBefore)).toMatchObject({
      annotations: { '1': { title: 'title 1' } },
    })
    // And it all reads back whole.
    expect(tracker.history('term-1')).toHaveLength(HISTORY + 1)
    tracker.disposeAll()
  })

  it('an appended turn with NO annotation leaves the sidecar bytes completely untouched', () => {
    const { store, tracker } = seeded()
    const sidecarBefore = readFileSync(sidecarFile(), 'utf8')
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'append', records: [record({ index: 301, uuid: 'u301', prompt: 'ask 301', reply: 'reply 301', final: true })] },
      noFull
    )
    store.flushAll()
    expect(readFileSync(sidecarFile(), 'utf8')).toBe(sidecarBefore)
    expect(existsSync(sidecarLog())).toBe(false)
    tracker.disposeAll()
  })

  // Sol r7 P1 adaptation: the tail update is an appended OVERLAY line now,
  // not an atomic whole-file rewrite — stronger observable: EVERY previous
  // byte is untouched, the write is one superseding line, no writeAll.
  it('a tail finalization appends ONE overlay line — never a full-history rewrite', () => {
    const { store, tracker } = seeded()
    const internals = store as unknown as StoreInternals
    const writeAll = vi.spyOn(internals, 'writeAll')
    const before = readFileSync(turnsFile(), 'utf8')

    tracker.applyHistoryDelta(
      'term-1',
      {
        kind: 'tail',
        record: record({ index: HISTORY, uuid: `u${HISTORY}`, prompt: `ask ${HISTORY}`, reply: 'grew a longer reply', final: true })
      },
      noFull
    )
    store.flushAll()

    expect(writeAll).not.toHaveBeenCalled()
    const after = readFileSync(turnsFile(), 'utf8')
    // The whole previous file is byte-identical; one overlay line follows it.
    expect(after.startsWith(before)).toBe(true)
    const lines = after.trim().split('\n')
    expect(lines).toHaveLength(HISTORY + 1)
    expect(lines[lines.length - 1].startsWith(`{"__tail":true,"supersedes":${HISTORY},`)).toBe(true)
    expect(lines[lines.length - 1]).toContain('grew a longer reply')
    // Logically the record was replaced, not duplicated…
    expect(store.count('term-1')).toBe(HISTORY)
    expect(store.load('term-1')[HISTORY - 1].reply).toBe('grew a longer reply')
    // …and the replaced tail still carried its title across (annotation intact).
    expect(tracker.history('term-1')[HISTORY - 1].title).toBe(`title ${HISTORY}`)
    tracker.disposeAll()
  })

  // Sol r7 P1 gate extension: REPEATED tail updates against a large ledger
  // cost O(changed) bytes each — the file only ever GROWS by one overlay line
  // per update (nothing before the append point is rewritten), and the
  // growth is bounded by the changed record's own size, not the history's.
  it('repeated tail updates append O(changed) bytes each; prior bytes never move', () => {
    const { store, tracker } = seeded()
    const internals = store as unknown as StoreInternals
    const writeAll = vi.spyOn(internals, 'writeAll')
    let before = readFileSync(turnsFile(), 'utf8')

    for (let round = 1; round <= 10; round += 1) {
      const reply = `growing reply ${'x'.repeat(round * 10)}`
      tracker.applyHistoryDelta(
        'term-1',
        {
          kind: 'tail',
          record: record({ index: HISTORY, uuid: `u${HISTORY}`, prompt: `ask ${HISTORY}`, reply, final: round === 10 })
        },
        noFull
      )
      store.flushAll()
      const after = readFileSync(turnsFile(), 'utf8')
      // Append-only: the previous file is a byte prefix of the new one…
      expect(after.startsWith(before)).toBe(true)
      // …and the delta is ONE overlay line — record-sized, not history-sized.
      const grew = after.slice(before.length)
      expect(grew.trim().split('\n')).toHaveLength(1)
      expect(grew.length).toBeLessThan(reply.length + 400)
      before = after
    }

    expect(writeAll).not.toHaveBeenCalled()
    // Ten physical overlays, still one logical tail — and it reads back last-wins.
    expect(store.count('term-1')).toBe(HISTORY)
    const replayed = new TurnStore(path.join(dir, 'turns')).load('term-1')
    expect(replayed).toHaveLength(HISTORY)
    expect(replayed[HISTORY - 1].reply).toBe(`growing reply ${'x'.repeat(100)}`)
    tracker.disposeAll()
  })

  it('the tracker-private buffer is appended IN PLACE — the prefix is never copied', () => {
    const { tracker } = fixture()
    tracker.replaceHistory(
      'term-1',
      Array.from({ length: HISTORY }, (_, i) => record({ index: i + 1, uuid: `u${i + 1}`, final: true }))
    )
    const buffer = (tracker as unknown as TrackerInternals).histories.get('term-1')
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'append', records: [record({ index: 301, uuid: 'u301' })] },
      noFull
    )
    // Same array object, one longer: the append mutated the tracker-owned
    // buffer instead of allocating a copy of the 300 untouched records.
    expect((tracker as unknown as TrackerInternals).histories.get('term-1')).toBe(buffer)
    expect(buffer).toHaveLength(HISTORY + 1)
    tracker.disposeAll()
  })

  it('history() identity survives the buffer: same reference while unchanged, new after a delta, old copy frozen in time', () => {
    // The contract SessionTurnSync's watch() re-adopt depends on:
    // `history(id) === prior.history` must mean "nothing changed".
    const { tracker } = fixture()
    tracker.replaceHistory('term-1', [record({ index: 1, uuid: 'u1', final: true })])
    const before = tracker.history('term-1')
    expect(tracker.history('term-1')).toBe(before)
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'append', records: [record({ index: 2, uuid: 'u2' })] },
      noFull
    )
    const after = tracker.history('term-1')
    expect(after).not.toBe(before)
    expect(after).toHaveLength(2)
    // The handed-out snapshot is point-in-time: the in-place append did not
    // reach through the reference a caller captured earlier.
    expect(before).toHaveLength(1)
    tracker.disposeAll()
  })
})

describe('deltas feed the same observers as replaceHistory', () => {
  it('a FINAL tail arriving as a delta clears the open-turn fact', () => {
    const { tracker } = fixture()
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'do the task\r')
    const openedAt = Date.now()
    tracker.untrack('term-1')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.applyHistoryDelta(
      'term-1',
      {
        kind: 'append',
        records: [record({ index: 1, uuid: 'u1', final: true, startedAt: openedAt, endedAt: openedAt + 500 })]
      },
      noFull
    )
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('the dispatch-closure scan closes over a delta-applied history', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    // Growth arrives as deltas only: the open turn, then its finality.
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'append', records: [record({ index: 1, uuid: 'u1', reply: '' })] },
      noFull
    )
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0) // not final yet
    tracker.applyHistoryDelta(
      'term-1',
      { kind: 'tail', record: record({ index: 1, uuid: 'u1', final: true }) },
      noFull
    )
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dispatchId: 'dsp-1', turnIndex: 1, turnUuid: 'u1' })
    tracker.disposeAll()
  })
})
