import { describe, expect, it } from 'vitest'
import { bootMultiplexerSession } from '../src/main/pty'
import type { AttachSpec, Multiplexer } from '../src/main/multiplexer'

function backend(): Multiplexer & { ensures: string[]; attaches: string[] } {
  const sessions = new Set<string>()
  const ensures: string[] = []
  const attaches: string[] = []
  return {
    id: 'test-host',
    ensures,
    attaches,
    capabilities: {
      attach: true,
      copyModeSearch: false,
      wheelScrollback: false,
      monotonicHistory: false,
      persistsAcrossRestart: true,
      agentLifecycle: true
    },
    available: () => true,
    sessionExists: (name) => sessions.has(name),
    listSessions: () => [...sessions],
    killSession: (name) => void sessions.delete(name),
    ensureSession: (spec) => {
      ensures.push(spec.sessionName)
      sessions.add(spec.sessionName)
    },
    attachSpawn: (spec) => {
      attaches.push(spec.sessionName)
      return { file: 'unused', args: [] }
    },
    capture: () => null,
    scrollState: () => ({ scrollRow: null, historySize: null }),
    panePid: () => null,
    paneLaunch: () => null,
    jumpToText: () => undefined,
    exitCopyMode: () => undefined,
    reloadConfig: () => undefined
  }
}

const SPEC: AttachSpec = {
  sessionName: 'cookrew_agent-1',
  command: 'claude',
  shell: '/bin/zsh',
  terminalId: 'agent-1',
  socketPath: '/tmp/cookrew.sock',
  cliDir: '/tmp/cookrew-runtime',
  path: '/tmp/cookrew-runtime:/usr/bin',
  cwd: '/work/one'
}

describe('boot without PTY attachment', () => {
  it('ensures the multiplexer session without calling the attach path', () => {
    const host = backend()

    expect(bootMultiplexerSession(SPEC, host, [host])).toBe(true)
    expect(bootMultiplexerSession(SPEC, host, [host])).toBe(false)
    expect(host.ensures).toEqual([SPEC.sessionName, SPEC.sessionName])
    expect(host.attaches).toEqual([])
  })
})
