// A WIDEN IS FOLLOWED BY A DIP, NEVER AN OVERSHOOT (PtySession.resize).
// Claude Code redraws its conversation only when the terminal narrows; on a
// widen herdr's reflow is left on screen. So a widen settles, dips one column
// narrower (the redraw) and comes back. It never passes through a width wider
// than asked: a late render at that width spills every row onto a blank one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const procResizes: string[] = []

vi.mock('node-pty', () => ({
  default: {
    spawn: () => ({
      write: () => undefined,
      resize: (cols: number, rows: number) => procResizes.push(`${cols}x${rows}`),
      kill: () => undefined,
      onData: () => undefined,
      onExit: () => undefined
    })
  }
}))

import { DIP_MS, PtySession, WIDEN_SETTLE_MS, setBackends, setMultiplexer } from '../src/main/pty'
import type { Multiplexer } from '../src/main/multiplexer'

const fakeMux = {
  id: 'fake',
  capabilities: { persistsAcrossRestart: false, copyModeSearch: false, wheelScrollback: false, agentLifecycle: false },
  available: () => true,
  sessionExists: () => false,
  ensureSession: () => undefined,
  attachSpawn: () => ({ file: '/bin/true', args: [], env: {} }),
  killSession: () => undefined,
  listSessions: () => [],
  scrollState: () => ({ scrollRow: null, historySize: null }),
  jumpToText: () => undefined,
  exitCopyMode: () => undefined,
  panePid: () => null,
  paneLaunch: () => null,
  reloadConfig: () => undefined
} as unknown as Multiplexer

function makeSession(cols: number): PtySession {
  setMultiplexer(fakeMux)
  setBackends([])
  return new PtySession({ terminalId: 'term-w', command: 'claude', cwd: '/tmp', socketPath: '/tmp/cookrew-test.sock', cliDir: '/tmp', cols, rows: 24 })
}

beforeEach(() => {
  vi.useFakeTimers()
  procResizes.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

const widest = (): number => Math.max(...procResizes.map((s) => Number(s.split('x')[0])))

describe('PtySession.resize', () => {
  it('a widen lands as asked, then dips one column narrower and comes back', () => {
    const session = makeSession(45)
    const replays: string[] = []
    session.on('replay', () => replays.push(String(session.geometry().cols)))
    session.resize(227, 52)
    expect(procResizes).toEqual(['227x52'])
    vi.advanceTimersByTime(WIDEN_SETTLE_MS)
    expect(procResizes).toEqual(['227x52', '226x52'])
    vi.advanceTimersByTime(DIP_MS)
    expect(procResizes).toEqual(['227x52', '226x52', '227x52'])
    expect(replays).toEqual(['227', '226', '227'])
    // Never past the width asked for.
    expect(widest()).toBe(227)
    session.dispose()
  })

  it('a narrowing, rows alone, or a one-column widen (the end of a dip) go straight through', () => {
    const session = makeSession(227)
    session.resize(45, 24)
    session.resize(45, 30)
    session.resize(44, 30)
    session.resize(45, 30)
    vi.advanceTimersByTime((WIDEN_SETTLE_MS + DIP_MS) * 2)
    expect(procResizes).toEqual(['45x24', '45x30', '44x30', '45x30'])
    session.dispose()
  })

  it('a size asked for during the dip replaces it: the last word is the asker\'s', () => {
    const session = makeSession(100)
    session.resize(200, 30)
    vi.advanceTimersByTime(WIDEN_SETTLE_MS)
    expect(procResizes).toEqual(['200x30', '199x30'])
    session.resize(150, 30)
    vi.advanceTimersByTime((WIDEN_SETTLE_MS + DIP_MS) * 2)
    expect(procResizes).toEqual(['200x30', '199x30', '150x30'])
    session.dispose()
  })

  it('a session closed during the dip does not resize after', () => {
    const session = makeSession(45)
    session.resize(100, 30)
    session.dispose()
    vi.advanceTimersByTime((WIDEN_SETTLE_MS + DIP_MS) * 2)
    expect(procResizes).toEqual(['100x30'])
  })
})
