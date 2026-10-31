// An agent that is ALREADY blocked on a question when its mirror attaches
// (a card opened on it, a restart, a workspace switch) prints nothing more
// until someone answers. The tracker only ever looked for "waiting" while
// polling a turn it had seen start, so such an agent read as idle for as
// long as it waited: herdr said blocked, the screen showed the menu, and the
// card said ready. Measured live 2026-11-01 (Harden at an AskUserQuestion).

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import { detectAttention } from '../src/shared/turn'

const MENU = [
  '⏺ One decision is yours before the frames that show agents\' own words.',
  '────────────────────────────────────────',
  ' ☐ English rule',
  '❯ 1. Recruit an English shoot crew (Recommended)',
  '  2. Keep your real sessions, Chinese is fine',
  '────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
].join('\n')

class QuietSession extends EventEmitter {
  constructor(public terminalId: string, public sessionName = `cookrew_${terminalId}`, private text = MENU) {
    super()
  }
  fullText(): string {
    return this.text
  }
  viewportText(): string {
    return this.text
  }
  idleFor(): number {
    return 60_000
  }
}

const tracker = (): TurnTracker => new TurnTracker(async () => null)

describe('an agent blocked before its mirror attached', () => {
  it('turns waiting when herdr reports it blocked after the attach', () => {
    const turns = tracker()
    turns.track(new QuietSession('t1') as unknown as PtySession, true)
    expect(turns.phaseOf('t1')).toBe('idle')
    turns.observeBackendPhase('t1', 'waiting')
    expect(turns.phaseOf('t1')).toBe('waiting')
  })

  it('attaches as waiting when herdr already said blocked', () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'waiting')
    turns.track(new QuietSession('t1') as unknown as PtySession, true)
    expect(turns.phaseOf('t1')).toBe('waiting')
  })

  it('resumes working when output flows again (the human answered)', () => {
    const turns = tracker()
    const session = new QuietSession('t1')
    turns.track(session as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'waiting')
    session.emit('data', '✻ Pondering… (3s · esc to interrupt)')
    expect(turns.phaseOf('t1')).toBe('thinking')
  })

  it('leaves a shell alone and still never lets a bare herdr working override the screen', () => {
    const turns = tracker()
    turns.track(new QuietSession('s1') as unknown as PtySession, false)
    turns.observeBackendPhase('s1', 'waiting')
    expect(turns.phaseOf('s1')).toBe('idle')
    turns.track(new QuietSession('t2') as unknown as PtySession, true)
    turns.observeBackendPhase('t2', 'thinking')
    expect(turns.phaseOf('t2')).toBe('idle')
  })
})

describe('the attention patterns know the question menu', () => {
  it('reads an AskUserQuestion footer as a question the agent is blocked on', () => {
    expect(detectAttention(MENU.split('\n'))).toBe(true)
  })
  it('does not read a finished reply as a question', () => {
    expect(detectAttention(['⏺ Done. All 48 tests pass.', '', '✻ Cooked for 19s'])).toBe(false)
  })
})
