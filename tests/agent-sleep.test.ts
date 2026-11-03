// AN IDLE AGENT SLEEPS; THE NEXT ASK OR LIVE WAKES IT ON THE SAME SESSION.
//
// Owner, 2026-10-31: keep the TUI, but stop paying for it when nobody uses it —
// a window with no turn, no viewer and no input ends the process; the
// conversation stays on disk and comes back by resume. Measured that day: an
// idle agent's tree is 450–700 MB (claude plus its MCP children), and 14 of 16
// agents were idle. 2026-11-01: the window is an hour, and this clock only
// nominates — agent-sleep-evidence.test.ts covers who actually sleeps.
import { describe, expect, it } from 'vitest'
import { IdleSleep, idleSleepMsFrom, type SleepFacts } from '../src/main/agent-sleep'

const MIN = 60_000
const facts = (over: Partial<SleepFacts> = {}): SleepFacts => ({
  id: 'a', resumable: true, served: false, busy: false, ...over
})

describe('IdleSleep — who is due to sleep', () => {
  it('never sleeps an agent on first sight: the clock starts when we start watching', () => {
    const s = new IdleSleep(10 * MIN)
    expect(s.due([facts()], 0)).toEqual([])
    expect(s.due([facts()], 9 * MIN)).toEqual([])
  })

  it('sleeps after the idle window', () => {
    const s = new IdleSleep(10 * MIN)
    s.due([facts()], 0)
    expect(s.due([facts()], 10 * MIN)).toEqual(['a'])
  })

  it('a turn, a viewer or typing restarts the window', () => {
    const s = new IdleSleep(10 * MIN)
    s.due([facts()], 0)
    s.due([facts({ busy: true })], 8 * MIN)
    expect(s.due([facts()], 17 * MIN)).toEqual([])
    expect(s.due([facts()], 18 * MIN)).toEqual(['a'])
  })

  it('touch (a status change, a keystroke) restarts the window too', () => {
    const s = new IdleSleep(10 * MIN)
    s.due([facts()], 0)
    s.touch('a', 9 * MIN)
    expect(s.due([facts()], 12 * MIN)).toEqual([])
  })

  it('never sleeps what cannot be resumed exactly, or a served session', () => {
    const s = new IdleSleep(10 * MIN)
    const both = [facts({ id: 'shell', resumable: false }), facts({ id: 'guest', served: true })]
    s.due(both, 0)
    expect(s.due(both, 60 * MIN)).toEqual([])
  })

  it('remembers who it put to sleep, once', () => {
    const s = new IdleSleep(10 * MIN)
    s.markAsleep('a')
    expect(s.isAsleep('a')).toBe(true)
    expect(s.takeAsleep('a')).toBe(true)
    expect(s.takeAsleep('a')).toBe(false)
  })

  it('an agent seen alive again (woken by LIVE or an ask) is awake and gets a fresh window', () => {
    const s = new IdleSleep(10 * MIN)
    s.markAsleep('a')
    expect(s.due([facts()], 100 * MIN)).toEqual([])
    expect(s.isAsleep('a')).toBe(false)
    expect(s.due([facts()], 109 * MIN)).toEqual([])
    expect(s.due([facts()], 110 * MIN)).toEqual(['a'])
  })

  it('forgets terminals that are gone, so a reborn id starts clean', () => {
    const s = new IdleSleep(10 * MIN)
    s.due([facts()], 0)
    s.due([], 5 * MIN)
    expect(s.due([facts()], 11 * MIN)).toEqual([])
  })

  it('is off when the window is zero', () => {
    const s = new IdleSleep(0)
    s.due([facts()], 0)
    expect(s.due([facts()], 1000 * MIN)).toEqual([])
  })
})

describe('IdleSleep.restart — the evidence moves the clock', () => {
  it('counts the window from the newest sign of life the evidence found', () => {
    const s = new IdleSleep(60 * MIN)
    s.due([facts()], 0)
    expect(s.due([facts()], 60 * MIN)).toEqual(['a'])
    // Claude said busy at minute 60: a fresh hour from there.
    s.restart('a', 60 * MIN)
    expect(s.due([facts()], 119 * MIN)).toEqual([])
    expect(s.due([facts()], 120 * MIN)).toEqual(['a'])
  })

  it('a loop waking in the future holds the clock past its wakeup', () => {
    const s = new IdleSleep(60 * MIN)
    s.due([facts()], 0)
    s.restart('a', 90 * MIN)
    expect(s.due([facts()], 149 * MIN)).toEqual([])
    expect(s.due([facts()], 150 * MIN)).toEqual(['a'])
  })

  it('never moves the clock backwards, and ignores ids it does not watch', () => {
    const s = new IdleSleep(60 * MIN)
    s.due([facts()], 0)
    s.touch('a', 30 * MIN)
    s.restart('a', 10 * MIN)
    expect(s.due([facts()], 89 * MIN)).toEqual([])
    s.restart('ghost', 0)
    expect(s.due([facts({ id: 'ghost' })], 200 * MIN)).toEqual([])
  })
})

describe('idleSleepMsFrom — the env knob', () => {
  it('defaults to an hour (owner, 2026-11-01: ten minutes was unreasonable)', () => {
    expect(idleSleepMsFrom(undefined)).toBe(60 * MIN)
  })
  it('takes milliseconds, 0 turns it off', () => {
    expect(idleSleepMsFrom('300000')).toBe(5 * MIN)
    expect(idleSleepMsFrom('0')).toBe(0)
  })
  it('ignores garbage rather than sleeping everyone', () => {
    expect(idleSleepMsFrom('soon')).toBe(60 * MIN)
    expect(idleSleepMsFrom('-5')).toBe(60 * MIN)
  })
})
