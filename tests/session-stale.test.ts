// Fix 6: stale/rotation detection. A terminal that CLAIMS to be mid-turn
// (hooks.isInTurn) while its bound file takes STALE_TICKS polls without
// byte growth is reported via onStale — the rotated-session signature
// (`claude --resume` under the same pane writes a NEW file, touching the old
// one without appending). The counter is reset BEFORE the handler runs so a
// rebind inside onStale is never clobbered, and it reports at most once per
// window. Separate clock from drain: growth and shrink reset it, an mtime
// touch does not.

import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STALE_TICKS, SessionTurnSync } from '../src/main/session-sync'
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

const POLL_MS = 50

function fixture(): {
  file: string
  tracker: TurnTracker
  sync: SessionTurnSync
  state: { inTurn: boolean }
  stale: string[]
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-stale-'))
  const file = path.join(dir, 'abc.jsonl')
  const tracker = new TurnTracker(async () => null, null)
  const state = { inTurn: false }
  const stale: string[] = []
  const sync = new SessionTurnSync(tracker, POLL_MS, {
    isInTurn: () => state.inTurn,
    onStale: (terminalId) => stale.push(terminalId)
  })
  return { file, tracker, sync, state, stale }
}

async function ticks(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS * n)
}

describe('SessionTurnSync staleness (rotation-rebind foundation)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onStale only when in-turn — an idle quiet file is rest, not rot', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    await ticks(STALE_TICKS * 3)
    expect(stale).toEqual([])
    state.inTurn = true
    await ticks(1)
    expect(stale).toEqual(['t'])
    sync.dispose()
  })

  it('byte growth resets the stale clock', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    state.inTurn = true
    await ticks(STALE_TICKS - 2)
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(STALE_TICKS - 2)
    expect(stale).toEqual([])
    await ticks(4)
    expect(stale).toEqual(['t'])
    sync.dispose()
  })

  it('an mtime touch does NOT reset the clock — --resume touches without appending', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    state.inTurn = true
    for (let i = 0; i < STALE_TICKS; i += 1) {
      const when = new Date(Date.parse('2026-07-20T11:00:00Z') + i * 1000)
      utimesSync(file, when, when)
      await ticks(1)
    }
    expect(stale).toEqual(['t'])
    sync.dispose()
  })

  it('never refires on IDENTICAL evidence — one report until the stat moves (round-2 #6)', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    state.inTurn = true
    await ticks(STALE_TICKS)
    expect(stale).toEqual(['t'])
    // The stat never moves again: however many windows elapse, the picture
    // is the same stuck picture, and re-reporting it would launch a
    // rotation scan every window forever.
    await ticks(STALE_TICKS * 5)
    expect(stale).toEqual(['t'])
    sync.dispose()
  })

  it('a stat delta (growth) re-arms the report — a NEW stall is new evidence', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    state.inTurn = true
    await ticks(STALE_TICKS)
    expect(stale).toEqual(['t'])
    // The file moves (a growth here; any stat delta clears the latch), then
    // stalls again for a full window: that is a fresh stall, reported once.
    appendFileSync(file, TURN_2.join('\n') + '\n', 'utf8')
    await ticks(STALE_TICKS + 2)
    expect(stale).toEqual(['t', 't'])
    // …and the fresh stall is again reported only once.
    await ticks(STALE_TICKS * 3)
    expect(stale).toEqual(['t', 't'])
    sync.dispose()
  })

  it('a bare mtime TOUCH is a stat delta too — --resume touching the file re-arms one report', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    writeFileSync(file, TURN_1.join('\n') + '\n', 'utf8')
    sync.watch('t', file, parseSessionTurns)
    state.inTurn = true
    await ticks(STALE_TICKS)
    expect(stale).toEqual(['t'])
    // A touch does not reset the stale CLOCK (still no growth), but it is
    // new evidence, so the suppression clears and the next due window fires.
    const when = new Date(Date.parse('2026-07-20T12:00:00Z'))
    utimesSync(file, when, when)
    await ticks(STALE_TICKS + 2)
    expect(stale).toEqual(['t', 't'])
    sync.dispose()
  })

  it('a file that never reconciled cannot go stale', async () => {
    vi.useFakeTimers()
    const { file, sync, state, stale } = fixture()
    // The file does not exist: nothing has proven itself yet.
    sync.watch('t', file, parseSessionTurns)
    state.inTurn = true
    await ticks(STALE_TICKS * 3)
    expect(stale).toEqual([])
    sync.dispose()
  })

  it('a rebind inside onStale installs a fresh entry that is not clobbered', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-stale-rebind-'))
    const fileA = path.join(dir, 'a.jsonl')
    const fileB = path.join(dir, 'b.jsonl')
    writeFileSync(fileA, TURN_1.join('\n') + '\n', 'utf8')
    writeFileSync(fileB, TURN_2.join('\n') + '\n', 'utf8')
    const tracker = new TurnTracker(async () => null, null)
    const stale: string[] = []
    const sync: SessionTurnSync = new SessionTurnSync(tracker, POLL_MS, {
      isInTurn: () => true,
      onStale: (terminalId) => {
        stale.push(terminalId)
        sync.watch(terminalId, fileB, parseSessionTurns)
      }
    })
    sync.watch('t', fileA, parseSessionTurns)
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn one'])
    await ticks(STALE_TICKS)
    expect(stale).toEqual(['t'])
    // The rebound watch survived the handler: history now mirrors file B…
    expect(tracker.history('t').map((r) => r.prompt)).toEqual(['turn two'])
    // …and its fresh stale clock starts over (no immediate re-fire).
    await ticks(STALE_TICKS - 2)
    expect(stale).toEqual(['t'])
    await ticks(3)
    expect(stale).toEqual(['t', 't'])
    sync.dispose()
  })
})
