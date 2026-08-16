// Sol round-2 #5: a session ROTATION migrates the watch, it does not
// restart the terminal's tracking life. unwatch()+watch() erases the pin an
// open background dispatch still owns, the subscriber count a live viewer
// still owns, and the draining fact — so the dispatch loses its hold and
// the fresh watch polls forever. sessionSync.rebind() swaps ONLY the
// binding (file/parser/accumulator/offsets, full re-parse of the NEW file)
// while every tracking fact survives and the drain/stale clocks restart at
// zero for the new binding generation.

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAIN_TICKS, SessionTurnSync } from '../src/main/session-sync'
import { parseSessionTurns } from '../src/shared/session-turns'
import { TurnTracker } from '../src/main/turn-tracker'

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
const TURN_3 = [user('turn three', '2026-07-20T10:02:00Z'), assistant('reply three', '2026-07-20T10:02:10Z')]

const POLL_MS = 50

function fixture(): {
  fileA: string
  fileB: string
  tracker: TurnTracker
  sync: SessionTurnSync
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-rebind-'))
  const fileA = path.join(dir, 'old-session.jsonl')
  const fileB = path.join(dir, 'rotated-session.jsonl')
  writeFileSync(fileA, TURN_1.join('\n') + '\n', 'utf8')
  writeFileSync(fileB, TURN_2.join('\n') + '\n', 'utf8')
  const tracker = new TurnTracker(async () => null, null)
  const sync = new SessionTurnSync(tracker, POLL_MS)
  return { fileA, fileB, tracker, sync }
}

async function ticks(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS * n)
}

describe('SessionTurnSync.rebind — rotation keeps the tracking facts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('swaps the binding: history now mirrors the successor file (full re-parse)', () => {
    const { fileA, fileB, tracker, sync } = fixture()
    sync.watch('t', fileA, parseSessionTurns)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn one'])
    sync.rebind('t', fileB, parseSessionTurns)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn two'])
    sync.dispose()
  })

  it('a rotation during a background PINNED dispatch keeps the pin, then drains after unpin', async () => {
    vi.useFakeTimers()
    const { fileA, fileB, tracker, sync } = fixture()
    sync.watch('t', fileA, parseSessionTurns)
    sync.release('t')
    sync.pin('t') // an open background dispatch
    sync.rebind('t', fileB, parseSessionTurns)
    // The pin survived the rebind: quiet far past every window, still watching.
    await ticks(DRAIN_TICKS * 4)
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn two', 'turn three'])
    // Dispatch settles: the ordinary drain clock owns the terminal again…
    sync.unpin('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(fileB, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    // …and it drained — no leaked per-agent polling after the rotation.
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('live subscribers survive the rebind and still hold the watch', async () => {
    vi.useFakeTimers()
    const { fileA, fileB, tracker, sync } = fixture()
    sync.watch('t', fileA, parseSessionTurns)
    sync.subscribe('t')
    sync.release('t')
    sync.rebind('t', fileB, parseSessionTurns)
    await ticks(DRAIN_TICKS * 4)
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    // The last unsubscribe re-arms the drain, exactly as on a plain watch.
    sync.unsubscribe('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(fileB, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('preserves the draining fact with a FRESH clock — a released terminal still drains, later', async () => {
    vi.useFakeTimers()
    const { fileA, fileB, tracker, sync } = fixture()
    sync.watch('t', fileA, parseSessionTurns)
    sync.release('t')
    // Most of the window elapsed on the old binding…
    await ticks(DRAIN_TICKS - 2)
    sync.rebind('t', fileB, parseSessionTurns)
    // …but the successor is a fresh binding generation: a partial window is
    // not enough to drain it…
    await ticks(DRAIN_TICKS - 2)
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    // …while the full window still is (released stayed released).
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(fileB, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('contrast pin: unwatch()+watch() destroys it — the exact leak rebind exists to prevent', async () => {
    vi.useFakeTimers()
    const { fileA, fileB, tracker, sync } = fixture()
    sync.watch('t', fileA, parseSessionTurns)
    sync.release('t')
    sync.pin('t')
    sync.unwatch('t')
    sync.watch('t', fileB, parseSessionTurns)
    sync.release('t')
    // The dispatch's pin is gone: the watch drains out from under it.
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })
})
