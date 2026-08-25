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

  /**
   * THIS EXPECTATION CHANGED WITH THE LINEAGE FIX — it used to be ['turn two'].
   *
   * The successor file is still fully re-parsed; what changed is what the
   * tracker does with the result. A rotation is the SAME conversation in a new
   * file, so replacing the ledger with the successor's turns alone ORPHANS
   * every checkpoint before the rotation — which is the bug this whole lane
   * exists for, and how the owner lost 400+ of them. The ledger continues
   * across the seam and the turns are numbered by their position in the
   * LINEAGE, not their position in the new file.
   *
   * The licence to do that is issued by rebind() and by nothing else: the
   * unwatch()+watch() contrast at the bottom of this file still replaces, and
   * that is the assertion which proves the scope.
   */
  it('swaps the binding and CONTINUES the ledger across the rotation', () => {
    const { fileA, fileB, tracker, sync } = fixture()
    sync.watch('t', fileA, parseSessionTurns)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn one'])
    sync.rebind('t', fileB, parseSessionTurns)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn one', 'turn two'])
    expect(tracker.history('t').map((r) => r.index)).toEqual([1, 2])
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
    const held = tracker.history('t').length
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    // Still watching: the appended turn landed. Asserted as GROWTH rather than
    // a hardcoded count — what this test is about is whether the pin kept the
    // watch alive, and a fixed number would couple it to how the ledger
    // numbers a rotation, which is a different question entirely.
    expect(tracker.history('t')).toHaveLength(held + 1)
    expect(tracker.history('t').at(-1)?.prompt).toBe('turn three')
    // Dispatch settles: the ordinary drain clock owns the terminal again…
    sync.unpin('t')
    await ticks(DRAIN_TICKS + 2)
    const drained = tracker.history('t').length
    appendFileSync(fileB, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    // …and it drained — no leaked per-agent polling after the rotation.
    expect(tracker.history('t')).toHaveLength(drained)
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
    const held = tracker.history('t').length
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(held + 1) // still watching
    // The last unsubscribe re-arms the drain, exactly as on a plain watch.
    sync.unsubscribe('t')
    await ticks(DRAIN_TICKS + 2)
    const drained = tracker.history('t').length
    appendFileSync(fileB, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(drained) // drained
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
    const held = tracker.history('t').length
    appendFileSync(fileB, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(held + 1) // still watching
    // …while the full window still is (released stayed released).
    await ticks(DRAIN_TICKS + 2)
    const drained = tracker.history('t').length
    appendFileSync(fileB, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(drained) // drained
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
