import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync } from '../src/main/session-sync'
import { TurnTracker } from '../src/main/turn-tracker'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

function user(content: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: ts,
    sessionId: 'src'
  })
}

function assistant(textContent: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: textContent }] },
    timestamp: ts,
    sessionId: 'src'
  })
}

const TURN_1 = [user('turn one', '2026-07-20T10:00:00Z'), assistant('reply one', '2026-07-20T10:00:10Z')]
const TURN_2 = [user('turn two', '2026-07-20T10:01:00Z'), assistant('reply two', '2026-07-20T10:01:10Z')]

function fixture(): { file: string; tracker: TurnTracker; sync: SessionTurnSync } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-session-'))
  const file = path.join(dir, 'abc.jsonl')
  const tracker = new TurnTracker(async () => null, null)
  const sync = new SessionTurnSync(tracker, 50)
  return { file, tracker, sync }
}

describe('SessionTurnSync', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rebuilds history from the session file immediately on watch', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    sync.watch('term-1', file)
    const history = tracker.history('term-1')
    expect(history.map((r) => r.prompt)).toEqual(['turn one', 'turn two'])
    expect(history.map((r) => r.index)).toEqual([1, 2])
    sync.dispose()
  })

  it('picks up appended turns on the poll', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file)
    expect(tracker.history('term-1')).toHaveLength(1)

    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1')).toHaveLength(2)
    sync.dispose()
  })

  it('truncates history after a /rewind shrinks the session file', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    sync.watch('term-1', file)
    expect(tracker.history('term-1')).toHaveLength(2)

    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    const history = tracker.history('term-1')
    expect(history).toHaveLength(1)
    expect(history[0].prompt).toBe('turn one')
    sync.dispose()
  })

  it('waits quietly for a session file that does not exist yet', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    sync.watch('term-1', file)
    expect(tracker.history('term-1')).toEqual([])

    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1')).toHaveLength(1)
    sync.dispose()
  })
})

describe('TurnTracker.replaceHistory', () => {
  it('replaces scraped records with session-derived ones', () => {
    const tracker = new TurnTracker(async () => null, null)
    const scraped: TurnRecord[] = [
      { index: 1, prompt: '(recovered turn)', reply: 'something', startedAt: 5, endedAt: 6 }
    ]
    tracker.replaceHistory('term-1', scraped)
    const exact: TurnRecord[] = [
      { index: 1, prompt: 'real prompt', reply: 'real reply', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'second', reply: 'r2', startedAt: 3, endedAt: 4 }
    ]
    tracker.replaceHistory('term-1', exact)
    expect(tracker.history('term-1')).toHaveLength(2)
    expect(tracker.history('term-1')[0].prompt).toBe('real prompt')
  })

  it('carries Sous titles over when index and prompt still match', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'fix the bug', reply: 'ok', title: 'Fixing the bug', startedAt: 1, endedAt: 2 }
    ])
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'fix the bug', reply: 'ok, richer reply', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'next', reply: 'done', startedAt: 3, endedAt: 4 }
    ])
    const history = tracker.history('term-1')
    expect(history[0].title).toBe('Fixing the bug')
    expect(history[1].title).toBeUndefined()
  })

  it('carries titles onto records whose scraped prompt was a placeholder', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: '(recovered turn)', reply: 'ok', title: 'Icon work', startedAt: 1, endedAt: 2 }
    ])
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'make it the app icon too', reply: 'ok', startedAt: 1, endedAt: 2 }
    ])
    expect(tracker.history('term-1')[0].title).toBe('Icon work')
  })

  it('drops titles when the turn at an index is a different exchange (rewind)', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'old direction', reply: 'a', title: 'Old title', startedAt: 1, endedAt: 2 }
    ])
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'completely new direction', reply: 'b', startedAt: 9, endedAt: 10 }
    ])
    expect(tracker.history('term-1')[0].title).toBeUndefined()
  })

  it('carries titles by uuid even when the index shifts (a mid-history turn dropped)', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u-a', title: 'Title A', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'b', reply: 'r', uuid: 'u-b', title: 'Title B', startedAt: 3, endedAt: 4 }
    ])
    // Turn 'a' was rewound away; 'b' is now index 1 but same uuid.
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'b', reply: 'r', uuid: 'u-b', startedAt: 3, endedAt: 4 }
    ])
    const history = tracker.history('term-1')
    expect(history).toHaveLength(1)
    expect(history[0].title).toBe('Title B')
  })

  it('drops the title when the uuid at a reused index changed (rewind + new prompt)', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u-a', title: 'Title A', startedAt: 1, endedAt: 2 }
    ])
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u-x', startedAt: 1, endedAt: 2 }
    ])
    expect(tracker.history('term-1')[0].title).toBeUndefined()
  })

  // The RESTART path, end-to-end with a real on-disk TurnStore: titles were
  // persisted last session; a fresh tracker re-derives history from the
  // session file and must merge the persisted titles back in and re-persist
  // them — otherwise "titles everywhere" regresses to sparse on every restart.
  it('preserves persisted titles across a simulated restart and re-persists them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-restart-'))
    // Last session's turn-store: titled records (legacy — no uuid yet).
    const before = new TurnStore(dir)
    before.scheduleSave('term-1', [
      { index: 1, prompt: 'commit and push', reply: 'done', title: 'Commit and push', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'run the tests', reply: 'green', title: 'Running the tests', startedAt: 3, endedAt: 4 }
    ])
    before.flushAll()

    // Restart: brand-new tracker + store over the same dir (in-memory lost).
    const restarted = new TurnTracker(async () => null, new TurnStore(dir))
    // Reconcile re-derives from the session file — same exchanges, now with uuids.
    restarted.replaceHistory('term-1', [
      { index: 1, prompt: 'commit and push', reply: 'done', uuid: 'u-1', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'run the tests', reply: 'green', uuid: 'u-2', startedAt: 3, endedAt: 4 }
    ])
    expect(restarted.history('term-1').map((r) => r.title)).toEqual([
      'Commit and push',
      'Running the tests'
    ])

    // The merged (titled + uuid) result must be persisted, so a later restart
    // matches by uuid with no further migration needed.
    restarted.flushHistories()
    const persisted = new TurnStore(dir).load('term-1')
    expect(persisted.map((r) => r.title)).toEqual(['Commit and push', 'Running the tests'])
    expect(persisted.map((r) => r.uuid)).toEqual(['u-1', 'u-2'])
  })

  // Historical records whose title was already wiped from disk by the buggy
  // build can't be carried (nothing to carry) — a paced Sous pump backfills
  // them so "titles everywhere" is restored, not just preserved. The pump is
  // ONE record per tick (bursting would trip the summarizer's down-cooldown).
  it('backfills untitled records one per tick, oldest first', async () => {
    vi.useFakeTimers()
    const titles: Record<string, string> = {
      'commit and push': 'Commit and push',
      'run the tests': 'Run the tests'
    }
    const summarize = async ({ prompt }: { prompt: string }): Promise<string | null> =>
      titles[prompt] ?? null
    const tracker = new TurnTracker(summarize, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'commit and push', reply: 'done', uuid: 'u-1', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'run the tests', reply: 'green', uuid: 'u-2', startedAt: 3, endedAt: 4 }
    ])
    // First tick titles the OLDEST (index 1) only.
    await vi.advanceTimersByTimeAsync(2000)
    expect(tracker.history('term-1').map((r) => r.title)).toEqual(['Commit and push', undefined])
    // Next tick titles index 2.
    await vi.advanceTimersByTimeAsync(2000)
    expect(tracker.history('term-1').map((r) => r.title)).toEqual([
      'Commit and push',
      'Run the tests'
    ])
    tracker.disposeAll()
  })

  it('survives the summarizer down-cooldown: a null tick retries and fills later', async () => {
    vi.useFakeTimers()
    let up = false
    // Mirrors sous.ts: returns null while "down", a title once up.
    const summarize = async (): Promise<string | null> => (up ? 'Titled' : null)
    const tracker = new TurnTracker(summarize, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u-1', startedAt: 1, endedAt: 2 }
    ])
    // Sous down: the first attempt nulls out, record stays untitled.
    await vi.advanceTimersByTimeAsync(2000)
    expect(tracker.history('term-1')[0].title).toBeUndefined()
    // Sous comes up; after the per-record retry cooldown a later tick fills it.
    up = true
    await vi.advanceTimersByTimeAsync(62_000)
    expect(tracker.history('term-1')[0].title).toBe('Titled')
    tracker.disposeAll()
  })

  it('does not re-summarize records that already carry a title', async () => {
    vi.useFakeTimers()
    let calls = 0
    const summarize = async (): Promise<string | null> => {
      calls += 1
      return 'X'
    }
    const tracker = new TurnTracker(summarize, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u-1', title: 'Kept', startedAt: 1, endedAt: 2 }
    ])
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u-1', startedAt: 1, endedAt: 2 }
    ])
    await vi.advanceTimersByTimeAsync(6000)
    expect(calls).toBe(0)
    expect(tracker.history('term-1')[0].title).toBe('Kept')
    tracker.disposeAll()
  })

  // The persistence regression: titled records saved BEFORE uuid-stamping have
  // no uuid; the first reconcile after the upgrade brings uuid-bearing session
  // records. A uuid-only lookup would miss the legacy prior and drop the title.
  it('migrates a legacy title (prior has no uuid) onto the uuid-bearing record', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'commit and push', reply: 'done', title: 'Commit and push', startedAt: 1, endedAt: 2 }
    ])
    // Re-derivation from the session file: same exchange, now carrying a uuid.
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'commit and push', reply: 'done', uuid: 'u-1', startedAt: 1, endedAt: 2 }
    ])
    const migrated = tracker.history('term-1')[0]
    expect(migrated.title).toBe('Commit and push')
    expect(migrated.uuid).toBe('u-1')
    // Persisted with uuid now → a later reconcile matches by uuid exactly.
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'commit and push', reply: 'done longer', uuid: 'u-1', startedAt: 1, endedAt: 2 }
    ])
    expect(tracker.history('term-1')[0].title).toBe('Commit and push')
  })
})
