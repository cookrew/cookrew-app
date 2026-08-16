// Sol r4 P0-1a — the producer guard runs BEFORE proc.write.
//
// The review's core claim: PtySession wrote the bytes to the child and only
// then emitted the input event that reached preemption, so preemption could
// never stop a competing submission — it only changed bookkeeping after
// delivery. The guard now sits ahead of proc.write and a 'preempt-failed'
// verdict REFUSES the write outright (ledger-down preemption, fail-closed).
// The one legitimate bypass is writeFromDispatch — the reattach fallback's
// own delivery — which also tags its input event so the tracker's fallback
// exemption keys on SOURCE, never on byte equality.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const procWrites: string[] = []

vi.mock('node-pty', () => ({
  default: {
    spawn: () => ({
      write: (data: string) => procWrites.push(data),
      resize: () => undefined,
      kill: () => undefined,
      onData: () => undefined,
      onExit: () => undefined
    })
  }
}))

import { PtySession, setMultiplexer, setBackends } from '../src/main/pty'
import type { Multiplexer } from '../src/main/multiplexer'

/** The minimum multiplexer a PtySession construction touches. */
const fakeMux = {
  id: 'fake',
  capabilities: {
    persistsAcrossRestart: false,
    copyModeSearch: false,
    wheelScrollback: false,
    agentLifecycle: false
  },
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

function makeSession(): PtySession {
  setMultiplexer(fakeMux)
  setBackends([])
  return new PtySession({
    terminalId: 'term-1',
    command: 'claude',
    cwd: '/tmp',
    socketPath: '/tmp/cookrew-test.sock',
    cliDir: '/tmp'
  })
}

describe('PtySession.write consults the owner guard BEFORE proc.write', () => {
  beforeEach(() => {
    procWrites.length = 0
  })

  it('unwired guard: bytes flow and the input event fires (the historical path)', () => {
    const session = makeSession()
    const inputs: string[] = []
    session.on('input', (data: string) => inputs.push(data))
    session.write('hello\r')
    expect(procWrites).toEqual(['hello\r'])
    expect(inputs).toEqual(['hello\r'])
    session.dispose()
  })

  it('preempt-failed REFUSES the write: nothing reaches the child, nothing is announced', () => {
    // Ledger-down preemption: the armed dispatch's interrupt row could not
    // commit, so the owner's competing submission is refused fail-closed
    // rather than delivered beside a live reservation.
    const session = makeSession()
    const asked: string[] = []
    const inputs: string[] = []
    session.on('input', (data: string) => inputs.push(data))
    session.beforeOwnerInput = (terminalId, data) => {
      asked.push(`${terminalId}:${data}`)
      return 'preempt-failed'
    }
    session.write('a competing ask\r')
    expect(asked).toEqual(['term-1:a competing ask\r'])
    expect(procWrites).toEqual([])
    expect(inputs).toEqual([])
    session.dispose()
  })

  it("'refused' (a dispatch delivery holds the producer lease) drops the bytes too", () => {
    // Sol r6 P0-1: while a delivery is mid-paste, non-preempting owner bytes
    // must not enter the shared input buffer. Any non-'allow' verdict stops
    // the write before proc.write.
    const session = makeSession()
    const inputs: string[] = []
    session.on('input', (data: string) => inputs.push(data))
    session.beforeOwnerInput = () => 'refused'
    session.write('owner typing mid-delivery')
    expect(procWrites).toEqual([])
    expect(inputs).toEqual([])
    session.dispose()
  })

  it('allow lets the write through unchanged', () => {
    const session = makeSession()
    session.beforeOwnerInput = () => 'allow'
    session.write('fine\r')
    expect(procWrites).toEqual(['fine\r'])
    session.dispose()
  })

  it('writeFromDispatch bypasses the guard and tags its input event by source', () => {
    // The reattach fallback delivers the dispatch's own bytes: guarding it
    // would make the dispatch preempt itself, and an UNtagged event would
    // leave the tracker guessing provenance from byte equality — the exact
    // hole Sol r4 P0-1b closes.
    const session = makeSession()
    let guardCalls = 0
    const inputs: Array<[string, string | undefined]> = []
    session.beforeOwnerInput = () => {
      guardCalls += 1
      return 'preempt-failed'
    }
    session.on('input', (data: string, source?: string) => inputs.push([data, source]))
    session.writeFromDispatch('the dispatched brief\r')
    expect(guardCalls).toBe(0)
    expect(procWrites).toEqual(['the dispatched brief\r'])
    expect(inputs).toEqual([['the dispatched brief\r', 'dispatch']])
    session.dispose()
  })
})
