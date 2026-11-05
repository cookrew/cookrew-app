// AN IDLE AGENT SLEEPS; THE NEXT ASK OR LIVE WAKES IT ON THE SAME SESSION.
//
// Owner, 2026-10-31: keep the TUI, but stop paying for it when nobody uses it —
// a window with no turn, no viewer and no input ends the process; the
// conversation stays on disk and comes back by resume. Measured that day: an
// idle agent's tree is 450–700 MB (claude plus its MCP children), and 14 of 16
// agents were idle. 2026-11-01: the window is an hour, and this clock only
// nominates — agent-sleep-evidence.test.ts covers who actually sleeps.
import { describe, expect, it } from 'vitest'
import { BOOT_GRACE_MS, IdleSleep, idleSleepMsFrom, type SleepFacts } from '../src/main/agent-sleep'

const MIN = 60_000
const facts = (over: Partial<SleepFacts> = {}): SleepFacts => ({
  id: 'a', resumable: true, served: false, busy: false, ...over
})

describe('IdleSleep — who is due to sleep', () => {
  it('never sleeps an agent on first sight, but a boot only buys the grace, not a window', () => {
    // 2026-11-05: the app restarts many times a day, and each boot gave every
    // card a fresh hour, so a fleet that was idle for a day never got nominated.
    const s = new IdleSleep(60 * MIN)
    expect(s.due([facts()], 0)).toEqual([])
    expect(s.due([facts()], BOOT_GRACE_MS - 1)).toEqual([])
    expect(s.due([facts()], BOOT_GRACE_MS)).toEqual(['a'])
  })

  it('the boot grace survives a window that shrinks right after boot', () => {
    // Review, 2026-11-05: a grace kept as a backdated clock was erased by the
    // first pressure reading, a minute after every boot under pressure.
    const s = new IdleSleep(60 * MIN)
    s.due([facts()], 0)
    expect(s.due([facts()], MIN, 30 * MIN)).toEqual([])
    expect(s.due([facts()], BOOT_GRACE_MS - 1, 15 * MIN)).toEqual([])
    expect(s.due([facts()], BOOT_GRACE_MS, 15 * MIN)).toEqual(['a'])
  })

  it('after the grace the evidence sets the clock: a card quiet for a minute waits its window', () => {
    const s = new IdleSleep(60 * MIN)
    s.due([facts()], 0)
    expect(s.due([facts()], BOOT_GRACE_MS)).toEqual(['a'])
    s.restart('a', BOOT_GRACE_MS - MIN)
    expect(s.due([facts()], BOOT_GRACE_MS + 58 * MIN)).toEqual([])
    expect(s.due([facts()], BOOT_GRACE_MS + 59 * MIN)).toEqual(['a'])
  })

  it('a window shorter than the boot grace still waits only its own window', () => {
    const s = new IdleSleep(2 * MIN)
    s.due([facts()], 0)
    expect(s.due([facts()], 2 * MIN)).toEqual(['a'])
  })

  it('the window can shrink for one sweep: pressure nominates sooner', () => {
    const s = new IdleSleep(60 * MIN)
    s.due([facts({ busy: true })], 0)
    expect(s.due([facts()], 20 * MIN)).toEqual([])
    expect(s.due([facts()], 20 * MIN, 15 * MIN)).toEqual(['a'])
  })

  it('the longest-quiet agent is nominated first', () => {
    const s = new IdleSleep(60 * MIN)
    s.due([facts({ id: 'recent', busy: true }), facts({ id: 'oldest', busy: true })], 0)
    s.touch('recent', 30 * MIN)
    expect(s.due([facts({ id: 'recent' }), facts({ id: 'oldest' })], 100 * MIN)).toEqual(['oldest', 'recent'])
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
    const s = new IdleSleep(60 * MIN)
    s.due([facts()], 0)
    s.due([], 5 * MIN)
    expect(s.due([facts()], 6 * MIN)).toEqual([])
    expect(s.due([facts()], 6 * MIN + BOOT_GRACE_MS - 1)).toEqual([])
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
    s.due([facts({ busy: true })], 0)
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
    s.due([facts({ busy: true })], 0)
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
