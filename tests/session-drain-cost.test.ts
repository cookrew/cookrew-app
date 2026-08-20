// The drain must not walk the fleet to ask a scalar.
//
// Found by walking the LIVE app during the flag-ON window. inFlightWork asked
// hasLiveWork once per terminal, and hasLiveWork called turns.list(), which
// maps activityOf over EVERY tracked terminal and walks each one's whole xterm
// buffer. Per drain tick that is
//
//   workspaces x terminals x (terminals x buffer walk)
//
// every five seconds, synchronously on the Electron main thread. Measured
// effect: an ~11s floor under every HTTP route — including /api/workspaces,
// which does no work at all and should be sub-millisecond.
//
// It is wave C's O(attached x panes) reached through a predicate instead of a
// flag, inside the module written to make that impossible. So the cost is
// pinned here, not just the correctness.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

class CountingSession extends EventEmitter {
  fullTextCalls = 0
  constructor(public terminalId: string) {
    super()
  }
  fullText(): string {
    this.fullTextCalls += 1
    return 'output\n'
  }
  viewportText(): string {
    this.fullTextCalls += 1
    return 'output\n'
  }
  idleFor(): number {
    return 0
  }
}

function fleet(size: number): { tracker: TurnTracker; sessions: CountingSession[] } {
  const tracker = new TurnTracker(async () => null, null)
  const sessions = Array.from({ length: size }, (_, i) => new CountingSession(`term-${i}`))
  for (const s of sessions) tracker.track(s as unknown as PtySession, { agent: true } as never)
  return { tracker, sessions }
}

const walks = (sessions: CountingSession[]): number =>
  sessions.reduce((n, s) => n + s.fullTextCalls, 0)

describe('phaseOf is O(1) and walks nothing', () => {
  it('reading every terminal phase costs ZERO buffer walks', () => {
    const { tracker, sessions } = fleet(15)
    tracker.list() // prime whatever caches exist
    sessions.forEach((s) => (s.fullTextCalls = 0))

    for (const s of sessions) tracker.phaseOf(s.terminalId)

    expect(walks(sessions)).toBe(0)
  })

  it('agrees with what list() reports', () => {
    // Cheap must not mean different. If these ever disagree the drain is
    // making decisions on a phase the rest of the app does not believe.
    const { tracker, sessions } = fleet(4)
    const fromList = new Map(tracker.list().map((a) => [a.terminalId, a.phase]))
    for (const s of sessions) {
      expect(tracker.phaseOf(s.terminalId)).toBe(fromList.get(s.terminalId))
    }
  })

  it('is undefined for a terminal nobody tracks', () => {
    const { tracker } = fleet(2)
    expect(tracker.phaseOf('never-tracked')).toBeUndefined()
  })
})

describe('the shape that was quadratic', () => {
  it('list() DOES walk every buffer — which is why phaseOf exists', () => {
    // Pinned deliberately. If list() ever stops being expensive the reason for
    // phaseOf disappears, and someone should be told rather than left guessing.
    const { tracker, sessions } = fleet(10)
    sessions.forEach((s) => (s.fullTextCalls = 0))
    tracker.list()
    expect(walks(sessions)).toBeGreaterThanOrEqual(10)
  })

  it('a per-terminal liveness sweep stays LINEAR, not quadratic', () => {
    // The drain's actual access pattern: ask once per terminal. Through
    // list() this was N x N buffer walks; through phaseOf it is N lookups and
    // no walks at all.
    const size = 12
    const { tracker, sessions } = fleet(size)
    tracker.list()
    sessions.forEach((s) => (s.fullTextCalls = 0))

    for (const s of sessions) tracker.phaseOf(s.terminalId)

    expect(walks(sessions)).toBe(0)
    expect(walks(sessions)).toBeLessThan(size * size)
  })
})
