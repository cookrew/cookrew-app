import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import { RECOVERED_PROMPT_LABEL } from '../src/shared/turn'
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

  it('re-enters thinking from replied when a current-style live spinner reappears', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    // BUG 4: premature quiescence marked the turn replied; the agent resumes
    // streaming with the modern spinner (no "esc to interrupt" in it).
    session.emit('data', '✶ Honking… (2s · ↓ 0.3k tokens)')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.disposeAll()
  })
})

describe('TurnTracker recovered turns (empty-prompt history bug)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('labels a self-healed turn with real output instead of an empty prompt', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    // Reattach: a live spinner with no input history opens an unlabeled turn.
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)')
    expect(phaseOf(tracker)).toBe('thinking')

    session.full = '⏺ finished the refactor'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('replied')

    const history = tracker.history('term-1')
    expect(history).toHaveLength(1)
    expect(history[0].prompt).toBe(RECOVERED_PROMPT_LABEL)
    expect(history[0].reply).toContain('finished the refactor')
    tracker.disposeAll()
  })

  it('records nothing for a promptless turn that produced no visible reply', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.full = '✻ Cerebrating… (esc to interrupt · 34s)'
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 34s)')
    expect(phaseOf(tracker)).toBe('thinking')

    // The "turn" ends with no output beyond the snapshot — tracker noise.
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('replied')
    expect(tracker.history('term-1')).toHaveLength(0)
    tracker.disposeAll()
  })

  it('still records typed turns whose reply is empty', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.emit('input', 'do the thing\r')
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('replied')

    const history = tracker.history('term-1')
    expect(history).toHaveLength(1)
    expect(history[0].prompt).toBe('do the thing')
    tracker.disposeAll()
  })
})

describe('TurnTracker quiescence vs live spinner (BUG 4)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the turn open through a >2.5s pause while the tail shows a live spinner', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.emit('input', 'do the migration\r')
    expect(phaseOf(tracker)).toBe('thinking')

    // Long tool call: output stalls well past quiescence, but the viewport
    // tail still shows the in-flight spinner.
    session.full = '⏺ Bash(npm run migrate)\n✶ Honking… (23m 20s · ↓ 24.5k tokens)'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(5000)
    expect(phaseOf(tracker)).toBe('thinking')

    // Turn actually finishes: completed status replaces the spinner.
    session.full = '⏺ Migration complete, 12 tables moved.\n✻ Brewed for 4m 15s'
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('replied')
    tracker.disposeAll()
  })

  it('still ends spinner-less turns on plain quiescence (shell-style agents)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.emit('input', 'run the report\r')
    session.full = 'report written to out/report.csv'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('replied')
    tracker.disposeAll()
  })
})

// tmux repaints changed cells with cursor addressing, so a live spinner
// almost never arrives intact inside one data chunk — the self-heal must
// fall back to scanning the rendered screen (stuck-idle Conductor bug).
describe('TurnTracker self-heal under tmux cell repaints', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('heals from idle when the screen shows a live spinner but chunks are partial', () => {
    const { tracker, session } = makeTracker()
    session.full = '⏺ Bash(npm run migrate)\n✻ Marinating… (2m 45s · ↓ 774 tokens)'
    // A tmux cell repaint: cursor move plus the new spinner glyph only.
    session.emit('data', '\x1b[24;3H✽')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.disposeAll()
  })

  it('heals from replied the same way after premature quiescence', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    session.full = '⏺ Bash(long job)\n✶ Honking… (12s · ↓ 1.1k tokens)'
    session.emit('data', '\x1b[24;3H✶')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.disposeAll()
  })

  it('stays idle on partial repaints when the screen shows no live spinner', () => {
    const { tracker, session } = makeTracker()
    session.full = '⏺ done\n✻ Brewed for 4m 15s\n❯ '
    session.emit('data', '\x1b[24;3H❯')
    expect(phaseOf(tracker)).toBe('idle')
    tracker.disposeAll()
  })
})
