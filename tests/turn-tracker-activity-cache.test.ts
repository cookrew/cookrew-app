// Task #14 — activityOf caches the half that walks the whole pane buffer.
//
// Profiled on the running app at one session, 15 tracked terminals:
//   /api/workspace  git-enriched, no turns.list()   12ms
//   /api/activity   turns.list(), no git           274ms back-to-back, 2782ms spaced 4.5s
//   /api/state      both                           343ms back-to-back, 4704ms spaced 4.5s
// Git enrichment was the suspect and is not the cost — /api/workspace runs the
// identical enrichment and answers in 12ms. The cost is activityOf running per
// tracked terminal, and inside it `fullText()`, which walks the entire xterm
// buffer: 7.3ms per full 5000-line pane, sometimes twice per call.
//
// So the derived half is cached against an output revision. These tests hold
// BOTH halves of that bargain: it must actually stop re-walking, and it must
// never serve a stale tail once output arrives.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

/** Counts the expensive calls, which is the whole point of the exercise. */
class CountingSession extends EventEmitter {
  terminalId = 'term-1'
  full = 'boot\n'
  fullTextCalls = 0
  viewportCalls = 0
  idle = 0

  fullText(): string {
    this.fullTextCalls += 1
    return this.full
  }
  viewportText(): string {
    this.viewportCalls += 1
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
  /** Output arrives the way the real PTY delivers it. */
  emitOutput(chunk: string): void {
    this.full += chunk
    this.emit('data', chunk)
  }
}

function fixture(): { tracker: TurnTracker; session: CountingSession } {
  const tracker = new TurnTracker(async () => null, null)
  const session = new CountingSession()
  tracker.track(session as unknown as PtySession, true)
  return { tracker, session }
}

/** Cost of one list() in expensive calls, from a clean counter. */
function costOfList(tracker: TurnTracker, session: CountingSession): number {
  session.fullTextCalls = 0
  session.viewportCalls = 0
  tracker.list()
  return session.fullTextCalls + session.viewportCalls
}

describe('activityOf caches the buffer walk', () => {
  it('walks the buffer once, then not again while nothing arrives', () => {
    const { tracker, session } = fixture()
    const first = costOfList(tracker, session)
    expect(first).toBeGreaterThan(0)

    // Five more reads with no output in between — the shape of a client
    // polling a quiet agent, and of /api/state and /api/activity both being
    // fetched for the same render.
    for (let i = 0; i < 5; i++) expect(costOfList(tracker, session)).toBe(0)
  })

  it('serves the same values from the cache, not merely fewer calls', () => {
    const { tracker, session } = fixture()
    const before = tracker.list()[0]
    const after = tracker.list()[0]
    expect(after.lines).toEqual(before.lines)
    expect(after.glance).toEqual(before.glance)
    expect(after.tailLines).toEqual(before.tailLines)
  })

  it('re-walks the moment output arrives — a cached tail must never go stale', () => {
    const { tracker, session } = fixture()
    tracker.list()
    expect(costOfList(tracker, session)).toBe(0)

    session.emitOutput('a new line of agent output\n')
    expect(costOfList(tracker, session)).toBeGreaterThan(0)
  })

  it('shows the new output, not the cached tail', () => {
    const { tracker, session } = fixture()
    tracker.list()
    session.emitOutput('SENTINEL-fresh-output\n')
    const activity = tracker.list()[0]
    expect(activity.lines.join('\n')).toContain('SENTINEL-fresh-output')
  })

  it('keeps the cheap fields live even while the derived half is cached', () => {
    // The cache deliberately covers ONLY the fields that cost a buffer walk.
    // Phase, prompt and pending input are recomputed every call, so a missed
    // invalidation cannot strand the UI on a stale phase.
    const { tracker, session } = fixture()
    tracker.list()
    session.emit('input', 'typing a prompt')
    const activity = tracker.list()[0]
    expect(activity.pendingInput).toBe('typing a prompt')
  })

  it('re-derives when the prompt changes, with no new output', () => {
    // `lines` filters the prompt echo out of the delta, so the derived values
    // depend on t.prompt as well as on output. Atlas's MED: the first key had
    // only (rev, phase), so a prompt change served a tail still carrying the
    // old echo.
    const { tracker, session } = fixture()
    tracker.list()
    expect(costOfList(tracker, session)).toBe(0)

    // Set on the dispatch-attribution path (turn-tracker:1135), which needs a
    // live in-flight turn to drive. The claim under test is the cache KEY, not
    // how prompt gets there, so the field is set directly.
    const tracked = (tracker as unknown as { tracked: Map<string, { prompt: string }> }).tracked
    tracked.get('term-1')!.prompt = 'a different prompt'
    expect(costOfList(tracker, session)).toBeGreaterThan(0)
  })

  it('does not leak one terminal cache into another', () => {
    const tracker = new TurnTracker(async () => null, null)
    const a = new CountingSession()
    const b = new CountingSession()
    b.terminalId = 'term-2'
    b.full = 'different pane\n'
    tracker.track(a as unknown as PtySession, true)
    tracker.track(b as unknown as PtySession, true)

    tracker.list()
    a.emitOutput('only A moved\n')
    a.fullTextCalls = 0
    a.viewportCalls = 0
    b.fullTextCalls = 0
    b.viewportCalls = 0
    tracker.list()
    expect(a.fullTextCalls + a.viewportCalls).toBeGreaterThan(0)
    expect(b.fullTextCalls + b.viewportCalls).toBe(0)
  })
})
