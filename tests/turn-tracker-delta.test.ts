// Sol r4 P1 (I3) — TurnTracker.applyHistoryDelta: the parser lane emits
// O(delta) history changes (shared/session-turns HistoryDelta) and the
// tracker applies them without rebuilding the whole reconcile. The apply
// contract is the shared type's: append splices at records[0].index - 1
// (|H| or |H|-1 — the finalized re-carry of the open tail), tail replaces
// the last record in place, reset falls back to the full replaceHistory.
// Every observer of replaceHistory — open-turn-fact clearing, the dispatch
// closure scan, the store save — must see a delta-applied history identically.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TurnTracker, type CompletedTurn } from '../src/main/turn-tracker'
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
