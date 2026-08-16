import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TerminalActivity, TurnPhase } from '../src/shared/turn'
import { turnViewOf } from '../src/renderer/src/turn-view-model'

const TURN_VIEW_SOURCE = readFileSync(
  join(__dirname, '../src/renderer/src/nodes/TurnView.tsx'),
  'utf8'
)

function activity(over: Partial<TerminalActivity> = {}): TerminalActivity {
  return {
    terminalId: 't1',
    agent: true,
    phase: 'idle' as TurnPhase,
    prompt: null,
    dispatchId: null,
    pendingInput: null,
    lines: [],
    reply: null,
    glance: null,
    title: null,
    turnCount: 0,
    turnStartLine: null,
    scrollRow: null,
    scrollBase: null,
    tailLines: null,
    turnStartedAt: null,
    updatedAt: 0,
    ...over
  }
}

/**
 * The card's whole body comes from this selector, so "the card went blank"
 * is always a claim about what turnViewOf returned.
 *
 * The regression these lock down: the tracker does not always know the prompt.
 * It loses it whenever it self-heals into a turn it did not start — reattach
 * after a Cookrew restart, or input delivered around the PTY (herdr/tmux
 * send-keys, the CLI, the phone). TurnTracker.resumeThinking recovers the
 * prompt only from the TUI's on-screen echo, and a long turn scrolls that
 * echo away. A null prompt used to short-circuit straight to the screen tail,
 * which threw away the phase, the Sous title, the live status verb and the
 * tool trail: cards under a running spinner rendered as a lone '❯' with
 * "LIVE · 88 CHECKPOINTS" underneath.
 */
describe('turnViewOf: an unknown ask is not an empty turn', () => {
  const running = activity({
    phase: 'thinking',
    prompt: null,
    title: 'Running code for 3 minutes',
    glance: { status: 'Doing… (9m 47s · ↓ 26.6k tokens)', tools: ['Bash(npm test)'], message: null },
    lines: ['', '❯', ''],
    turnCount: 88
  })

  it('shows the live status verb instead of the screen tail', () => {
    const model = turnViewOf(running)
    expect(model.latest).toEqual({ text: 'Doing… (9m 47s · ↓ 26.6k tokens)', tone: 'working' })
    expect(model.tail).toBeNull()
  })

  it('keeps the Sous title and the tool trail', () => {
    const model = turnViewOf(running)
    expect(model.title).toBe('Running code for 3 minutes')
    expect(model.tools).toEqual(['Bash(npm test)'])
  })

  it('reports the ask as unknown rather than inventing one', () => {
    expect(turnViewOf(running).ask).toBeNull()
  })

  it('never degrades a running turn to the bare input prompt', () => {
    // '❯' is the last non-empty screen line of every idle Claude TUI, so it is
    // exactly what the old tail path surfaced for a busy agent.
    expect(turnViewOf(running).tail).not.toBe('❯')
  })

  it('surfaces a waiting turn that lost its prompt as needing input', () => {
    const model = turnViewOf(
      activity({
        phase: 'waiting',
        prompt: null,
        glance: { status: null, message: 'Allow Bash to run?', tools: [] },
        lines: ['', '❯', '']
      })
    )
    expect(model.latest).toEqual({ text: 'Allow Bash to run?', tone: 'waiting' })
  })

  it('falls back to a status verb when the spinner text is missing', () => {
    const model = turnViewOf(activity({ phase: 'thinking', prompt: null, glance: null }))
    expect(model.latest).toEqual({ text: 'Working…', tone: 'working' })
  })
})

/**
 * The tail path is not deleted — it is narrowed to what it was written for:
 * an agent with genuinely nothing running.
 */
describe('turnViewOf: the screen tail still covers a quiet reattach', () => {
  it('surfaces the last screen line when idle with no tracked turn', () => {
    const model = turnViewOf(
      activity({ phase: 'idle', prompt: null, lines: ['boot', 'Done in 4s', ''] })
    )
    expect(model.tail).toBe('Done in 4s')
    expect(model.latest).toBeNull()
    expect(model.ask).toBeNull()
  })

  it('surfaces the tail for an unread completed turn the tracker did not see', () => {
    const model = turnViewOf(activity({ phase: 'replied', prompt: null, lines: ['all green'] }))
    expect(model.tail).toBe('all green')
  })

  it('reports no tail at all for a blank screen', () => {
    expect(turnViewOf(activity({ lines: ['', '   '] })).tail).toBeNull()
  })

  it('still shows typed-but-unsent input alongside the tail', () => {
    const model = turnViewOf(activity({ prompt: null, lines: ['x'], pendingInput: 'draft ask' }))
    expect(model.pendingInput).toBe('draft ask')
    expect(model.tail).toBe('x')
  })

  it('returns an all-empty model when there is no activity yet', () => {
    const model = turnViewOf(undefined)
    expect(model).toEqual({
      title: null,
      ask: null,
      tools: [],
      latest: null,
      pendingInput: null,
      tail: null
    })
  })
})

/** A known prompt must behave exactly as it always did. */
describe('turnViewOf: a tracked turn is unchanged', () => {
  it('renders ask, title, tools and the live verb', () => {
    const model = turnViewOf(
      activity({
        phase: 'thinking',
        prompt: 'fix the respawn issue\nsecond line',
        title: 'Respawn fix',
        glance: { status: 'Doing… (12s) (esc to interrupt)', tools: ['Read(pty.ts)'], message: null }
      })
    )
    expect(model.ask).toBe('fix the respawn issue')
    expect(model.title).toBe('Respawn fix')
    expect(model.tools).toEqual(['Read(pty.ts)'])
    expect(model.latest).toEqual({ text: 'Doing… (12s)', tone: 'working' })
    expect(model.tail).toBeNull()
  })

  it('shows the reply once the turn is done, and drops the tool trail', () => {
    const model = turnViewOf(
      activity({
        phase: 'replied',
        prompt: 'ship it',
        reply: 'Shipped.\ndetails',
        glance: { status: null, tools: ['Bash(git push)'], message: null }
      })
    )
    expect(model.latest).toEqual({ text: 'Shipped.', tone: 'done' })
    expect(model.tools).toEqual([])
  })
})

/**
 * TurnView owns the other half of the same bug: its shell-tail branch used to
 * key on `ask === null` alone, so a turn with an unknown ask rendered the tail
 * no matter what the model said. Guarded at the source because a .tsx test
 * would need `jsx` in tsconfig.node.json, which tests/** is compiled by.
 */
describe('TurnView binds the tail branch to an empty MODEL, not to a null ask', () => {
  it('does not take the tail path on `ask === null` alone', () => {
    expect(TURN_VIEW_SOURCE).not.toMatch(/if \(ask === null\) \{/)
  })

  it('requires the whole turn to be empty before falling back to the tail', () => {
    expect(TURN_VIEW_SOURCE).toMatch(
      /if \(\s*ask === null &&\s*latest === null &&\s*title === null &&\s*tools\.length === 0\s*\)/
    )
  })

  it('renders the You: line conditionally so a null ask omits it', () => {
    expect(TURN_VIEW_SOURCE).toMatch(/\{ask !== null && \(/)
  })
})
