// v5 axiom A2: the transcript is the ground truth. A dispatch delivered to an
// agent in a background workspace has no PTY, so no scrape can close it — the
// session-file observer must. The reconcile that lands the dispatched turn's
// record makes the history current, and the FIRST QUIET POLL after it (the
// settle confirmation — a still-streaming turn keeps growing the file)
// completes the dispatch through the same armedAt-guarded stamp the scrape
// path uses. Without this, a background dispatch only ever closes by the
// ten-minute sweep, which is a timeout pretending to be an answer.

import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync } from '../src/main/session-sync'
import { parseSessionTurns } from '../src/shared/session-turns'
import { TurnTracker, type CompletedTurn } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

function user(content: string, atMs: number): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: new Date(atMs).toISOString(),
    sessionId: 'src'
  })
}

function assistant(textContent: string, atMs: number): string {
  // Real closing-entry shape: Claude stamps stop_reason "end_turn" on the
  // assistant entry that ends the exchange (mid-turn entries carry
  // "tool_use"). Fixtures carry it so these turns parse as final — the
  // evidence a billing-grade dispatch closure requires.
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: textContent }], stop_reason: 'end_turn' },
    timestamp: new Date(atMs).toISOString(),
    sessionId: 'src'
  })
}

function turnLines(prompt: string, reply: string, atMs: number): string {
  return [user(prompt, atMs), assistant(reply, atMs + 5_000)].join('\n') + '\n'
}

const POLL_MS = 50

class FakeSession extends EventEmitter {
  terminalId = 't'
  full = ''
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return 0
  }
}

function fixture(): {
  file: string
  tracker: TurnTracker
  sync: SessionTurnSync
  turns: CompletedTurn[]
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-file-corr-'))
  const file = path.join(dir, 'abc.jsonl')
  const tracker = new TurnTracker(async () => null, null)
  const turns: CompletedTurn[] = []
  tracker.on('turn', (turn: CompletedTurn) => turns.push(turn))
  const sync = new SessionTurnSync(tracker, POLL_MS, {
    onQuiet: (terminalId) => tracker.completeFromHistory(terminalId)
  })
  return { file, tracker, sync, turns }
}

async function ticks(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS * n)
}

describe('dispatch completion from the session file (no PTY)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes an armed dispatch on the first quiet poll after the turn lands', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, turns } = fixture()
    writeFileSync(file, turnLines('old turn', 'old reply', Date.now() - 60_000), 'utf8')
    sync.watch('t', file, parseSessionTurns)
    expect(tracker.noteDispatch('t', 'd1', 'do the task')).toBe(true)
    await ticks(1)
    // The dispatched turn lands AFTER arming.
    appendFileSync(file, turnLines('do the task', 'task done', Date.now()), 'utf8')
    // Growth poll: history updates, but the file only just moved — no close.
    await ticks(1)
    expect(turns).toHaveLength(0)
    // Quiet poll: settle confirmed, the stamp is consumed.
    await ticks(1)
    expect(turns).toHaveLength(1)
    expect(turns[0].dispatchId).toBe('d1')
    expect(turns[0].terminalId).toBe('t')
    // Consumed means consumed: further quiet polls do not re-fire.
    await ticks(3)
    expect(turns).toHaveLength(1)
    sync.dispose()
  })

  it('never lets a pre-dispatch turn consume the stamp (armedAt guard)', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, turns } = fixture()
    // The whole history predates the dispatch — someone else's exchanges.
    writeFileSync(file, turnLines('old turn', 'old reply', Date.now() - 60_000), 'utf8')
    sync.watch('t', file, parseSessionTurns)
    tracker.noteDispatch('t', 'd1', 'do the task')
    await ticks(6)
    expect(turns).toHaveLength(0)
    sync.dispose()
  })

  it('a live PTY does not create a second closer — the file path closes exactly once', async () => {
    // One authority, one closer: for a FILE-BACKED terminal the durable
    // history is the witness, so completeFromHistory owns the stamp even
    // while a live PTY exists (the scrape only reports latency).
    vi.useFakeTimers()
    const { file, tracker, sync, turns } = fixture()
    writeFileSync(file, turnLines('old turn', 'old reply', Date.now() - 60_000), 'utf8')
    sync.watch('t', file, parseSessionTurns)
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('t', 'd1', 'do the task')
    await ticks(1)
    appendFileSync(file, turnLines('do the task', 'task done', Date.now()), 'utf8')
    await ticks(4)
    expect(turns).toHaveLength(1)
    expect(turns[0].dispatchId).toBe('d1')
    // The PTY detaching later changes nothing — the stamp is consumed.
    tracker.untrack('t')
    await ticks(2)
    expect(turns).toHaveLength(1)
    sync.dispose()
  })

  it('requires an actual reply — a prompt-only tail cannot close a dispatch', async () => {
    vi.useFakeTimers()
    const { file, tracker, sync, turns } = fixture()
    writeFileSync(file, turnLines('old turn', 'old reply', Date.now() - 60_000), 'utf8')
    sync.watch('t', file, parseSessionTurns)
    tracker.noteDispatch('t', 'd1', 'do the task')
    await ticks(1)
    // The user record landed but the assistant has produced nothing yet.
    appendFileSync(file, user('do the task', Date.now()) + '\n', 'utf8')
    await ticks(4)
    expect(turns).toHaveLength(0)
    // The reply arrives; the next quiet poll closes it.
    appendFileSync(file, assistant('task done', Date.now()) + '\n', 'utf8')
    await ticks(2)
    expect(turns).toHaveLength(1)
    sync.dispose()
  })
})
