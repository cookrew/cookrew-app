import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync } from '../src/main/session-sync'
import {
  createSessionTurnAccumulator,
  parseSessionTurns,
  type HistoryDelta,
  type StreamingTurnParser
} from '../src/shared/session-turns'
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
    sync.watch('term-1', file, parseSessionTurns)
    const history = tracker.history('term-1')
    expect(history.map((r) => r.prompt)).toEqual(['turn one', 'turn two'])
    expect(history.map((r) => r.index)).toEqual([1, 2])
    sync.dispose()
  })

  it('picks up appended turns on the poll', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns)
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
    sync.watch('term-1', file, parseSessionTurns)
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
    sync.watch('term-1', file, parseSessionTurns)
    expect(tracker.history('term-1')).toEqual([])

    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1')).toHaveLength(1)
    sync.dispose()
  })

  it('uses the harness parser passed to watch (non-Claude session formats)', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, 'whatever\n', 'utf8')
    const parse = (lines: string[]): TurnRecord[] => [
      { index: 1, prompt: `saw:${lines[0]}`, reply: 'r', uuid: 'x1', startedAt: 1, endedAt: 2 }
    ]
    sync.watch('term-1', file, parse)
    const history = tracker.history('term-1')
    expect(history).toHaveLength(1)
    expect(history[0].prompt).toBe('saw:whatever')
    expect(history[0].uuid).toBe('x1')
    sync.dispose()
  })

  it('does not reread an unchanged exact-context file after workspace detach', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    const parse = vi.fn(parseSessionTurns)

    sync.watch('term-1', file, parse)
    sync.suspend('term-1')
    sync.watch('term-1', file, parse)

    expect(parse).toHaveBeenCalledTimes(1)
    expect(tracker.history('term-1').map((turn) => turn.prompt)).toEqual(['turn one'])
    sync.dispose()
  })

  it('does reread after a permanent unwatch, which cannot retain context', () => {
    const { file, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    const parse = vi.fn(parseSessionTurns)

    sync.watch('term-1', file, parse)
    sync.unwatch('term-1')
    sync.watch('term-1', file, parse)

    expect(parse).toHaveBeenCalledTimes(2)
    sync.dispose()
  })

  it('reconciles after detach when the exact-context file changed', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    const parse = vi.fn(parseSessionTurns)
    sync.watch('term-1', file, parse)
    sync.suspend('term-1')

    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parse)

    expect(parse).toHaveBeenCalledTimes(2)
    expect(tracker.history('term-1').map((turn) => turn.prompt)).toEqual(['turn one', 'turn two'])
    sync.dispose()
  })

  it('reconciles an unchanged file when tracker history was cleared while detached', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    const parse = vi.fn(parseSessionTurns)
    sync.watch('term-1', file, parse)
    sync.suspend('term-1')
    tracker.clearHistory('term-1')

    sync.watch('term-1', file, parse)

    expect(parse).toHaveBeenCalledTimes(2)
    expect(tracker.history('term-1')).toHaveLength(1)
    sync.dispose()
  })

  it('reconciles when detached tracker history changed without changing length', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    const parse = vi.fn(parseSessionTurns)
    sync.watch('term-1', file, parse)
    sync.suspend('term-1')
    tracker.replaceHistory('term-1', [
      { index: 1, prompt: 'same count, wrong turn', reply: 'x', startedAt: 1, endedAt: 2 }
    ])

    sync.watch('term-1', file, parse)

    expect(parse).toHaveBeenCalledTimes(2)
    expect(tracker.history('term-1')[0].prompt).toBe('turn one')
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

  it('drops a uuid-less phantom echo adjacent to its uuid original on reconcile', () => {
    const tracker = new TurnTracker(async () => null, null)
    tracker.replaceHistory('term-1', [
      { index: 71, prompt: 'push', reply: 'done', uuid: 'u71', startedAt: 1, endedAt: 2 },
      { index: 72, prompt: 'push', reply: 'done', startedAt: 3, endedAt: 4 }
    ])
    const history = tracker.history('term-1')
    expect(history.map((r) => r.index)).toEqual([71])
    expect(history[0].uuid).toBe('u71')
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

// Fix 2 (Sol I3): observing one appended turn costs O(Δbytes) — on growth
// only the appended span is read and only the NEW lines reach the
// accumulator; a partial trailing line is carried as bytes until its newline
// arrives, so UTF-8 split at any byte boundary survives.
describe('SessionTurnSync incremental observation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** parseSessionTurns wrapped so every accumulator feed is recorded. */
  function instrumented(): { parse: StreamingTurnParser; feeds: string[][] } {
    const feeds: string[][] = []
    const createAccumulator = (): ReturnType<typeof createSessionTurnAccumulator> => {
      const inner = createSessionTurnAccumulator()
      return {
        feed(lines: string[]): void {
          feeds.push(lines)
          inner.feed(lines)
        },
        records: () => inner.records()
      }
    }
    const parse = Object.assign(
      (lines: string[]) => parseSessionTurns(lines),
      { createAccumulator }
    )
    return { parse, feeds }
  }

  it('feeds ONLY the appended lines on growth — earlier lines are never re-read', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    const { parse, feeds } = instrumented()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parse)
    expect(tracker.history('term-1')).toHaveLength(1)
    const feedsAfterInitial = feeds.length

    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1')).toHaveLength(2)
    const later = feeds.slice(feedsAfterInitial).flat()
    expect(later.some((line) => line.includes('turn two'))).toBe(true)
    expect(later.some((line) => line.includes('turn one'))).toBe(false)
    sync.dispose()
  })

  it('a shrink resets the accumulator and pays one full re-parse (rewind path)', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    const { parse, feeds } = instrumented()
    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parse)
    expect(tracker.history('term-1')).toHaveLength(2)

    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['turn one'])
    // The re-parse fed 'turn one' again — a fresh accumulator, not a resume.
    expect(feeds.flat().filter((line) => line.includes('turn one')).length).toBeGreaterThan(1)
    sync.dispose()
  })

  it('replacement by a same-size different-inode file is detected, not treated as quiet', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    // Same byte length as TURN_1 so size alone cannot reveal the swap.
    const swapped = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'turn six' }, timestamp: '2026-07-20T10:00:00Z', sessionId: 'src' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply six' }] }, timestamp: '2026-07-20T10:00:10Z', sessionId: 'src' })
    ]
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns)
    expect(tracker.history('term-1')[0].prompt).toBe('turn one')

    const replacement = path.join(path.dirname(file), 'replacement.jsonl')
    writeFileSync(replacement, swapped.join('\n') + '\n', 'utf8')
    const { renameSync } = await import('node:fs')
    renameSync(replacement, file)
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1')[0].prompt).toBe('turn six')
    sync.dispose()
  })

  // Sol round-2 #4a: dormancy must not forfeit the accumulator. A suspended
  // terminal whose file only GREW resumes from the retained parser state and
  // byte offset — reattaching a parked workspace feeds the appended lines
  // only, never the whole transcript.
  it('dormant GROWTH resumes the retained accumulator — reattach feeds only the appended lines', async () => {
    const { file, tracker, sync } = fixture()
    const { parse, feeds } = instrumented()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parse)
    sync.suspend('term-1')

    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    const feedsBefore = feeds.length
    sync.watch('term-1', file, parse)

    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['turn one', 'turn two'])
    const later = feeds.slice(feedsBefore).flat()
    expect(later.some((line) => line.includes('turn two'))).toBe(true)
    expect(later.some((line) => line.includes('turn one'))).toBe(false)
    sync.dispose()
  })

  it('a SHRINK while dormant still resets and re-parses whole (rewind while parked)', async () => {
    const { file, tracker, sync } = fixture()
    const { parse, feeds } = instrumented()
    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parse)
    sync.suspend('term-1')

    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parse)

    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['turn one'])
    // The re-parse fed 'turn one' again — a fresh accumulator, not a resume.
    expect(feeds.flat().filter((line) => line.includes('turn one')).length).toBeGreaterThan(1)
    sync.dispose()
  })

  it('property: randomized byte-level appends (mid-line, mid-UTF-8) equal the whole-file parse', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    for (let turn = 0; turn < 8; turn += 1) {
      lines.push(user(`prompt ${turn} — été 目标 ✓`, `2026-07-20T10:0${turn}:00Z`))
      lines.push(assistant(`reply ${turn} — naïve 完成`, `2026-07-20T10:0${turn}:10Z`))
    }
    const whole = Buffer.from(lines.join('\n') + '\n', 'utf8')
    // Deterministic LCG: a failing sequence is reproducible from the seed.
    let state = 42
    const rand = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x100000000
    }
    const { file, tracker, sync } = fixture()
    writeFileSync(file, Buffer.alloc(0))
    sync.watch('t', file, parseSessionTurns)
    let at = 0
    while (at < whole.length) {
      const size = 1 + Math.floor(rand() * 40)
      appendFileSync(file, whole.subarray(at, Math.min(at + size, whole.length)))
      at += size
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('t')).toEqual(parseSessionTurns(lines))
    sync.dispose()
  })
})

// Sol r4 P1 (end-to-end O(delta)): a growth reconcile hands the tracker a
// DELTA through applyHistoryDelta — the seam the parallel lane implements on
// TurnTracker — instead of replaceHistory's whole-history re-projection. The
// seam is feature-checked BOTH ways and the check is permanent
// compatibility: no takeDelta (retained-lines fallback) or no
// applyHistoryDelta (tracker without the seam) falls back to replaceHistory;
// shrink/rotation/first-contact stay on replaceHistory by design.
describe('SessionTurnSync delta handoff (Sol r4 P1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  interface DeltaCall {
    terminalId: string
    delta: HistoryDelta
  }

  type DeltaSeam = TurnTracker & {
    applyHistoryDelta?: (
      terminalId: string,
      delta: HistoryDelta,
      records: () => TurnRecord[]
    ) => void
  }

  /** Arm the tracker's delta seam with a spy. The REAL applyHistoryDelta is
   *  wrapped when the tracker has one (the cross-lane integration this gate
   *  exists for); a tracker predating the seam gets an emulation that
   *  follows the HistoryDelta apply contract, so the handoff assertions
   *  hold either way. */
  function armDeltaSeam(tracker: TurnTracker): DeltaCall[] {
    const calls: DeltaCall[] = []
    const real = (tracker as DeltaSeam).applyHistoryDelta?.bind(tracker)
    ;(tracker as DeltaSeam).applyHistoryDelta = (terminalId, delta, records) => {
      calls.push({ terminalId, delta })
      if (real !== undefined) {
        real(terminalId, delta, records)
        return
      }
      if (delta.kind === 'reset') {
        tracker.replaceHistory(terminalId, records())
        return
      }
      const prior = tracker.history(terminalId)
      if (delta.kind === 'tail') {
        tracker.replaceHistory(terminalId, [...prior.slice(0, -1), delta.record])
        return
      }
      if (delta.records.length === 0) return
      tracker.replaceHistory(terminalId, [...prior, ...delta.records])
    }
    return calls
  }

  /** One END_TURN-closed exchange — the marker keeps the tail settled, so an
   *  appended turn's delta is exactly one record. */
  function closedTurn(n: number): string[] {
    return [
      user(`prompt ${n}`, `2026-07-20T10:00:${String(n % 60).padStart(2, '0')}Z`),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `reply ${n}` }],
          stop_reason: 'end_turn'
        },
        timestamp: `2026-07-20T10:00:${String(n % 60).padStart(2, '0')}Z`,
        sessionId: 'src'
      })
    ]
  }

  it('a 300-turn file growing by ONE turn hands downstream a one-record append — never the history', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    const backlog = Array.from({ length: 300 }, (_, n) => closedTurn(n)).flat()
    writeFileSync(file, backlog.join('\n') + '\n', 'utf8')
    const deltas = armDeltaSeam(tracker)
    const replace = vi.spyOn(tracker, 'replaceHistory')

    // First contact is a FULL parse and stays on replaceHistory by design.
    sync.watch('term-1', file, parseSessionTurns)
    expect(tracker.history('term-1')).toHaveLength(300)
    expect(deltas).toHaveLength(0)
    const replacesAfterWatch = replace.mock.calls.length

    appendFileSync(file, closedTurn(300).join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)

    expect(deltas).toHaveLength(1)
    expect(deltas[0].terminalId).toBe('term-1')
    const delta = deltas[0].delta
    expect(delta.kind).toBe('append')
    if (delta.kind === 'append') {
      expect(delta.records).toHaveLength(1)
      expect(delta.records[0].index).toBe(301)
    }
    // The applied result is exact — same 301 records a whole parse derives.
    expect(tracker.history('term-1')).toEqual(
      parseSessionTurns([...backlog, ...closedTurn(300)])
    )
    // And growth itself paid no replaceHistory beyond the seam's own apply.
    expect(replace.mock.calls.length - replacesAfterWatch).toBeLessThanOrEqual(1)
    sync.dispose()
  })

  it('repeated delta growths stay exact — every applied step equals the whole-file parse', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    const lines = closedTurn(0)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    armDeltaSeam(tracker)
    sync.watch('term-1', file, parseSessionTurns)

    for (let n = 1; n <= 4; n += 1) {
      const next = closedTurn(n)
      appendFileSync(file, next.join('\n') + '\n', 'utf8')
      lines.push(...next)
      await vi.advanceTimersByTimeAsync(200)
      expect(tracker.history('term-1'), `after turn ${n}`).toEqual(parseSessionTurns(lines))
    }
    sync.dispose()
  })

  it('a tracker WITHOUT applyHistoryDelta keeps the replaceHistory path — the compatibility seam', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    // Pin the seam absent even after the parallel lane lands it on the class.
    ;(tracker as { applyHistoryDelta?: unknown }).applyHistoryDelta = undefined
    writeFileSync(file, closedTurn(0).join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns)

    appendFileSync(file, closedTurn(1).join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['prompt 0', 'prompt 1'])
    sync.dispose()
  })

  it('a shrink stays on replaceHistory even when the delta seam exists (the invalidation path)', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, [...closedTurn(0), ...closedTurn(1)].join('\n') + '\n', 'utf8')
    const deltas = armDeltaSeam(tracker)
    sync.watch('term-1', file, parseSessionTurns)

    writeFileSync(file, closedTurn(0).join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(deltas).toHaveLength(0)
    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['prompt 0'])
    sync.dispose()
  })

  it('the retained-lines fallback (no createAccumulator) keeps the old path even with the seam armed', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, 'one\n', 'utf8')
    const deltas = armDeltaSeam(tracker)
    // A plain parser without takeDelta: its accumulator retains lines and
    // re-parses — it has no O(delta) story, so it must not pretend to one.
    const parse = (lines: string[]): TurnRecord[] =>
      lines.map((line, at) => ({
        index: at + 1,
        prompt: line,
        reply: '',
        startedAt: at,
        endedAt: at
      }))
    sync.watch('term-1', file, parse)
    appendFileSync(file, 'two\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)

    expect(deltas).toHaveLength(0)
    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['one', 'two'])
    sync.dispose()
  })
})

// Fix 5: the initial watch parse is deferrable off the accept path — the
// poll timer covers the reconcile within one tick.
describe('SessionTurnSync deferInitial', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips the synchronous reconcile and lets the timer land it', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns, { deferInitial: true })
    // Nothing parsed inline — the accept path paid nothing.
    expect(tracker.history('term-1')).toEqual([])
    // The timer is armed: one poll later the reconcile lands.
    await vi.advanceTimersByTimeAsync(200)
    expect(tracker.history('term-1').map((r) => r.prompt)).toEqual(['turn one'])
    sync.dispose()
  })

  it('default behavior is unchanged — the first reconcile is synchronous', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns)
    expect(tracker.history('term-1')).toHaveLength(1)
    sync.dispose()
  })
})

// REFACTOR STEP 4 (checkpoint-as-identity): SessionTurnSync is the ONLY thing
// allowed to take a terminal off the scrape path, and only once a reconcile
// has actually landed. Declaring turns: 'file' is not enough — between spawn
// and the first session-file write nothing could record at all.
describe('SessionTurnSync history-source handover', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves the terminal scraping while the session file does not exist yet', () => {
    const { file, tracker, sync } = fixture()
    const sources: Array<[string, string]> = []
    tracker.setHistorySource = (id, source) => void sources.push([id, source])

    sync.watch('term-1', file, parseSessionTurns) // file not written yet
    expect(sources).toEqual([['term-1', 'scrape']])
    sync.dispose()
  })

  it('hands history over to the file on the first successful reconcile', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    const sources: Array<[string, string]> = []
    tracker.setHistorySource = (id, source) => void sources.push([id, source])

    sync.watch('term-1', file, parseSessionTurns)
    expect(sources.at(-1)).toEqual(['term-1', 'scrape'])

    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(200)
    expect(sources.at(-1)).toEqual(['term-1', 'file'])
    sync.dispose()
  })

  it('puts the terminal BACK on the scrape until a rebound file proves itself', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns)

    const sources: Array<[string, string]> = []
    tracker.setHistorySource = (id, source) => void sources.push([id, source])
    // Restore/rewind rebinds the node to a session file that does not exist
    // yet — the window reopens, so the scrape has to cover it again.
    sync.watch('term-1', path.join(path.dirname(file), 'rebound.jsonl'), parseSessionTurns)
    expect(sources).toEqual([['term-1', 'scrape']])
    sync.dispose()
  })

  it('returns the terminal to the scrape path on unwatch and dispose', () => {
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('term-1', file, parseSessionTurns)

    const sources: Array<[string, string]> = []
    tracker.setHistorySource = (id, source) => void sources.push([id, source])
    sync.unwatch('term-1')
    expect(sources).toEqual([['term-1', 'scrape']])

    const second = fixture()
    second.sync.watch('term-2', file, parseSessionTurns)
    const disposed: Array<[string, string]> = []
    second.tracker.setHistorySource = (id, source) => void disposed.push([id, source])
    second.sync.dispose()
    expect(disposed).toEqual([['term-2', 'scrape']])
  })
})
