// How fast and how steadily a tracked agent's phase follows a turn, measured
// live on 2026-11-01 (scratchpad/status-eval/sample.mjs, a throwaway agent):
//   - a question menu was up AND herdr said blocked at 6.5 s; the card said
//     waiting at 9.3 s: poll() waited out 2.5 s of quiet before it even
//     looked at herdr's blocked.
//   - herdr said done and the screen showed "✻ Baked for 16s" at 31.7 s; the
//     card said done at 34.5 s: the same 2.5 s quiet gate.
//   - after the answer, herdr kept saying blocked for 3.5 s while the spinner
//     ran: trusting blocked blindly would flap the card waiting/working.
// The rule pinned here: a live spinner on the screen always means working;
// with no spinner, herdr's blocked is waiting at once, and herdr's done plus a
// finished-turn line ends the turn after a short settle instead of 2.5 s.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const herdr = new Map<string, string>()
vi.mock('../src/main/herdr-agent-status', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/herdr-agent-status')>()
  return { ...real, agentStatus: (name: string) => herdr.get(name) ?? null }
})

const { TurnTracker } = await import('../src/main/turn-tracker')
const { detectTurnEnded } = await import('../src/shared/turn')
type PtySession = import('../src/main/pty').PtySession

const PROMPT = '❯ Status probe B.\n'
const SPIN = '✻ Pondering… (4s · ↓ 120 tokens · esc to interrupt)'
const MENU = ' ☐ Pick\n❯ 1. A\n  2. B\n\nEnter to select · ↑/↓ to navigate · Esc to cancel'
const ENDED = '⏺ A\n\n✻ Baked for 16s\n\n────────\n❯ \n────────'

class Session extends EventEmitter {
  text = PROMPT
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
  /** The agent paints: the screen grows and the bytes arrive. */
  type(bytes: string): void {
    this.emit('input', bytes)
  }
  paint(chunk: string): void {
    this.text += `${chunk}\n`
    this.lastOut = Date.now()
    this.emit('data', chunk)
  }
  /** The agent repaints its bottom area (a menu replaces the spinner, a spinner replaces the menu). */
  show(bottom: string): void {
    this.text = `${PROMPT}${bottom}\n`
    this.lastOut = Date.now()
    this.emit('data', bottom)
  }
}

function start(): { turns: InstanceType<typeof TurnTracker>; s: Session } {
  const turns = new TurnTracker(async () => null)
  const s = new Session('t1')
  turns.track(s as unknown as PtySession, true)
  herdr.set(s.sessionName, 'working')
  s.paint(SPIN) // a live spinner opens the turn (self-heal)
  expect(turns.phaseOf('t1')).toBe('thinking')
  vi.advanceTimersByTime(1600) // past the spin-up grace
  return { turns, s }
}

beforeEach(() => {
  vi.useFakeTimers()
  herdr.clear()
})
afterEach(() => vi.useRealTimers())

describe('waiting follows the question at once, and holds through its redraws', () => {
  it('marks waiting on the next poll once herdr says blocked and no spinner is live', () => {
    const { turns, s } = start()
    s.show(MENU)
    herdr.set(s.sessionName, 'blocked')
    vi.advanceTimersByTime(500)
    expect(turns.phaseOf('t1')).toBe('waiting')
  })

  it('stays waiting while the menu redraws (arrow keys) and herdr still says blocked', () => {
    const { turns, s } = start()
    s.show(MENU)
    herdr.set(s.sessionName, 'blocked')
    vi.advanceTimersByTime(500)
    s.show(MENU.replace('❯ 1. A\n  2. B', '  1. A\n❯ 2. B')) // the cursor moved
    expect(turns.phaseOf('t1')).toBe('waiting')
    vi.advanceTimersByTime(500)
    expect(turns.phaseOf('t1')).toBe('waiting')
  })

  it('goes back to working the moment a spinner runs, even while herdr still says blocked', () => {
    const { turns, s } = start()
    s.show(MENU)
    herdr.set(s.sessionName, 'blocked')
    vi.advanceTimersByTime(500)
    s.show(SPIN) // answered; herdr's blocked is stale for a few seconds
    expect(turns.phaseOf('t1')).toBe('thinking')
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(400)
      expect(turns.phaseOf('t1')).toBe('thinking')
    }
  })
})

describe('done follows the finished turn without the long quiet', () => {
  it('ends the turn shortly after herdr says done and the screen shows a finished-turn line', () => {
    const { turns, s } = start()
    s.paint(ENDED)
    herdr.set(s.sessionName, 'done')
    vi.advanceTimersByTime(1200)
    expect(turns.phaseOf('t1')).toBe('replied')
  })

  it('ends just as soon when herdr says idle rather than done (round-2 eval: 3 of 8 ends took 2.7 s)', () => {
    const { turns, s } = start()
    s.paint(ENDED)
    herdr.set(s.sessionName, 'idle')
    vi.advanceTimersByTime(1200)
    expect(turns.phaseOf('t1')).toBe('replied')
  })

  it('never ends early while herdr still says working', () => {
    const { turns, s } = start()
    s.paint(ENDED)
    herdr.set(s.sessionName, 'working')
    vi.advanceTimersByTime(3000)
    expect(turns.phaseOf('t1')).toBe('thinking')
  })

  it('does not take the LAST turn\'s finished line for this one (a new prompt, before its spinner)', () => {
    const turns = new TurnTracker(async () => null)
    const s = new Session('t1')
    s.text = `${PROMPT}⏺ earlier answer\n\n✻ Baked for 16s\n❯ \n`
    turns.track(s as unknown as PtySession, true)
    herdr.set(s.sessionName, 'done') // stale: the hook has not reported the new turn yet
    s.type('Status probe C\r')
    expect(turns.phaseOf('t1')).toBe('thinking')
    s.paint('❯ Status probe C') // the echo, then nothing for a while: the model is thinking
    vi.advanceTimersByTime(2000)
    expect(turns.phaseOf('t1')).toBe('thinking')
  })

  it('never ends on herdr done while a spinner is still the last status line', () => {
    const { turns, s } = start()
    s.paint(`${ENDED}\n${SPIN}`)
    herdr.set(s.sessionName, 'done')
    vi.advanceTimersByTime(1200)
    expect(turns.phaseOf('t1')).toBe('thinking')
  })
})

describe('detectTurnEnded reads the LAST status line', () => {
  it('is true under a finished-turn line', () => expect(detectTurnEnded(ENDED)).toBe(true))
  it('is false when a live spinner follows it', () => expect(detectTurnEnded(`${ENDED}\n${SPIN}`)).toBe(false))
  it('is false with no status line at all', () => expect(detectTurnEnded('⏺ hello\n❯ ')).toBe(false))
})

// Status eval r5, desktop step 3: Enter on the menu, then working → waiting
// for 394 ms → working. herdr still said blocked after the menu closed, and
// the answer's spinner was not up yet.
describe('right after a menu answer', () => {
  it("a stale blocked with the menu gone does not bounce back to waiting", () => {
    const { turns, s } = start()
    herdr.set(s.sessionName, 'blocked')
    s.show(MENU)
    vi.advanceTimersByTime(400)
    expect(turns.phaseOf('t1')).toBe('waiting')
    s.type('\r')
    expect(turns.phaseOf('t1')).toBe('thinking')
    s.show('') // the menu closes; no spinner yet
    for (let ms = 0; ms < 1200; ms += 100) {
      vi.advanceTimersByTime(100)
      expect(turns.phaseOf('t1')).toBe('thinking')
    }
    s.show(SPIN)
    herdr.set(s.sessionName, 'working')
    vi.advanceTimersByTime(400)
    expect(turns.phaseOf('t1')).toBe('thinking')
  })

  it('a question still on screen after the Enter is waiting at once', () => {
    const { turns, s } = start()
    herdr.set(s.sessionName, 'blocked')
    s.show(MENU)
    vi.advanceTimersByTime(400)
    s.type('\r')
    s.show(MENU) // the Enter landed on a row that keeps the menu up
    vi.advanceTimersByTime(400)
    expect(turns.phaseOf('t1')).toBe('waiting')
  })
})
