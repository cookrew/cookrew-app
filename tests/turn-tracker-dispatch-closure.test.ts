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

  it('identity is EXACT delivered bytes — no lossy normalization (Sol r3 P0-2)', () => {
    // The tracker reuses the engine's promptAnswersDispatch — pin the shared
    // rule here so the two paths cannot diverge ever again. Exact bytes: a
    // case- or whitespace-sensitive brief (code, shell, YAML, Make) must
    // never collide with a normalized cousin. Both closers compare DELIVERED
    // text (the durable user record, or the delivered-prompt fact), so the
    // TUI's rewrapped echo never enters the comparison at all.
    expect(promptAnswersDispatch('run the F2 simulation now', 'run the F2 simulation now')).toBe(
      true
    )
    // Rewrapped/case-folded variants are DIFFERENT bytes — not the exchange.
    expect(promptAnswersDispatch('Run   THE f2\n simulation now', 'run the F2 simulation now')).toBe(
      false
    )
    expect(promptAnswersDispatch('run the F3 simulation now', 'run the F2 simulation now')).toBe(
      false
    )
    // The Make-recipe collision the normalized hash allowed: tabs vs spaces.
    expect(promptAnswersDispatch('build:\n    make all', 'build:\n\tmake all')).toBe(false)
    // An empty dispatched prompt matches nothing — no identity, no closure.
    expect(promptAnswersDispatch('anything', '')).toBe(false)
  })

  it('a shared 24-char prefix is NOT identity — the FULL prompt decides (Sol r2 P0)', () => {
    // Both briefs share their first 24 characters ("deploy the release
    // after"). The old prefix rule called them the same work; a billing-grade
    // ownership proof cannot — and since r3, neither can a normalized rewrap.
    expect(
      promptAnswersDispatch('Deploy the release after lunch', 'Deploy the release after tests')
    ).toBe(false)
    expect(
      promptAnswersDispatch('deploy   THE release\n after tests', 'Deploy the release after tests')
    ).toBe(false)
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

describe('owner input preempts an armed dispatch (Sol r3 P0-2c, r4 P0-1)', () => {
  afterEach(() => vi.useRealTimers())

  it('fires onOwnerPreempt once, BEFORE the owner turn opens', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    const preempts: string[] = []
    // The conductor's wiring: interrupt the dispatch (disarming the stamp)
    // and report that the interrupt row durably committed.
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      tracker.clearDispatch(terminalId, 'dsp-1')
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'the dispatched brief')

    await runTurn(session, 'an owner ask')
    expect(preempts).toEqual(['term-1'])
    // Disarmed before the owner's turn opened: never billed to the dispatch.
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    tracker.disposeAll()
  })

  it('an owner submitting the IDENTICAL bytes still preempts — provenance, not text (Sol r4 P0-1b)', async () => {
    // The old exemption keyed on byte equality: any untagged submission of
    // the dispatched text was ASSUMED to be the pty-fallback. A real owner
    // can type the same text after arming, producing two identical turns —
    // only the source tag proves who wrote.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      tracker.clearDispatch(terminalId, 'dsp-1')
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')

    await runTurn(session, 'do the task') // untagged = owner, identical bytes
    expect(preempts).toEqual(['term-1'])
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    tracker.disposeAll()
  })

  it('the pty-fallback delivery does not preempt itself — exempt by SOURCE TAG', async () => {
    // The fallback pastes the dispatch's own prompt through the same PTY
    // input stream every owner keystroke uses, but through writeFromDispatch,
    // which tags the input event with its source. THAT is the exemption —
    // never the bytes.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')

    session.idle = 0
    session.emit('input', 'do the task\r', 'dispatch')
    session.full = '⏺ done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(preempts).toEqual([])
    // Scrape-owned terminal: the closer consumes the stamp with that turn.
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBe('dsp-1')
    tracker.disposeAll()
  })

  it('a mid-thinking DIFFERENT owner prompt preempts — a live turn is not a settled answer (Sol r4 P0-1c)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      tracker.clearDispatch(terminalId, 'dsp-1')
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    // The dispatched turn opens (tagged) and is still THINKING…
    session.emit('input', 'do the task\r', 'dispatch')
    session.full = '⏺ thinking'
    await vi.advanceTimersByTimeAsync(100)
    // …when the owner submits something else. The dispatch turn has not
    // settled: this IS a competing producer and must preempt.
    session.emit('input', 'change of plan, stop\r')
    expect(preempts).toEqual(['term-1'])
    tracker.disposeAll()
  })

  it('fires at most once per dispatch even when the callback does not disarm', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'the dispatched brief')

    await runTurn(session, 'first owner ask')
    await runTurn(session, 'second owner ask')
    expect(preempts).toEqual(['term-1'])
    tracker.disposeAll()
  })

  it('an empty Enter (menu answer) does not preempt — it feeds the current turn', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'the dispatched brief')
    session.emit('input', '\r')
    await vi.advanceTimersByTimeAsync(100)
    expect(preempts).toEqual([])
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('ledger-down preemption refuses the input — fail-closed, and it retries (Sol r4 P0-1d)', async () => {
    // The wired interrupt could not commit its terminal row (returns false):
    // the reservation is still live, so the owner's submission must not open
    // a competing turn. The PTY guard refuses the bytes upstream; this pins
    // the tracker's own belt for the same verdict.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    let committed = false
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      if (committed) tracker.clearDispatch(terminalId, 'dsp-1')
      return committed
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', 'the dispatched brief')

    // The guard (wired onto PtySession.beforeOwnerInput) refuses the write.
    expect(tracker.guardOwnerInput('term-1', 'a competing ask\r')).toBe('preempt-failed')
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    // The unguarded belt: even bytes that already reached the child open no
    // owner turn beside the live reservation.
    await runTurn(session, 'a competing ask')
    expect(seen).toHaveLength(0)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)

    // Not latched: the ledger recovers, the next submission preempts through.
    committed = true
    expect(tracker.guardOwnerInput('term-1', 'a competing ask\r')).toBe('allow')
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    expect(preempts.length).toBeGreaterThanOrEqual(2)
    tracker.disposeAll()
  })

  it('guardOwnerInput is a pure peek — typing and unarmed terminals pass untouched', () => {
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    // No armed dispatch: everything is allowed.
    expect(tracker.guardOwnerInput('term-1', 'hello\r')).toBe('allow')
    tracker.noteDispatch('term-1', 'dsp-1', 'the dispatched brief')
    // Typing without a submit never preempts.
    expect(tracker.guardOwnerInput('term-1', 'partial line, no enter')).toBe('allow')
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('does not preempt a dispatch whose answer is already on screen', async () => {
    // The dispatch's turn ran and settled; the reconcile just has not landed
    // its durable row yet. The owner's next prompt is the NEXT exchange, not
    // a competing producer — interrupting here would overwrite a proven
    // outcome with a weaker one (the P0-3 inversion).
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    const preempts: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempts.push(terminalId)
      return true
    }
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const dispatchStart = Date.now()
    // The dispatch's own delivery (source-tagged) settles on screen; the
    // stamp stays armed until the durable row lands.
    session.idle = 0
    session.emit('input', 'do the task\r', 'dispatch')
    session.full = '⏺ done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)

    await runTurn(session, 'an owner aside')
    expect(preempts).toEqual([])

    // The reconcile lands; the file closer still closes the dispatch done.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt: dispatchStart, endedAt: dispatchStart + 3000 })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen.some((turn) => turn.dispatchId === 'dsp-1')).toBe(true)
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

describe('the armed window is scanned OLDEST-first (Sol r3 P0-2)', () => {
  it('two identical eligible finals: the EARLIER record is the dispatch', () => {
    // The dispatch was delivered first. If an identical human turn somehow
    // lands later in the window, the older record is the dispatch's own
    // delivery — consuming the newer one billed the caller for the human's
    // exchange (the newest-first bug).
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const at = Date.now()
    tracker.replaceHistory('term-1', [
      record({ index: 1, final: true, startedAt: at + 5, endedAt: at + 3000 }),
      record({ index: 2, final: true, startedAt: at + 60_000, endedAt: at + 63_000 })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dispatchId: 'dsp-1', turnIndex: 1 })
    tracker.disposeAll()
  })
})

describe('empty finals and parser outcomes (Sol r3 P1-7, P1-8)', () => {
  it('a tool-only final turn (empty reply) closes the dispatch', () => {
    // Finality + exact identity is the whole proof; an empty assistant
    // message is a valid way for a turn to end. hasReply=false semantics ride
    // through the dispatch record (the listener passes the empty reply and
    // completeTurn refuses to call it an answer).
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true, reply: '' })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dispatchId: 'dsp-1', turnIndex: 1 })
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('threads a native failure outcome onto the completion event', () => {
    // The parser lane will stamp final records with outcome. A record
    // carrying 'failed' closes the dispatch as a failure instead of
    // stranding it for the ten-minute sweep.
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const failed = { ...record({ final: true }), outcome: 'failed' } as TurnRecord
    tracker.replaceHistory('term-1', [failed])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dispatchId: 'dsp-1', outcome: 'failed' })
    tracker.disposeAll()
  })

  it('tolerates the outcome field being absent — absent means done', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0].outcome).toBeUndefined()
    tracker.disposeAll()
  })
})

describe('hasFinalAnswer — the sweep-side finality probe (Sol r3 P0-6, payload per r4 P0-3)', () => {
  it('returns the matching record PAYLOAD — identity and outcome, not a bare yes', () => {
    const { tracker } = fixture()
    const at = Date.now()
    tracker.replaceHistory('term-1', [
      { ...record({ final: true, startedAt: at + 5, uuid: 'uuid-a' }), outcome: 'failed' } as TurnRecord
    ])
    expect(tracker.hasFinalAnswer('term-1', 'do the task', at)).toMatchObject({
      turnIndex: 1,
      uuid: 'uuid-a',
      outcome: 'failed',
      reply: 'task done'
    })
    // Wrong bytes, non-final, or pre-arming records do not answer.
    expect(tracker.hasFinalAnswer('term-1', 'another brief', at)).toBeNull()
    expect(tracker.hasFinalAnswer('term-1', 'do the task', at + 60_000)).toBeNull()
    tracker.disposeAll()
  })

  it('a successful final leaves outcome absent — absent means done', () => {
    const { tracker } = fixture()
    const at = Date.now()
    tracker.replaceHistory('term-1', [record({ final: true, startedAt: at + 5 })])
    const answer = tracker.hasFinalAnswer('term-1', 'do the task', at)
    expect(answer).toMatchObject({ turnIndex: 1 })
    expect(answer?.outcome).toBeUndefined()
    tracker.disposeAll()
  })

  it('is a read-only probe — the stamp and the history are untouched', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    expect(tracker.hasFinalAnswer('term-1', 'do the task', Date.now() - 1000)).not.toBeNull()
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    expect(seen).toHaveLength(0)
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

  it('an interleaved owner turn cannot steal the dispatch exchange identity (Sol r3 P1-12)', async () => {
    // Latency dedupe is keyed by TURN identity, not one slot per terminal:
    // an owner turn between the dispatch turn and its file closure keeps its
    // own outstanding observation, and the closure matches the dispatch's.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const dispatchStart = Date.now()
    await runTurn(session, 'do the task') // scrape sample 1 (dispatch exchange)
    await vi.advanceTimersByTimeAsync(10_000) // outside the identity slack
    await runTurn(session, 'an owner aside') // scrape sample 2 (owner exchange)
    expect(seen).toHaveLength(2)
    expect(seen.every((turn) => turn.latencyReported !== true)).toBe(true)

    // The file closer lands the DISPATCH exchange: it matches identity 1 —
    // not the owner's later observation — and suppresses the duplicate.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt: dispatchStart, endedAt: dispatchStart + 3000 })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(3)
    expect(seen[2]).toMatchObject({ dispatchId: 'dsp-1', latencyReported: true })
    // Exactly one publicly countable sample per exchange: dispatch + owner.
    expect(seen.filter((turn) => turn.latencyReported !== true)).toHaveLength(2)
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

// ---------------------------------------------------------------------------
// Sol r4 P1 — the open-turn fact's lifecycle: detached inTurn includes it, and
// removal/backend death end it through an explicit method.
// ---------------------------------------------------------------------------

describe('openTurnFacts lifecycle (Sol r4 P1)', () => {
  afterEach(() => vi.useRealTimers())

  it('detached inTurn() includes the owned open-turn fact — the no-status rotation gate fires', async () => {
    // A switched-away human turn with an ABSENT status feed used to read as
    // not-in-turn, so the stale-rotation gate could never fire for it while
    // holdOpen (which does consult the fact) pinned its watch forever.
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'a long human ask\r')
    tracker.untrack('term-1')
    // No herdr status, no armed dispatch — only the observed open turn.
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    expect(tracker.inTurn('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('clearOpenTurnFact ends the fact and the waiting delivered prompt (removal path)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = fixture()
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'a long human ask\r')
    tracker.untrack('term-1')
    tracker.clearOpenTurnFact('term-1')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    expect(tracker.inTurn('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('backend death (via the method) clears a delivery-minted fact too', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.noteDispatchDelivered('term-1', 'do the task')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    // The conductor's backend-death fan-out calls this per dead pane.
    tracker.clearOpenTurnFact('term-1')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r4 P1 — latency dedupe by record identity, never a timestamp window.
// ---------------------------------------------------------------------------

describe('latency observations reconcile to record identity (Sol r4 P1)', () => {
  afterEach(() => vi.useRealTimers())

  it('an owner turn observed within 5s of the dispatch turn does not steal the sample', async () => {
    // The five-second heuristic's failure: the dispatch turn's scrape was
    // MISSED (nobody attached), an owner turn was observed moments later,
    // and the file closure consumed the owner's timestamp — marking the
    // dispatch latencyReported when its sample was never public at all.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const dispatchStart = Date.now()
    // Only the OWNER's turn crosses the scrape, 2s after the dispatch armed.
    await vi.advanceTimersByTimeAsync(2000)
    await runTurn(session, 'an owner aside')
    expect(seen).toHaveLength(1)

    // The dispatch's own record lands: its closure matches NO observation —
    // the owner's queued entry has a different prompt, and there is no
    // timestamp window to fall into.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt: dispatchStart + 10, endedAt: dispatchStart + 3000 }),
      record({
        index: 2,
        prompt: 'an owner aside',
        reply: 'sure',
        final: true,
        startedAt: dispatchStart + 2000,
        endedAt: dispatchStart + 5000
      })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(2)
    expect(seen[1].dispatchId).toBe('dsp-1')
    // NOT flagged: this closure is the dispatch exchange's first public
    // completion — the owner's sample stays the owner's.
    expect(seen[1].latencyReported).toBeUndefined()
    tracker.disposeAll()
  })

  it('a scrape-observed dispatch exchange is consumed by uuid after reconcile stamps it', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const startedAt = Date.now()
    await runTurn(session, 'do the task') // scrape sample, queued by prompt
    // A first reconcile lands the (non-final) record: the observation binds
    // to its uuid.
    tracker.replaceHistory('term-1', [
      record({ startedAt, endedAt: startedAt + 3000, uuid: 'uuid-d' })
    ])
    // The finality reconcile closes: consumed by that uuid.
    tracker.replaceHistory('term-1', [
      record({ final: true, startedAt, endedAt: startedAt + 3000, uuid: 'uuid-d' })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ dispatchId: 'dsp-1', latencyReported: true, turnUuid: 'uuid-d' })
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r5 P1 — latency dedupe: retention runs on OBSERVATION time (a turn
// longer than the TTL still dedupes), identity is EXACT prompt bytes (a
// 48-char prefix collision must not suppress a real sample), and identical
// prompts are consumed strictly one observation per closure, in order.
// ---------------------------------------------------------------------------

describe('latency dedupe: observation-time TTL, exact bytes, FIFO (Sol r5 P1)', () => {
  afterEach(() => vi.useRealTimers())

  it('a turn LONGER than the TTL still dedupes its own file closure', async () => {
    // The old queue stored the turn's startedAt as its TTL clock, so any turn
    // outliving SCRAPE_EMIT_TTL_MS was expired the instant it was recorded —
    // and the file closer then billed a second public sample.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const startedAt = Date.now()
    session.idle = 0
    session.emit('input', 'do the task\r')
    // The turn runs 15 minutes — past the 10-minute observation TTL.
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    session.full = '⏺ done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toHaveLength(1) // the scrape emitted the public sample

    tracker.replaceHistory('term-1', [
      record({
        prompt: 'do the task',
        final: true,
        startedAt,
        endedAt: startedAt + 15 * 60_000,
        uuid: 'u-long'
      })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ dispatchId: 'dsp-1', latencyReported: true })
    tracker.disposeAll()
  })

  it('a 48-char prefix collision does not pair — exact bytes or nothing', async () => {
    // Two different prompts sharing a long common prefix: the lossy fallback
    // used to match them, letting a nearby owner turn's observation suppress
    // the dispatch exchange's only public sample.
    vi.useFakeTimers()
    const shared = 'refactor the ingest pipeline exactly as specified in the brief'
    const ownerPrompt = `${shared} but stop before deploying`
    const dispatched = `${shared} and deploy when green`
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', dispatched)
    await runTurn(session, ownerPrompt) // owner's sample queued
    expect(seen).toHaveLength(1)

    tracker.replaceHistory('term-1', [
      record({ prompt: dispatched, final: true, startedAt: Date.now() - 100, endedAt: Date.now(), uuid: 'u-d' })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(2)
    expect(seen[1].dispatchId).toBe('dsp-1')
    // NOT flagged: the owner's prefix-colliding observation is not this
    // exchange, and leaving the closure unsuppressed is the honest outcome.
    expect(seen[1].latencyReported).toBeUndefined()
    tracker.disposeAll()
  })

  it('identical prompts: strictly one observation per closure, consumed in FIFO order', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const t0 = Date.now()
    await runTurn(session, 'do the task') // observation 1
    await runTurn(session, 'do the task') // observation 2
    expect(seen).toHaveLength(2)

    // The reconcile stamps the queued observations against the records IN
    // ORDER: first observation → first record, second → second, never both
    // onto the first.
    tracker.replaceHistory('term-1', [
      record({ index: 1, prompt: 'do the task', final: true, startedAt: t0, endedAt: t0 + 100, uuid: 'u1' }),
      record({ index: 2, prompt: 'do the task', final: true, startedAt: t0 + 3000, endedAt: t0 + 3100, uuid: 'u2' })
    ])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(3)
    // The closure consumed the FIRST observation (the oldest eligible record
    // wins, and its observation is the queue head)…
    expect(seen[2]).toMatchObject({ dispatchId: 'dsp-1', latencyReported: true, turnUuid: 'u1' })
    // …and the second observation still guards the second exchange.
    const queue = (tracker as unknown as { scrapeEmitted: Map<string, { uuid?: string }[]> })
      .scrapeEmitted.get('term-1')
    expect(queue).toHaveLength(1)
    expect(queue?.[0].uuid).toBe('u2')
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r5 P1 — delivery confirmation is scoped to an arming GENERATION: after
// the dispatch settled, a late confirmation must not recreate a stale fact.
// ---------------------------------------------------------------------------

describe('confirmation scoped to a generation (Sol r5 P1)', () => {
  afterEach(() => vi.useRealTimers())

  const BRIEF = 'run the long brief with every detail intact'
  const gen = (dispatchId: string, armedAt: number): { dispatchId: string; armedAt: number } => ({
    dispatchId,
    armedAt
  })

  it('a scoped confirmation for the LIVE armed dispatch still lands the fact', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    tracker.noteDispatchDelivered('term-1', BRIEF, gen('dsp-1', Date.now()))
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('a confirmation returning AFTER settlement is a no-op — no stale fact is minted', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    const armedAt = Date.now()
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    // A fast file closer settles the dispatch while the native submit blocks.
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)
    // The blocking submit finally returns and confirms: its generation is
    // settled, so nothing may be minted — no deliveredPrompt, no open-turn
    // fact with no future turn to resolve it.
    tracker.noteDispatchDelivered('term-1', 'do the task', gen('dsp-1', armedAt))
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    expect(tracker.inTurn('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('the deprecated unscoped confirmation is fail-closed after settlement too', () => {
    const { tracker } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    tracker.noteDispatchDelivered('term-1', 'do the task')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('a late confirmation cannot touch a successor dispatch armed in its place', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const g1 = gen('dsp-1', Date.now())
    tracker.clearDispatch('term-1', 'dsp-1') // interrupted, then retried by another dispatch
    tracker.noteDispatch('term-1', 'dsp-2', 'other work entirely')
    tracker.noteDispatchDelivered('term-1', 'do the task', g1)
    // Nothing minted under dsp-2's stamp, and the stamp itself is untouched.
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('a re-armed retry of the SAME id is a new generation the old confirmation must not touch', async () => {
    vi.useFakeTimers()
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    const stale = gen('dsp-1', Date.now())
    tracker.clearDispatch('term-1', 'dsp-1')
    await vi.advanceTimersByTimeAsync(10_000)
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task') // the retry re-arms
    tracker.noteDispatchDelivered('term-1', 'do the task', stale)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('retraction is scoped: only the generation that minted the fact takes it back', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    const g1 = gen('dsp-1', Date.now())
    tracker.noteDispatchDelivered('term-1', BRIEF, g1)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    // A stranger generation retracting the identical bytes is a no-op…
    tracker.retractDispatchDelivered('term-1', BRIEF, gen('dsp-2', Date.now()))
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    // …the minting generation's retraction lands.
    tracker.retractDispatchDelivered('term-1', BRIEF, g1)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r4 P1 — the answering identity rides the completion event.
// ---------------------------------------------------------------------------

describe('turnUuid rides the file closure', () => {
  it('emits the durable record uuid beside the display index', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true, uuid: 'uuid-7' })])
    tracker.completeFromHistory('term-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dispatchId: 'dsp-1', turnIndex: 1, turnUuid: 'uuid-7' })
    tracker.disposeAll()
  })

  it('tolerates a uuid-less record — turnUuid is simply absent', () => {
    const { tracker, seen } = fixture()
    tracker.setHistorySource('term-1', 'file')
    tracker.noteDispatch('term-1', 'dsp-1', 'do the task')
    tracker.replaceHistory('term-1', [record({ final: true })])
    tracker.completeFromHistory('term-1')
    expect(seen[0].turnUuid).toBeUndefined()
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r4 P1 — attempted-delivery facts: late authoritative bytes replay a
// settled scrape turn once; proven non-delivery retracts the fact.
// ---------------------------------------------------------------------------

describe('attempted-delivery correlation (Sol r4 P1)', () => {
  afterEach(() => vi.useRealTimers())

  const BRIEF = 'run the long brief with every detail intact'
  const SPINNER = '✻ Cerebrating… (esc to interrupt · 3s)'

  it('stalled-timeout landing: bytes arriving AFTER the scrape settled replay closure once', async () => {
    // herdr `agent prompt` blocks until the agent leaves working, so on a
    // stalled/timeout outcome whose prompt actually landed, the authoritative
    // bytes can reach the tracker after the attached scrape already settled
    // the turn with a collapsed placeholder prompt. That settled turn IS the
    // dispatch's exchange — replay its closure instead of stranding the
    // dispatch for the sweep.
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    // The turn runs and settles with only the collapsed echo recoverable.
    session.full = `> [Pasted text #1 +40 lines]\n\n${SPINNER}`
    session.emit('data', SPINNER)
    await vi.advanceTimersByTimeAsync(100)
    session.full += '\n⏺ task done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)

    // The blocking submit finally returns; the delivered fact arrives late.
    tracker.noteDispatchDelivered('term-1', BRIEF)
    expect(seen).toHaveLength(2)
    expect(seen[1].dispatchId).toBe('dsp-1')
    // One public sample per exchange: the settled turn already emitted it.
    expect(seen[1].latencyReported).toBe(true)
    expect(tracker.hasArmedDispatch('term-1')).toBe(false)

    // ONE-shot: a duplicate confirmation replays nothing.
    tracker.noteDispatchDelivered('term-1', BRIEF)
    expect(seen).toHaveLength(2)
    tracker.disposeAll()
  })

  it('a settled turn with a PROVABLE different prompt is not replayed onto the dispatch', async () => {
    vi.useFakeTimers()
    const { tracker, session, seen } = fixture()
    tracker.track(session as unknown as PtySession, true)
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    await runTurn(session, 'a fully visible owner ask')
    expect(seen).toHaveLength(1)

    tracker.noteDispatchDelivered('term-1', BRIEF)
    // The settled turn proves its own (different) identity: no replay — the
    // fact waits for the dispatch's real turn instead.
    expect(seen).toHaveLength(1)
    expect(tracker.hasArmedDispatch('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('proven non-delivery retracts the attempted fact and its minted open-turn fact', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    tracker.noteDispatchDelivered('term-1', BRIEF)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.retractDispatchDelivered('term-1', BRIEF)
    expect(tracker.hasOpenTurnFact('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('retraction matches exact bytes — a different fact is never collateral', () => {
    const { tracker } = fixture()
    tracker.noteDispatch('term-1', 'dsp-1', BRIEF)
    tracker.noteDispatchDelivered('term-1', BRIEF)
    tracker.retractDispatchDelivered('term-1', 'some other prompt')
    expect(tracker.hasOpenTurnFact('term-1')).toBe(true)
    tracker.disposeAll()
  })
})
