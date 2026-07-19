import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

/** Minimal PtySession stand-in: emits input/data, serves controllable text. */
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

function makeTracker(): { tracker: TurnTracker; session: FakeSession } {
  const tracker = new TurnTracker(async () => null, null)
  const session = new FakeSession()
  tracker.track(session as unknown as PtySession, true)
  return { tracker, session }
}

function phaseOf(tracker: TurnTracker): string {
  return tracker.list()[0].phase
}

/** Drive a tracked turn to 'replied' via the quiescence poll (fake timers). */
async function completeTurn(tracker: TurnTracker, session: FakeSession): Promise<void> {
  session.emit('input', 'fix it\r')
  expect(phaseOf(tracker)).toBe('thinking')
  session.full = '⏺ done, all tests pass'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
  expect(phaseOf(tracker)).toBe('replied')
}

describe('TurnTracker paste handling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not start a turn on carriage returns inside a bracketed paste', () => {
    const { tracker, session } = makeTracker()
    session.emit('input', '\x1b[200~step one\rstep two\x1b[201~')
    expect(phaseOf(tracker)).toBe('idle')
    tracker.disposeAll()
  })

  it('starts the turn on the real Enter after a multi-chunk paste', () => {
    const { tracker, session } = makeTracker()
    session.emit('input', '\x1b[200~')
    session.emit('input', 'do the thing\r')
    session.emit('input', '\x1b[201~')
    expect(phaseOf(tracker)).toBe('idle')
    session.emit('input', '\r')
    const activity = tracker.list()[0]
    expect(activity.phase).toBe('thinking')
    expect(activity.prompt).toBe('do the thing')
    tracker.disposeAll()
  })
})

describe('TurnTracker self-healing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-enters thinking when agent output arrives after a dangling Enter', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    // Desync: Enter lands on an empty buffer (the phantom-turn scenario) —
    // no turn starts, but the agent then keeps streaming work output.
    session.emit('input', '\r')
    expect(phaseOf(tracker)).toBe('replied')
    session.emit('data', '⏺ Read(src/app.ts)')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.disposeAll()
  })

  it('re-enters thinking on agent output while input is still buffered', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    session.emit('input', '\x1b[200~queued follow-up\x1b[201~')
    session.emit('data', '⏺ Bash(npm test)')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.disposeAll()
  })

  it('stays replied on trailing output when no input is pending', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    session.emit('data', '✻ Baked for 1m 6s')
    expect(phaseOf(tracker)).toBe('replied')
    tracker.disposeAll()
  })

  it('stays replied on non-agent output even with pending input', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    session.emit('input', '\r')
    session.emit('data', 'plain shell noise')
    expect(phaseOf(tracker)).toBe('replied')
    tracker.disposeAll()
  })

  // BUG 2 (Fresco): after a tmux reattach mid-turn, a fresh tracker never saw
  // the prompt — the live "esc to interrupt" spinner alone must re-enter
  // 'thinking' so the working agent cannot stay stuck on an idle card.
  it('enters thinking on a live spinner with no input history (reattach)', () => {
    const { tracker, session } = makeTracker()
    expect(phaseOf(tracker)).toBe('idle')
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.disposeAll()
  })

  it('stays idle on a transcript redraw without a live spinner', () => {
    const { tracker, session } = makeTracker()
    session.emit('data', '⏺ I finished the refactor earlier.\n✳ Baked for 1m 6s')
    expect(phaseOf(tracker)).toBe('idle')
    tracker.disposeAll()
  })
})
