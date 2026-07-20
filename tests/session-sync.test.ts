import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync } from '../src/main/session-sync'
import { TurnTracker } from '../src/main/turn-tracker'
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
})
