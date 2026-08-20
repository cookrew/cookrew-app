// What counts as live work.
//
// This predicate has been wrong twice, in OPPOSITE directions, and the test
// that should have caught the second time hand-copied the logic instead of
// importing it — so it would have passed even if the wiring reverted. That is
// the H1 shape one level down. It imports the real function now.
//
//   too narrow  — asked the CLIPBOARD's predicate (UNCOPYABLE_PHASES, exactly
//                 {'thinking'}), so a workspace could drain out from under a
//                 'waiting' agent, detaching its PTY mid-turn.
//   too broad   — `phase !== 'idle'` swept in 'replied', which means TURN
//                 COMPLETE BUT UNREAD and leaves that state only when someone
//                 VIEWS it (turn-tracker seen(): "never a TTL"). Viewing takes
//                 focus; a background session never has focus. Residency held
//                 forever — the leaked-flag failure mode, via a predicate.

import { describe, expect, it } from 'vitest'
import {
  LIVE_WORK_PHASES,
  terminalHasLiveWork,
  type LivenessFacts
} from '../src/main/session-liveness'
import { UNCOPYABLE_PHASES, type TurnPhase } from '../src/shared/turn'

const facts = (phase: TurnPhase | undefined, hasOpenDispatch = false): LivenessFacts => ({
  phase,
  hasOpenDispatch
})

describe('work the agent is part-way through', () => {
  it("counts 'thinking' — the session file is being appended to", () => {
    expect(terminalHasLiveWork(facts('thinking'))).toBe(true)
  })

  it("counts 'waiting' — the turn is not finished", () => {
    // The too-narrow bug: draining here detaches a PTY mid-turn.
    expect(terminalHasLiveWork(facts('waiting'))).toBe(true)
  })
})

describe("'replied' must NOT hold a session (the mirror assertion)", () => {
  it("does not count 'replied' — a finished-but-unread turn drains", () => {
    // The too-broad bug. 'replied' leaves only via seen(), which needs a view,
    // which needs focus, which a background session never gets. Counting it
    // meant residency that never falls to zero.
    expect(terminalHasLiveWork(facts('replied'))).toBe(false)
  })

  it('a session whose every terminal is replied is entirely drainable', () => {
    // The property that matters at the workspace level: an agent that finished
    // while nobody watched must not pin the workspace forever. Nothing is
    // lost by draining — the read marker is persisted and tmux is detached,
    // not killed, so the result is still there on return.
    const session = [facts('replied'), facts('replied'), facts('idle')]
    expect(session.some(terminalHasLiveWork)).toBe(false)
  })

  it('but a replied terminal beside a working one keeps the session live', () => {
    const session = [facts('replied'), facts('thinking')]
    expect(session.some(terminalHasLiveWork)).toBe(true)
  })
})

describe('quiet is quiet — liveness must reach zero', () => {
  it("does not count 'idle'", () => {
    expect(terminalHasLiveWork(facts('idle'))).toBe(false)
  })

  it('does not count an untracked terminal', () => {
    expect(terminalHasLiveWork(facts(undefined))).toBe(false)
  })
})

describe('an open dispatch is work before any turn exists', () => {
  it('counts with no phase at all — reserved, not yet submitted', () => {
    expect(terminalHasLiveWork(facts(undefined, true))).toBe(true)
  })

  it('counts while the terminal reads idle', () => {
    expect(terminalHasLiveWork(facts('idle', true))).toBe(true)
  })

  it('counts while the terminal reads replied — the dispatch outlives the turn', () => {
    expect(terminalHasLiveWork(facts('replied', true))).toBe(true)
  })
})

describe('liveness and the clipboard predicate stay separate', () => {
  it('UNCOPYABLE_PHASES is still exactly thinking', () => {
    // Widening it would change what the clipboard REFUSES — a product
    // decision with a different owner. Pinned so the two cannot merge by
    // accident, which is how the too-narrow bug happened.
    expect([...UNCOPYABLE_PHASES]).toEqual(['thinking'])
  })

  it('liveness is strictly broader than uncopyable, and not equal to it', () => {
    expect([...LIVE_WORK_PHASES].sort()).toEqual(['thinking', 'waiting'])
    for (const phase of UNCOPYABLE_PHASES) expect(LIVE_WORK_PHASES.has(phase)).toBe(true)
    expect(LIVE_WORK_PHASES.size).toBeGreaterThan(UNCOPYABLE_PHASES.size)
  })

  it('neither predicate covers every non-idle phase', () => {
    // The explicit statement of the too-broad fix: 'replied' is non-idle and
    // is deliberately in neither set.
    expect(LIVE_WORK_PHASES.has('replied')).toBe(false)
    expect(UNCOPYABLE_PHASES.has('replied')).toBe(false)
  })
})
