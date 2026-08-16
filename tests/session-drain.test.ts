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
