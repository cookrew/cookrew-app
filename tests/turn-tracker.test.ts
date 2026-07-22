import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import { TurnStore } from '../src/main/turn-store'
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

  // Codex first-turn: the ask has buffered the prompt (pasted, not yet
  // submitted) and Codex's boot screen has no "> prompt" echo, so the screen
  // recovery fails — fall back to the buffered input instead of recording
  // '(recovered turn)' with a boot-hallucinated title.
  it('recovers a first-turn prompt from the input buffer when no screen echo exists (Codex)', () => {
    const { tracker, session } = makeTracker()
    // The ask pastes the prompt; the submitting Enter has not arrived yet.
    session.emit('input', '\x1b[200~Reply with exactly: CODEX-QA-ALPHA\x1b[201~')
    // Codex boot output (agent activity) self-heals before the Enter lands.
    session.full = 'OpenAI Codex v0.144.6\n⏺ booting'
    session.emit('data', '⏺ booting')
    const activity = tracker.list()[0]
    expect(activity.phase).toBe('thinking')
    expect(activity.prompt).toBe('Reply with exactly: CODEX-QA-ALPHA')
    tracker.disposeAll()
  })

  // Codex first-turn, the deterministic repro: a boot phantom whose boot
  // screen trips attention detection sits in 'waiting', so the real first ask
  // Enter was swallowed as a menu-answer (resume, no startTurn) → T1 stayed
  // promptless and recorded '(recovered turn)'. A promptless waiting phantom
  // must instead let the real prompt start the turn.
  it('starts the real first turn when a prompt is submitted onto a promptless waiting phantom (Codex)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    // Boot output with a live spinner self-heals into a promptless phantom.
    session.full = '✻ Cerebrating… (esc to interrupt · 3s)'
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 3s)')
    expect(phaseOf(tracker)).toBe('thinking')
    expect(tracker.list()[0].prompt).toBe(null)
    // The spinner clears and a boot menu line remains; quiescence → 'waiting'.
    session.full = 'OpenAI Codex v0.144.6\nDo you want to proceed?'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(5000)
    expect(phaseOf(tracker)).toBe('waiting')
    // The real ask arrives (paste + submitting Enter).
    session.emit('input', '\x1b[200~Reply with exactly: CODEX-QA-ALPHA\x1b[201~')
    session.emit('input', '\r')
    const activity = tracker.list()[0]
    expect(activity.phase).toBe('thinking')
    expect(activity.prompt).toBe('Reply with exactly: CODEX-QA-ALPHA')
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

  // Codex boot phantom: a fresh terminal's boot screen self-heals into a
  // promptless turn that finalizes BEFORE any ask (they arrive seconds later).
  // With no prompt AND no user input ever captured, it is boot noise — it must
  // be DISCARDED, not minted as a '(recovered turn)' checkpoint that shifts
  // every later index.
  it('discards a promptless boot phantom at finalize (no prompt, no input)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.full = '✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)'
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)')
    expect(phaseOf(tracker)).toBe('thinking')
    expect(tracker.list()[0].prompt).toBe(null)

    // Spinner clears to boot output; quiescence finalizes — but no ask came.
    session.full = 'OpenAI Codex v0.144.6\nWelcome'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('replied')
    expect(tracker.history('term-1')).toHaveLength(0)
    tracker.disposeAll()
  })

  it('keeps the synthetic label for a promptless turn that DID see input', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)')
    expect(phaseOf(tracker)).toBe('thinking')
    // A bare Enter (no capturable prompt text) still counts as user input, so
    // the turn is a real exchange recorded under the recovered label.
    session.emit('input', '\r')

    session.full = '⏺ finished the refactor'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
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

  it('recovers the real prompt from the transcript echo on self-heal', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    // Reattach mid-turn: the screen already shows the prompt echo the old
    // tracker instance saw typed, plus the live spinner.
    session.full = '> make it the app icon too\n\n✻ Cerebrating… (esc to interrupt · 3s)'
    session.emit('data', '✻ Cerebrating… (esc to interrupt · 3s)')
    expect(phaseOf(tracker)).toBe('thinking')
    expect(tracker.list()[0].prompt).toBe('make it the app icon too')

    session.full += '\n⏺ done, icon updated'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    const history = tracker.history('term-1')
    expect(history).toHaveLength(1)
    expect(history[0].prompt).toBe('make it the app icon too')
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

describe('TurnTracker acknowledge-on-view (seen)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('demotes replied to idle on seen, keeping prompt, reply and title', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    tracker.seen('term-1')
    const activity = tracker.list()[0]
    expect(activity.phase).toBe('idle')
    expect(activity.prompt).toBe('fix it')
    expect(activity.reply).toContain('all tests pass')
    tracker.disposeAll()
  })

  it('emits an activity push when the demotion happens', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    await completeTurn(tracker, session)

    let pushed: string | null = null
    tracker.on('activity', (a: { phase: string }) => {
      pushed = a.phase
    })
    tracker.seen('term-1')
    expect(pushed).toBe('idle')
    tracker.disposeAll()
  })

  it('is a no-op while thinking or waiting — a view must not end a live turn', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    session.emit('input', 'do the thing\r')
    expect(phaseOf(tracker)).toBe('thinking')
    tracker.seen('term-1')
    expect(phaseOf(tracker)).toBe('thinking')

    // Park the turn on 'waiting' (question menu) — seen must not answer it.
    session.full = 'Do you want to proceed? (y/n)'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phaseOf(tracker)).toBe('waiting')
    tracker.seen('term-1')
    expect(phaseOf(tracker)).toBe('waiting')
    tracker.disposeAll()
  })

  it('is a no-op on idle terminals and unknown ids', () => {
    const { tracker } = makeTracker()
    tracker.seen('term-1')
    expect(phaseOf(tracker)).toBe('idle')
    expect(() => tracker.seen('no-such-terminal')).not.toThrow()
    tracker.disposeAll()
  })
})

describe('TurnTracker restart restore (last exchange + unread state)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function makePersistentPair(): {
    dir: string
    boot: () => { tracker: TurnTracker; session: FakeSession }
  } {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-turns-'))
    return {
      dir,
      boot: () => {
        const tracker = new TurnTracker(async () => null, new TurnStore(dir))
        const session = new FakeSession()
        tracker.track(session as unknown as PtySession, true)
        return { tracker, session }
      }
    }
  }

  it('restores the last exchange as unread TURN COMPLETE after a restart', async () => {
    vi.useFakeTimers()
    const { boot } = makePersistentPair()
    const first = boot()
    await completeTurn(first.tracker, first.session)
    first.tracker.flushHistories()
    first.tracker.disposeAll()

    vi.useRealTimers()
    const second = boot()
    const activity = second.tracker.list()[0]
    expect(activity.phase).toBe('replied')
    expect(activity.prompt).toBe('fix it')
    expect(activity.reply).toContain('all tests pass')
    second.tracker.disposeAll()
  })

  it('restores as READY (idle) when the turn was seen before the restart', async () => {
    vi.useFakeTimers()
    const { boot } = makePersistentPair()
    const first = boot()
    await completeTurn(first.tracker, first.session)
    first.tracker.seen('term-1')
    first.tracker.flushHistories()
    first.tracker.disposeAll()

    vi.useRealTimers()
    const second = boot()
    const activity = second.tracker.list()[0]
    expect(activity.phase).toBe('idle')
    expect(activity.prompt).toBe('fix it')
    expect(activity.reply).toContain('all tests pass')
    second.tracker.disposeAll()
  })

  it('leaves terminals with no history blank and idle', () => {
    const { boot } = makePersistentPair()
    const { tracker } = boot()
    const activity = tracker.list()[0]
    expect(activity.phase).toBe('idle')
    expect(activity.prompt).toBeNull()
    tracker.disposeAll()
  })
})

describe('TurnTracker pending input + paste binding (DEFECT 2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never starts a turn from pasted-but-unsubmitted text, even chunk-split', () => {
    const { tracker, session } = makeTracker()
    session.emit('input', '\x1b[200')
    session.emit('input', '~/tmp/screenshot.png \x1b[201')
    session.emit('input', '~')
    expect(phaseOf(tracker)).toBe('idle')
    expect(tracker.list()[0].pendingInput).toContain('/tmp/screenshot.png')
    tracker.disposeAll()
  })

  it('binds the prompt on the REAL submit, pairing paste with the typed ask', () => {
    const { tracker, session } = makeTracker()
    session.emit('input', '\x1b[200')
    session.emit('input', '~/tmp/screenshot.png \x1b[201~')
    session.emit('input', 'describe this\r')
    const activity = tracker.list()[0]
    expect(activity.phase).toBe('thinking')
    expect(activity.prompt).toBe('/tmp/screenshot.png describe this')
    expect(activity.pendingInput).toBeNull()
    tracker.disposeAll()
  })

  it('exposes typed-but-unsent input as pendingInput, cleared on submit', () => {
    const { tracker, session } = makeTracker()
    session.emit('input', 'hello wor')
    expect(tracker.list()[0].pendingInput).toBe('hello wor')
    session.emit('input', 'ld\r')
    const activity = tracker.list()[0]
    expect(activity.pendingInput).toBeNull()
    expect(activity.prompt).toBe('hello world')
    tracker.disposeAll()
  })

  it('pushes a throttled activity update while typing (no submit)', async () => {
    vi.useFakeTimers()
    const { tracker, session } = makeTracker()
    let pending: string | null = null
    tracker.on('activity', (a: { pendingInput: string | null }) => {
      pending = a.pendingInput
    })
    session.emit('input', 'draft…')
    await vi.advanceTimersByTimeAsync(400)
    expect(pending).toBe('draft…')
    tracker.disposeAll()
  })
})
