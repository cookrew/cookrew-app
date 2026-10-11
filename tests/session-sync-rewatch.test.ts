// RE-WATCHING A LIVE WATCH IS A NO-OP — the observer that already materialized
// stays materialized.
//
// THE BUG (2026-10-11, the dispatch ledger): after a restart every ask to a
// reattached pane came back `interrupted: observer never materialized` while
// the agent visibly answered. The admission dep is `sessionSync.isVerified`,
// and the lazy-terminal linger calls `watchSessionTurns(id, {deferInitial})`
// on EVERY `working` status event (lazy-terminal.ts · watchWorking). watch()
// treated a live entry like a dormant one: it kept the verified history only
// when the tracker's memoized snapshot was still the same object, and the
// tracker drops that memo on every commit — so each status event replaced a
// verified watch with a fresh null-history one (and a full re-parse of a
// 140 MB transcript). The probation sweep, sixty seconds later, found a
// watch that had "never" materialized.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync } from '../src/main/session-sync'
import { parseSessionTurns, type StreamingTurnParser } from '../src/shared/session-turns'
import { TurnTracker } from '../src/main/turn-tracker'

const user = (content: string, ts: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: ts, sessionId: 'src' })
const assistant = (text: string, ts: string): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts, sessionId: 'src' })
const TURN_1 = [user('turn one', '2026-07-20T10:00:00Z'), assistant('reply one', '2026-07-20T10:00:10Z')]
const TURN_2 = [user('turn two', '2026-07-20T10:01:00Z'), assistant('reply two', '2026-07-20T10:01:10Z')]

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-rewatch-'))
  const file = path.join(dir, 'abc.jsonl')
  const tracker = new TurnTracker(async () => null, null)
  const sync = new SessionTurnSync(tracker, 50)
  // One parser object for every watch call, as the harness table gives the app.
  const createAccumulator = vi.fn(parseSessionTurns.createAccumulator)
  const parse: StreamingTurnParser & { createAccumulator: typeof createAccumulator } = Object.assign(
    (lines: string[]) => parseSessionTurns(lines),
    { createAccumulator }
  )
  return { file, tracker, sync, parse }
}

afterEach(() => vi.useRealTimers())

describe('watch() on a terminal that is already watched', () => {
  it('keeps the verified observer when the tracker snapshot has moved on, and does not re-parse', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, parse } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parse)
    expect(sync.isVerified('t')).toBe(true)
    const parses = parse.createAccumulator.mock.calls.length
    // A commit elsewhere drops the tracker's memoized snapshot, exactly as a
    // scrape or a delta does between two status events.
    tracker.replaceHistory('t', tracker.history('t'), { sessionFile: file })
    expect(tracker.history('t')).not.toBe(tracker.history('t').slice())
    // The linger's re-watch on a `working` status event.
    sync.watch('t', file, parse, { deferInitial: true })
    expect(sync.isVerified('t')).toBe(true)
    await vi.advanceTimersByTimeAsync(120)
    expect(sync.isVerified('t')).toBe(true)
    expect(parse.createAccumulator.mock.calls.length).toBe(parses)
    sync.dispose()
  })

  it('still follows growth after a re-watch, and clears the drain it was handed', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, parse } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parse)
    sync.release('t')
    sync.watch('t', file, parse, { deferInitial: true })
    writeFileSync(file, [...TURN_1, ...TURN_2].join('\n') + '\n', 'utf8')
    await vi.advanceTimersByTimeAsync(120)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn one', 'turn two'])
    expect(sync.isVerified('t')).toBe(true)
    sync.dispose()
  })

  it('a re-watch onto a DIFFERENT file is still a fresh watch', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, parse } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parse)
    const other = `${file}.other`
    writeFileSync(other, TURN_2.join('\n') + '\n', 'utf8')
    sync.watch('t', other, parse, { deferInitial: true })
    expect(sync.isVerified('t')).toBe(false)
    await vi.advanceTimersByTimeAsync(120)
    expect(sync.isVerified('t')).toBe(true)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn two'])
    sync.dispose()
  })
})
