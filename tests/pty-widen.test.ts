// EVERY WIDEN ENDS NARROWER (PtySession.resize): Claude Code redraws the
// whole conversation only when the terminal narrows, and herdr's reflow on a
// widen joins rows that were exactly full at the old width. So a widen goes
// one column past and comes back; a narrowing goes straight through.

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

import { PtySession, WIDEN_SETTLE_MS, setBackends, setMultiplexer } from '../src/main/pty'
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

describe('PtySession.resize', () => {
  it('a widen goes one column past, then settles on the size asked for', () => {
    const session = makeSession(45)
    const replays: string[] = []
    session.on('replay', () => replays.push(String(session.geometry().cols)))
    session.resize(227, 52)
    expect(procResizes).toEqual(['228x52'])
    vi.advanceTimersByTime(WIDEN_SETTLE_MS)
    expect(procResizes).toEqual(['228x52', '227x52'])
    expect(replays).toEqual(['228', '227'])
    session.dispose()
  })

  it('a narrowing, or rows alone, goes straight through', () => {
    const session = makeSession(227)
    session.resize(45, 24)
    session.resize(45, 30)
    vi.advanceTimersByTime(WIDEN_SETTLE_MS * 2)
    expect(procResizes).toEqual(['45x24', '45x30'])
    session.dispose()
  })

  it('a size asked for during the overshoot replaces the settle (the repaint kick: cols+1, then cols)', () => {
    const session = makeSession(100)
    session.resize(101, 30)
    expect(procResizes).toEqual(['102x30'])
    vi.advanceTimersByTime(WIDEN_SETTLE_MS - 50)
    session.resize(100, 30)
    vi.advanceTimersByTime(WIDEN_SETTLE_MS * 2)
    // Ends on a narrowing, and the stale settle to 101 never fires.
    expect(procResizes).toEqual(['102x30', '100x30'])
    session.dispose()
  })

  it('a session closed during the overshoot does not resize after', () => {
    const session = makeSession(45)
    session.resize(100, 30)
    session.dispose()
    vi.advanceTimersByTime(WIDEN_SETTLE_MS * 2)
    expect(procResizes).toEqual(['101x30'])
  })
})
