// finalizeTitle writes ONE mark, and touches nothing else.
//
// Sol r6 (P1-4 evidence) held this as a persistence shape: the async Sous
// title used to map the whole history into a fresh array and scheduleSave it —
// O(history) per title on the hottest post-turn moment — and was narrowed to
// an indexed scheduleDelta carrying exactly the changed record.
//
// ONE-STREAM T4 narrows it again, to the thing a title actually is. A title is
// one of the two facts about a checkpoint that are NOT in the transcript, so it
// goes to the marks ledger keyed by the identity the stream assigns, and no
// conversation is written at all for a file-backed card. For a SCRAPE card the
// history is still persisted (it is the only record there will ever be), and
// the title rides its annotation sidecar.
//
// What the old assertions bought is kept in the new shape: exactly ONE write
// per title, naming exactly the record that changed, and nothing at all for a
// title whose exchange was rewound away while Sous was summarising.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { MarkPatch } from '../src/main/marks'
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

/** A reader with no directories: TurnTracker builds no writer for it, so a
 *  unit test can never reach the owner's ~/.cookrew. */
function readerStub(disk: TurnRecord[] = []): TurnStore {
  return { load: () => disk } as unknown as TurnStore
}

async function runTurn(session: FakeSession, prompt: string): Promise<void> {
  session.idle = 0
  session.emit('input', `${prompt}\r`)
  session.full = '⏺ done'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
}

describe('finalizeTitle writes the title as a mark', () => {
  it('one mark, on the identity of the record it titled — and nothing else', async () => {
    vi.useFakeTimers()
    const marks: { terminalId: string; patch: MarkPatch }[] = []
    const tracker = new TurnTracker(async () => 'A Crisp Title', readerStub())
    tracker.onMark = (terminalId, patch) => marks.push({ terminalId, patch })
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)

    await runTurn(session, 'do the task')
    // Let the async summarize settle.
    await vi.advanceTimersByTimeAsync(0)

    expect(marks).toHaveLength(1)
    expect(marks[0].terminalId).toBe('term-1')
    expect(marks[0].patch.title).toBe('A Crisp Title')
    // A scraped record has no uuid, so the identity is the derived digest —
    // the same one the migration used and the stream will compute.
    expect(marks[0].patch.identity).toMatch(/^claude-1-[0-9a-f]{8}$/)
    // A mark can carry nothing else, and this one does not try.
    expect(Object.keys(marks[0].patch).sort()).toEqual(['identity', 'title'])

    // The public snapshot was invalidated: readers see the title.
    expect(tracker.history('term-1')[0].title).toBe('A Crisp Title')
    tracker.disposeAll()
    vi.useRealTimers()
  })

  it('a record no longer present (rewound away) titles nothing and marks nothing', async () => {
    vi.useFakeTimers()
    const marks: MarkPatch[] = []
    let resolveTitle: (title: string | null) => void = () => undefined
    const gate = new Promise<string | null>((resolve) => {
      resolveTitle = resolve
    })
    const tracker = new TurnTracker(() => gate, readerStub())
    tracker.onMark = (_id, patch) => marks.push(patch)
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)

    await runTurn(session, 'do the task')
    // The exchange disappears (rewind/branch) before Sous answers.
    tracker.replaceHistory('term-1', [])
    resolveTitle('Too Late')
    await vi.advanceTimersByTimeAsync(0)

    expect(marks).toHaveLength(0)
    tracker.disposeAll()
    vi.useRealTimers()
  })

  it('a failing mark writer costs the title, never the turn', async () => {
    vi.useFakeTimers()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const tracker = new TurnTracker(async () => 'A Crisp Title', readerStub())
    tracker.onMark = () => {
      throw new Error('ledger on fire')
    }
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)

    await runTurn(session, 'do the task')
    await vi.advanceTimersByTimeAsync(0)

    // The turn landed and the card still shows the title.
    expect(tracker.history('term-1')).toHaveLength(1)
    expect(tracker.history('term-1')[0].title).toBe('A Crisp Title')
    quiet.mockRestore()
    tracker.disposeAll()
    vi.useRealTimers()
  })
})
