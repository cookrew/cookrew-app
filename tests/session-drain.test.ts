// v5 work-driven tracking (axiom A4): when focus leaves a workspace, its
// terminals' session files stay watched WHILE WORK IS HAPPENING — the file
// growing is the work, no flag involved — and drain to a suspended signature
// after a debounced quiet window. A pin (an in-flight dispatch) holds the
// watch open through arbitrarily long quiet stretches (a tool call writes
// nothing for minutes). Nothing here ever kills a pane; drain only stops
// watching, and the suspended signature makes the next watch() byte-free.

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAIN_TICKS, HOLD_TRUST_TICKS, SessionTurnSync } from '../src/main/session-sync'
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

function fixture(): { file: string; tracker: TurnTracker; sync: SessionTurnSync } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-drain-'))
  const file = path.join(dir, 'abc.jsonl')
  const tracker = new TurnTracker(async () => null, null)
  const sync = new SessionTurnSync(tracker, POLL_MS)
  return { file, tracker, sync }
}

async function ticks(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS * n)
}

describe('SessionTurnSync drain (v5 work-driven tracking)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a released terminal keeps recording while its file grows', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('a quiet released terminal drains after the debounce window', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    await ticks(DRAIN_TICKS + 2)
    // Drained: growth is no longer observed…
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    // …and the drain handed history authority back to the scrape.
    // A fresh watch() reconciles the missed growth in one pass.
    sync.watch('t', file, parseSessionTurns)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('file growth resets the drain clock', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    await ticks(DRAIN_TICKS - 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(DRAIN_TICKS - 2)
    // Neither quiet stretch reached the window on its own — still watching.
    appendFileSync(file, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(3)
    sync.dispose()
  })

  it('a pinned terminal never drains, however long the quiet', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    sync.pin('t')
    await ticks(DRAIN_TICKS * 4)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    // The pin lifting re-arms the ordinary drain.
    sync.unpin('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('watch() cancels a pending drain (refocus pins by presence)', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    await ticks(DRAIN_TICKS - 2)
    sync.watch('t', file, parseSessionTurns)
    await ticks(DRAIN_TICKS * 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('unwatch clears the pin — a permanent release owes nothing', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.pin('t')
    sync.unwatch('t')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })
})

// Fix 3 (Sol P0): drain must not fire while there is positive evidence of
// work — hooks.holdOpen (herdr agent_status working/blocked). A hold, not a
// reset: quiet ticks keep accumulating, so the drain fires on the FIRST
// quiet tick after the hold clears. Round-2 #6 bounds the trust: a status
// hold whose file has not grown for HOLD_TRUST_TICKS is a stuck feed, not a
// turn, and stops holding — pins and subscribers are exempt (owned facts).
describe('SessionTurnSync holdOpen hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function heldFixture(): {
    file: string
    tracker: TurnTracker
    sync: SessionTurnSync
    state: { held: boolean }
  } {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-hold-'))
    const file = path.join(dir, 'abc.jsonl')
    const tracker = new TurnTracker(async () => null, null)
    const state = { held: false }
    const sync = new SessionTurnSync(tracker, POLL_MS, { holdOpen: () => state.held })
    return { file, tracker, sync, state }
  }

  it('a held terminal survives quiet stretches the drain window alone would not allow', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, state } = heldFixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    state.held = true
    // Past DRAIN_TICKS but under the trust bound: the hold is still believed.
    await ticks(HOLD_TRUST_TICKS - 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('a hold with NO file growth expires at HOLD_TRUST_TICKS — a stuck feed cannot hold forever', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, state } = heldFixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    state.held = true
    // The status claims work forever; the file writes nothing. Once the
    // quiet count passes the trust bound the claim stops counting and the
    // (long-elapsed) drain window closes.
    await ticks(HOLD_TRUST_TICKS + 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })

  it('growth under a hold re-earns the trust — a genuinely working agent is never cut off', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, state } = heldFixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    state.held = true
    // Each growth resets the quiet count, so the trust bound never trips.
    await ticks(HOLD_TRUST_TICKS - 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(HOLD_TRUST_TICKS - 2)
    appendFileSync(file, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(3)
    sync.dispose()
  })

  it('a PIN outlives the trust bound — first-party facts are not status claims', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = heldFixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    sync.pin('t')
    await ticks(HOLD_TRUST_TICKS * 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('the drain fires on the FIRST quiet tick after the hold clears (no reset)', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, state } = heldFixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    state.held = true
    // The quiet window elapsed entirely under the hold…
    await ticks(DRAIN_TICKS * 2)
    state.held = false
    // …so ONE quiet tick after it clears is enough to drain.
    await ticks(1)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })

  it('a hold that clears before the window elapses changes nothing', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, state } = heldFixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    state.held = true
    await ticks(3)
    state.held = false
    // Ticks accumulated through the hold: the window closes on schedule.
    await ticks(DRAIN_TICKS)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })
})

// Fix 4: live subscribers are a tracking fact — a terminal someone is
// watching may not drain (same treatment as a pin: the last unsubscribe
// re-arms the drain clock).
describe('SessionTurnSync subscribers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a subscriber holds the drain through the whole window', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.subscribe('t')
    sync.release('t')
    await ticks(DRAIN_TICKS * 4)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('the last unsubscribe re-arms the clock — a full window before drain', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.subscribe('t')
    sync.release('t')
    await ticks(DRAIN_TICKS * 2)
    sync.unsubscribe('t')
    // Re-armed: a partial window is not enough…
    await ticks(DRAIN_TICKS - 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    // …the full window is.
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('double-subscribe needs two unsubscribes before the drain may fire', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.subscribe('t')
    sync.subscribe('t')
    sync.unsubscribe('t')
    sync.release('t')
    // One subscriber remains: no drain.
    await ticks(DRAIN_TICKS * 3)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    // The second unsubscribe releases the hold.
    sync.unsubscribe('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  // Sol round-2 #3: subscribe() must ENSURE the watch, not merely hold one
  // that happens to exist — a remote viewer opening a stream on a drained or
  // never-watched terminal is entitled to the record.
  it('subscribing a DRAINED terminal resumes the watch from its dormant signature', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    await ticks(DRAIN_TICKS + 2)
    // Drained. A viewer arrives; growth is observed again…
    sync.subscribe('t')
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    // …and holds through arbitrary quiet, exactly like any subscriber.
    await ticks(DRAIN_TICKS * 3)
    appendFileSync(file, TURN_3.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(3)
    // The viewer leaves: the ensured watch drains on the ordinary clock —
    // a peek at a parked terminal leaks nothing.
    sync.unsubscribe('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(3)
    sync.dispose()
  })

  it('subscribing a NEVER-watched terminal starts the watch via hooks.resolveWatch', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-sub-resolve-'))
    const file = path.join(dir, 'abc.jsonl')
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    const tracker = new TurnTracker(async () => null, null)
    const resolved: string[] = []
    const sync = new SessionTurnSync(tracker, POLL_MS, {
      resolveWatch: (terminalId) => {
        resolved.push(terminalId)
        return { file, parse: parseSessionTurns }
      }
    })
    sync.subscribe('t')
    expect(resolved).toEqual(['t'])
    // The initial reconcile is deferred off the subscribe path; the poll
    // timer lands it within a tick.
    await ticks(3)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn one'])
    // Last unsubscribe: the ensured watch drains, nothing leaks.
    sync.unsubscribe('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })

  it('a terminal the resolver cannot name subscribes without a watch — honest, no crash', async () => {
    vi.useFakeTimers()
    const { tracker, sync } = fixture()
    sync.subscribe('unknown')
    await ticks(3)
    expect(tracker.history('unknown')).toEqual([])
    sync.unsubscribe('unknown')
    sync.dispose()
  })

  it('an abrupt DOUBLE-unsubscribe never goes negative — the next subscriber still holds', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.subscribe('t')
    // A stream that errors after its close handler already ran: two
    // unsubscribes for one subscribe.
    sync.unsubscribe('t')
    sync.unsubscribe('t')
    // A NEW viewer arrives; its hold must be whole, not pre-consumed.
    sync.subscribe('t')
    sync.release('t')
    await ticks(DRAIN_TICKS * 3)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('a subscriber holds the record through a workspace SWITCH (release + long quiet)', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.subscribe('t')
    // Focus leaves the workspace; the remote viewer is still looking.
    sync.release('t')
    await ticks(DRAIN_TICKS * 4)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(2)
    sync.dispose()
  })

  it('unwatch clears subscriber counts — a rebound terminal owes nothing', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    sync.subscribe('t')
    sync.unwatch('t')
    sync.watch('t', file, parseSessionTurns)
    sync.release('t')
    await ticks(DRAIN_TICKS + 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(3)
    expect(tracker.history('t')).toHaveLength(1)
    sync.dispose()
  })
})
