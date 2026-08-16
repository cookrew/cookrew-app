// Closure ownership + prompt identity (Sol P0s 1 and 2).
//
// Two findings, one root: "startedAt >= armedAt" made timestamp order stand in
// for causation, and the scrape could consume a file-backed terminal's stamp
// at screen-settled time while index.ts then billed a history tail the
// reconcile had not written yet. The fixes split closure by AUTHORITY — the
// file observer is the one closer for a file-backed terminal, the scrape for
// scrape-only ones — and both closers demand FULL normalized-prompt identity
// (r2: the 24-char prefix survives only in promptLanded, where truncation is
// the screen's), plus (on the file path) the parser's positive `final`
// marker: finality, not quiet, is the evidence. The file closer also scans
// the whole armed window, not just the tail (r2: tail overtake), and the
// scrape appends its record BEFORE emitting so the listener-visible tail is
// the completed turn (r2).

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

  it('identity survives the TUI rewrapping the echo (full normalization, one rule)', () => {
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

  it('a shared 24-char prefix is NOT identity — the FULL prompt decides (Sol r2 P0)', () => {
    // Both briefs normalize to the same first 24 characters ("deploy the
    // release after"). The old prefix rule called them the same work; a
    // billing-grade ownership proof cannot.
    expect(
      promptAnswersDispatch('Deploy the release after lunch', 'Deploy the release after tests')
    ).toBe(false)
    // Full identity still tolerates the rewrap: whitespace and case collapse.
    expect(
      promptAnswersDispatch('deploy   THE release\n after tests', 'Deploy the release after tests')
    ).toBe(true)
  })

  it('the file closer refuses a same-prefix different-suffix record', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'Deploy the release after tests')
    tracker.replaceHistory('term-1', [
      record({ prompt: 'Deploy the release after lunch', final: true })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })
})

describe('tail overtake: the file closer scans the armed window, not just the tail', () => {
  it('closes on a finalized record buried behind a newer user tail (same batch)', () => {
    // The race Sol r2 named: the dispatched turn's finality and the human's
    // next prompt land in ONE reconcile batch. The tail is the new, open
    // exchange; the dispatch's answer sits one row back, final.
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [
      record({ index: 1, final: true }),
      record({
        index: 2,
        prompt: 'a follow-up human ask',
        reply: '',
        startedAt: Date.now() + 10,
        endedAt: Date.now() + 10
      })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dispatchId: 'dsp-1', turnIndex: 1 })
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('stops scanning at the armed bound — old finalized records stay foreign', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    // An old exchange with the SAME text as the dispatch, final, well before
    // arming; then the dispatch arms and only a foreign tail arrives.
    tracker.replaceHistory('term-1', [
      record({ index: 1, final: true, startedAt: Date.now() - 60_000, endedAt: Date.now() - 55_000 })
    ])
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [
      record({ index: 1, final: true, startedAt: Date.now() - 60_000, endedAt: Date.now() - 55_000 }),
      record({ index: 2, prompt: 'unrelated', reply: 'other', final: true })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(0)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
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

// ---------------------------------------------------------------------------
// Sol r2 P0 — the listener-visible tail IS the completed turn: the scrape
// appends (and dedupes) its record BEFORE the 'turn' event fires.
// ---------------------------------------------------------------------------

describe('scrape closure: append before emit', () => {
  afterEach(() => vi.useRealTimers())

  /** What a synchronous listener (index.ts) sees at the instant of the event. */
  function tailProbe(tracker: TurnTracker): Array<{
    tailPrompt?: string
    tailIndex?: number
    turnIndex?: number
    dispatchId?: string
  }> {
    const seenTails: Array<{
      tailPrompt?: string
      tailIndex?: number
      turnIndex?: number
      dispatchId?: string
    }> = []
    tracker.on('turn', (turn: CompletedTurn) => {
      const history = tracker.history(turn.terminalId)
      const tail = history[history.length - 1]
      seenTails.push({
        tailPrompt: tail?.prompt,
        tailIndex: tail?.index,
        turnIndex: turn.turnIndex,
        dispatchId: turn.dispatchId
      })
    })
    return seenTails
  }

  it('first turn: the record exists when the event fires (no stale empty history)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    const tails = tailProbe(tracker)
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    await runTurn(session, 'do the task')
    expect(tails).toEqual([
      { tailPrompt: 'do the task', tailIndex: 1, turnIndex: 1, dispatchId: 'dsp-1' }
    ])
    tracker.disposeAll()
  })

  it('prior history: the tail is the NEW exchange, never the previous one', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    const tails = tailProbe(tracker)
    tracker.track(session as unknown as PtySession, true)
    await runTurn(session, 'an earlier human ask')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    await runTurn(session, 'do the task')
    expect(tails).toHaveLength(2)
    expect(tails[1]).toEqual({
      tailPrompt: 'do the task',
      tailIndex: 2,
      turnIndex: 2,
      dispatchId: 'dsp-1'
    })
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r2 P1 — one public completion per exchange: an attached file-backed
// dispatch's latency sample is emitted once (scrape), and the file closure of
// the SAME exchange carries latencyReported so the listener never counts it
// twice.
// ---------------------------------------------------------------------------

describe('duplicate emission: one latency sample per exchange', () => {
  afterEach(() => vi.useRealTimers())

  it('the file closure of a scrape-observed exchange is flagged latencyReported', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    const startedAt = Date.now()
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    await runTurn(session, 'do the task')
    // Emission 1: the scrape's latency observation — unflagged, no dispatch.
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    expect(seen[0].latencyReported).toBeUndefined()

    // The reconcile lands the same exchange's final row; the file closer
    // closes the dispatch but marks the sample as already public.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt, endedAt: startedAt + 3000 })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ dispatchId: 'dsp-1', latencyReported: true, turnIndex: 1 })
    // Exactly one UNFLAGGED (publicly countable) sample for the exchange.
    expect(seen.filter((turn) => turn.latencyReported !== true)).toHaveLength(1)
    tracker.disposeAll()
  })

  it('a background (never scraped) file closure is NOT flagged — its sample is the first', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBe('dsp-1')
    expect(seen[0].latencyReported).toBeUndefined()
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r2 P1 — noteDispatchDelivered: the exact delivered prompt becomes the
// live turn's prompt-of-record, so scrape closure survives a collapsed echo.
// ---------------------------------------------------------------------------

describe('the delivered-prompt fact (native delivery, no PTY input)', () => {
  afterEach(() => vi.useRealTimers())

  const BRIEF = 'run the long brief with every detail intact'
  const SPINNER = '✻ Cerebrating… (esc to interrupt · 3s)'

  it('collapsed echo + delivered fact → scrape closure still correlates', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    // Native delivery confirmed: the fact arrives BEFORE any turn opened.
    tracker.noteDispatchDelivered('term-1', BRIEF)
    // The screen never held the prompt — the TUI collapsed the paste. The
    // only recoverable echo is the placeholder, which matches nothing.
    session.full = `> [Pasted text #1 +40 lines]\n\n${SPINNER}`
    session.emit('data', SPINNER)
    await vi.advanceTimersByTimeAsync(100)
    session.full += '\n⏺ task done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)

    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBe('dsp-1')
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('stamps a turn ALREADY opening when confirmation arrives after self-heal', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    // Output starts before the backend confirms: the turn opens promptless.
    session.full = SPINNER
    session.emit('data', SPINNER)
    await vi.advanceTimersByTimeAsync(50)
    // Confirmation lands mid-turn — the live turn takes the exact text.
    tracker.noteDispatchDelivered('term-1', BRIEF)
    session.full += '\n⏺ task done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)

    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBe('dsp-1')
    tracker.disposeAll()
  })

  it('without the fact, a collapsed echo cannot prove identity (the gap being fixed)', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    session.full = `> [Pasted text #1 +40 lines]\n\n${SPINNER}`
    session.emit('data', SPINNER)
    await vi.advanceTimersByTimeAsync(100)
    session.full += '\n⏺ task done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)

    // The turn completes and reports latency, but the placeholder prompt is
    // not the brief: the stamp is honestly NOT consumed.
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r2 P1 — hasOpenTurnFact (v5 A4): an observed turn survives untrack and
// ends only on observed finality, interruption, or removal.
// ---------------------------------------------------------------------------

describe('hasOpenTurnFact — the observed in-flight-turn fact', () => {
  afterEach(() => vi.useRealTimers())

  it('tracked: follows the live phase', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    session.emit('input', 'do the task\r')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    session.full = '⏺ done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('survives untrack mid-turn — the work does not end because the viewer left', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'do the task\r')
    tracker.untrack('term-1')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('cleared by parser finality: a final tail covering the observation', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'do the task\r')
    const openedAt = Date.now()
    tracker.untrack('term-1')
    // A final tail OLDER than the observation is a previous exchange — the
    // observed turn's record has not landed, so the fact stands.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt: openedAt - 60_000, endedAt: openedAt - 55_000 })
    ])
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    // The observed turn's own final record lands: finality observed, fact ends.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt: openedAt - 60_000, endedAt: openedAt - 55_000 }),
      record({ index: 2, final: true, startedAt: openedAt, endedAt: openedAt + 5000 })
    ])
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('minted by a confirmed delivery on an UNTRACKED terminal, ended by clearDispatch', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.noteDispatchDelivered('term-1', 'do the task')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    // The dispatch is interrupted without a turn: its fact ends with it.
    tracker.clearDispatch('term-1', 'dsp-1')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('clearDispatch spares an older, pre-arming observation — that turn is not the dispatch', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    // A human turn opens and the viewer leaves…
    session.emit('input', 'a long human ask\r')
    tracker.untrack('term-1')
    await vi.advanceTimersByTimeAsync(10_000)
    // …then a dispatch arms later and dies without a turn.
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.clearDispatch('term-1', 'dsp-1')
    // The human turn's observation is still in force.
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('closure from the file clears the fact for the closed exchange', () => {
    const { tracker } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.noteDispatchDelivered('term-1', 'do the task')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })
})
