// A typed slash command is a UI action, not an exchange. Measured live
// 2026-11-01: "/exit" + Enter showed the agent working for 6 s; and a
// discarded command turn ended in 'replied', which the card reads as an
// unread reply and ticks as done.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import { isUiCommand } from '../src/shared/turn'

class Session extends EventEmitter {
  text = '❯ \n'
  lastOut = Date.now()
  constructor(public terminalId: string, public sessionName = `cookrew_${terminalId}`) {
    super()
  }
  fullText(): string {
    return this.text
  }
  viewportText(): string {
    return this.text
  }
  idleFor(): number {
    return Date.now() - this.lastOut
  }
  paint(chunk: string): void {
    this.text += `${chunk}\n`
    this.lastOut = Date.now()
    this.emit('data', chunk)
  }
  type(bytes: string): void {
    this.emit('input', bytes)
  }
}

function tracked(): { turns: TurnTracker; s: Session } {
  const turns = new TurnTracker(async () => null)
  const s = new Session('t1')
  turns.track(s as unknown as PtySession, true)
  return { turns, s }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('slash commands', () => {
  it('knows the UI-only commands, and not the ones that run a turn', () => {
    for (const c of ['/model', '/clear', '/exit', '/help', '/model opus', '/resume']) expect(isUiCommand(c)).toBe(true)
    for (const c of ['/compact', '/code-review', '/init', 'fix /model picker', 'hello']) expect(isUiCommand(c)).toBe(false)
  })

  it('a UI-only command never shows the agent working', () => {
    const { turns, s } = tracked()
    s.type('/model\r')
    expect(turns.phaseOf('t1')).toBe('idle')
    s.paint('  Select model\n❯ 1. Default (recommended)\n  2. Opus')
    vi.advanceTimersByTime(4000)
    expect(turns.phaseOf('t1')).toBe('idle')
  })

  it('the repaint after closing a picker does not open a turn either (round-2 eval, 3 of 5 runs)', () => {
    const { turns, s } = tracked()
    s.text = '❯ Reply OK and nothing else.\n⏺ OK\n\n✻ Churned for 7s\n❯ \n' // the last exchange is on screen
    s.type('/model\r')
    s.paint('  Select model\n❯ 1. Default (recommended)\n  2. Opus')
    expect(turns.phaseOf('t1')).toBe('idle')
    vi.advanceTimersByTime(4000)
    s.type('\x1b') // Esc closes the picker; Claude repaints the transcript's bottom
    s.paint('❯ Reply OK and nothing else.\n⏺ OK\n\n✻ Churned for 7s')
    expect(turns.phaseOf('t1')).toBe('idle')
    vi.advanceTimersByTime(4000)
    expect(turns.phaseOf('t1')).toBe('idle')
  })

  it('a command turn that ran no model turn rests, it is not an unread reply', () => {
    const { turns, s } = tracked()
    s.type('/compact\r')
    expect(turns.phaseOf('t1')).toBe('thinking')
    s.paint('⎿  Compacted. ctrl+o to see full summary')
    vi.advanceTimersByTime(4500)
    expect(turns.phaseOf('t1')).toBe('idle')
  })

  it('a command that ran a real model turn (a skill) ends as an unread reply', () => {
    const { turns, s } = tracked()
    s.type('/code-review\r')
    s.paint('⏺ Reviewed 3 files; nothing critical.')
    s.paint('✻ Baked for 3s')
    vi.advanceTimersByTime(4500)
    expect(turns.phaseOf('t1')).toBe('replied')
  })
})
