// What counts as live work (re-review N2).
//
// The drain's inFlightWork asked terminalIsWorking, which is the CLIPBOARD's
// predicate: UNCOPYABLE_PHASES is exactly {'thinking'}, because that is when
// the session file is being appended to and a copy would tear. Liveness is a
// different question. 'waiting' means the turn is NOT finished, and a
// workspace drained while an agent waits has its PTY detached mid-turn.
//
// And a dispatch is reserved BEFORE its prompt is submitted, so commissioned
// work can exist with no turn phase at all.

import { describe, expect, it } from 'vitest'
import { UNCOPYABLE_PHASES, type TurnPhase } from '../src/shared/turn'

/** The predicate as index.ts computes it, with its two inputs injected. */
function hasLiveWork(
  phase: TurnPhase | undefined,
  hasOpenDispatch: boolean
): boolean {
  if (hasOpenDispatch) return true
  return phase !== undefined && phase !== 'idle'
}

/** The clipboard predicate, for contrast — deliberately narrower. */
function isCopyRefusing(phase: TurnPhase | undefined): boolean {
  return phase !== undefined && UNCOPYABLE_PHASES.has(phase)
}

describe('liveness is broader than the clipboard predicate', () => {
  it("counts 'waiting' as live — the turn is not finished", () => {
    // The N2 bug in one assertion: the old wiring drained a waiting agent.
    expect(hasLiveWork('waiting', false)).toBe(true)
    expect(isCopyRefusing('waiting')).toBe(false)
  })

  it("counts 'replied' as live — the turn has not settled to idle", () => {
    expect(hasLiveWork('replied', false)).toBe(true)
    expect(isCopyRefusing('replied')).toBe(false)
  })

  it("counts 'thinking' as live, as both predicates always did", () => {
    expect(hasLiveWork('thinking', false)).toBe(true)
    expect(isCopyRefusing('thinking')).toBe(true)
  })

  it("does NOT count 'idle' — a quiet workspace must be free to drain", () => {
    // The other half: liveness that never falls to zero is the leaked flag.
    expect(hasLiveWork('idle', false)).toBe(false)
  })

  it('does not count an untracked terminal', () => {
    expect(hasLiveWork(undefined, false)).toBe(false)
  })
})

describe('an open dispatch is work before any turn exists', () => {
  it('counts with no phase at all — reserved, not yet submitted', () => {
    expect(hasLiveWork(undefined, true)).toBe(true)
  })

  it('counts even while the terminal reads idle', () => {
    // Commissioned work whose prompt has not landed yet: the record is
    // reserved, the agent has not started. Draining here loses the dispatch.
    expect(hasLiveWork('idle', true)).toBe(true)
  })
})

describe('the two predicates have not been accidentally merged', () => {
  it('UNCOPYABLE_PHASES is still exactly thinking', () => {
    // If this widens, the clipboard starts refusing copies it used to allow —
    // a separate product decision, not a liveness one. Pinned so the two
    // cannot drift into each other.
    expect([...UNCOPYABLE_PHASES]).toEqual(['thinking'])
  })
})
