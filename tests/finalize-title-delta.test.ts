// Sol r6 (P1-4 evidence) — finalizeTitle is an INDEXED DELTA, not a full save.
//
// The async Sous title used to map the complete history into a fresh array
// and scheduleSave it, choosing the full persistence path — O(history) per
// title on the hottest post-turn moment. A title is an annotation-only change
// to ONE record: the tracker now locates it, updates just that slot in its
// private buffer, and hands the store exactly the changed record via
// scheduleDelta, whose flush folds one annotation and rewrites no
// conversation line.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { TurnStore } from '../src/main/turn-store'
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

interface StoreCalls {
  saves: Array<{ terminalId: string; count: number }>
  deltas: Array<{ terminalId: string; records: TurnRecord[]; changed: TurnRecord[] }>
}

function storeStub(calls: StoreCalls): TurnStore {
  return {
    load: () => [],
    scheduleSave: (terminalId: string, records: TurnRecord[]) => {
      calls.saves.push({ terminalId, count: records.length })
    },
    scheduleDelta: (terminalId: string, records: TurnRecord[], changed: readonly TurnRecord[]) => {
      calls.deltas.push({ terminalId, records, changed: [...changed] })
    }
  } as unknown as TurnStore
}

async function runTurn(session: FakeSession, prompt: string): Promise<void> {
  session.idle = 0
  session.emit('input', `${prompt}\r`)
  session.full = '⏺ done'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
}

describe('finalizeTitle persists via the indexed delta path', () => {
  it('hands scheduleDelta exactly the ONE titled record — never a full scheduleSave', async () => {
    vi.useFakeTimers()
    const calls: StoreCalls = { saves: [], deltas: [] }
    const tracker = new TurnTracker(async () => 'A Crisp Title', storeStub(calls))
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)

    await runTurn(session, 'do the task')
    // Let the async summarize settle.
    await vi.advanceTimersByTimeAsync(0)

    // The turn APPEND itself is the scrape path's full save (unchanged here);
    // the TITLE must not be a second one.
    expect(calls.saves).toHaveLength(1)
    expect(calls.deltas).toHaveLength(1)
    const delta = calls.deltas[0]
    expect(delta.terminalId).toBe('term-1')
    expect(delta.changed).toHaveLength(1)
    expect(delta.changed[0]).toMatchObject({ index: 1, title: 'A Crisp Title' })
    // The buffer handed to the store carries the titled record in place.
    expect(delta.records[delta.records.length - 1].title).toBe('A Crisp Title')

    // The public snapshot was invalidated: readers see the title.
    expect(tracker.history('term-1')[0].title).toBe('A Crisp Title')
    tracker.disposeAll()
    vi.useRealTimers()
  })

  it('a record no longer present (rewound away) titles nothing and saves nothing', async () => {
    vi.useFakeTimers()
    const calls: StoreCalls = { saves: [], deltas: [] }
    let resolveTitle: (title: string | null) => void = () => undefined
    const gate = new Promise<string | null>((resolve) => {
      resolveTitle = resolve
    })
    const tracker = new TurnTracker(() => gate, storeStub(calls))
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)

    await runTurn(session, 'do the task')
    const savesBefore = calls.saves.length
    // The exchange disappears (rewind/branch) before Sous answers.
    tracker.replaceHistory('term-1', [])
    const savesAfterReplace = calls.saves.length
    resolveTitle('Too Late')
    await vi.advanceTimersByTimeAsync(0)

    // No delta, no extra save for the orphaned title.
    expect(calls.deltas).toHaveLength(0)
    expect(calls.saves.length).toBe(savesAfterReplace)
    expect(savesAfterReplace).toBeGreaterThanOrEqual(savesBefore)
    tracker.disposeAll()
    vi.useRealTimers()
  })
})
