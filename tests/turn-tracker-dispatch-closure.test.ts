// Closure ownership + prompt identity (Sol P0s 1 and 2).
//
// Two findings, one root: "startedAt >= armedAt" made timestamp order stand in
// for causation, and the scrape could consume a file-backed terminal's stamp
// at screen-settled time while index.ts then billed a history tail the
// reconcile had not written yet. The fixes split closure by AUTHORITY — the
// file observer is the one closer for a file-backed terminal, the scrape for
// scrape-only ones — and both closers now demand prompt identity under the
// SAME normalized-prefix rule the engine's landing check uses, plus (on the
// file path) the parser's positive `final` marker: finality, not quiet, is
// the evidence.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker, type CompletedTurn } from '../src/main/turn-tracker'
import { promptAnswersDispatch } from '../src/main/dispatch'
import type { TurnRecord } from '../src/shared/turn'
import type { PtySession } from '../src/main/pty'

class FakeSession extends EventEmitter {
  terminalId = 'term-1'
  full = ''
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

function fixture(): { tracker: TurnTracker; session: FakeSession; seen: CompletedTurn[] } {
  const tracker = new TurnTracker(async () => null, null)
  const session = new FakeSession()
  const seen: CompletedTurn[] = []
  tracker.on('turn', (turn: CompletedTurn) => seen.push(turn))
  return { tracker, session, seen }
}

/** Drive one tracked prompt→reply exchange to completion (fake timers). */
async function runTurn(session: FakeSession, prompt: string): Promise<void> {
  session.idle = 0
  session.emit('input', `${prompt}\r`)
  session.full = '⏺ done'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
}

function record(over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index: 1,
    prompt: 'do the task',
    reply: 'task done',
    startedAt: Date.now(),
    endedAt: Date.now() + 1,
    ...over
  }
}

describe('scrape closure demands prompt identity, not just timestamp order', () => {
  afterEach(() => vi.useRealTimers())

  it('a human turn racing in after armedAt cannot consume the stamp', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'run the F2 simulation')

    // Starts AFTER arming — eligible by timestamp, but it is somebody else's
    // exchange, and the old timestamp-only rule closed the dispatch with it.
    await runTurn(session, 'an unrelated human ask')
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)

    // The dispatched prompt's own turn is the one that closes it.
    await runTurn(session, 'run the F2 simulation')
    expect(seen).toHaveLength(2)
    expect(seen[1].dispatchId).toBe('dsp-1')
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('identity survives the TUI rewrapping the echo (normalized prefix, one rule)', () => {
    // The tracker reuses the engine's promptAnswersDispatch — pin the shared
    // rule here so the two paths cannot normalize differently ever again.
    expect(promptAnswersDispatch('Run   THE f2\n simulation now', 'run the F2 simulation now')).toBe(
      true
    )
    expect(promptAnswersDispatch('run the F3 simulation now', 'run the F2 simulation now')).toBe(
      false
    )
    // An empty dispatched prompt matches nothing — no identity, no closure.
    expect(promptAnswersDispatch('anything', '')).toBe(false)
  })
})

describe('closure ownership: one closer per authority', () => {
  afterEach(() => vi.useRealTimers())

  it('the scrape reports latency for a file-backed terminal but never its dispatch', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')

    await runTurn(session, 'do the task')
    // The turn event still fires — latency samples must not go dark — but
    // the stamp is NOT consumed at screen-settled time: the durable row the
    // closure must bill against may not exist yet.
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)

    // The reconcile lands the final row; the file observer closes.
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(2)
    expect(seen[1].dispatchId).toBe('dsp-1')
    tracker.disposeAll()
  })

  it('file authority closes even while a live PTY is tracked', () => {
    // The old rule stood the file path down whenever a PTY existed; now the
    // AUTHORITY decides, not the attachment — a focused file-backed agent's
    // dispatch closes from its durable row like a background one.
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    expect(tracker.isTracked('term-1')).toBe(true)
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBe('dsp-1')
    tracker.disposeAll()
  })

  it('completeFromHistory refuses without file authority', () => {
    const { tracker, seen } = fixture()
    // Scrape terminal (default source): its own path owns closure, and there
    // is no durable row here to bill against.
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })
})

describe('finality: the parser marker, not quiet, is the evidence', () => {
  it('an assistant-text-before-tool-call tail (final absent) cannot close a dispatch', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    // A reply exists and the file went quiet — but without `final` the reply
    // may be an intermediate text block with a tool call still to come.
    tracker.replaceHistory('term-1', [record()])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0)

    // The end-of-turn evidence lands; the same poll pattern now closes.
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBe('dsp-1')
    tracker.disposeAll()
  })

  it('a final tail with the WRONG prompt cannot close a dispatch', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [
      record({ prompt: 'a different exchange entirely', final: true })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('a final tail that predates the arming cannot close a dispatch', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt: Date.now() - 60_000, endedAt: Date.now() - 55_000 })
    ])
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0)
    tracker.disposeAll()
  })
})

describe('the armed-stamp and tracking probes', () => {
  it('hasArmedDispatch follows the stamp lifecycle', () => {
    const { tracker } = fixture()
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    tracker.noteDispatch('term-1', 'dsp-1', 'work')
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.clearDispatch('term-1', 'dsp-1')
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('isTracked reflects the live PTY attachment', () => {
    const { tracker, session } = fixture()
    expect(tracker.isTracked('term-1')).toBe(false)
    tracker.track(session as unknown as PtySession, true)
    expect(tracker.isTracked('term-1')).toBe(true)
    tracker.untrack('term-1')
    expect(tracker.isTracked('term-1')).toBe(false)
    tracker.disposeAll()
  })
})
