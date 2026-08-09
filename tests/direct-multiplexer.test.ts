import { describe, expect, it } from 'vitest'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import { selectMultiplexers } from '../src/main/multiplexer-select'
import type { AttachSpec, Multiplexer } from '../src/main/multiplexer'

/**
 * This backend IS the Windows runtime: tmux does not exist there and herdr
 * cannot host a terminal, so the release ships this path. It used to be an
 * untested `else` in pty.ts, which is the reason these tests exist.
 */

const SPEC: AttachSpec = {
  sessionName: 'cookrew_abc',
  command: 'claude --permission-mode bypassPermissions',
  shell: '/bin/zsh',
  terminalId: 'abc-123',
  socketPath: '/tmp/sock',
  cliDir: '/tmp/cli',
  path: '/tmp/cli:/usr/bin',
  cwd: '/tmp/work'
}

const direct = (): DirectMultiplexer => new DirectMultiplexer()

describe('capabilities — what it costs, declared', () => {
  it('CAN attach transparently — node-pty owns the process', () => {
    // The one backend that cannot fail transparency: there is no other program
    // between Cookrew and the shell to inject anything into the stream.
    expect(direct().capabilities.attach).toBe(true)
  })

  it('declares that agents do NOT survive the app closing', () => {
    // Cookrew's headline behaviour, absent here. Saying so once, in a place
    // callers can act on, is the whole point of the capability.
    expect(direct().capabilities.persistsAcrossRestart).toBe(false)
  })

  it('declares no copy-mode search and no monotonic history', () => {
    expect(direct().capabilities.copyModeSearch).toBe(false)
    expect(direct().capabilities.monotonicHistory).toBe(false)
  })

  it('is always available — node-pty is a dependency, not a program to find', () => {
    expect(direct().available()).toBe(true)
  })
})

describe('attachSpawn', () => {
  it('runs the command through a LOGIN shell', () => {
    // -l matters: a GUI-launched app inherits a stripped PATH and the agent
    // needs the user's real one.
    expect(direct().attachSpawn(SPEC)).toEqual({
      file: '/bin/zsh',
      args: ['-l', '-c', 'claude --permission-mode bypassPermissions']
    })
  })

  it('falls back to an interactive shell when there is no command', () => {
    expect(direct().attachSpawn({ ...SPEC, command: '' }).args).toEqual(['-l', '-c', '/bin/zsh'])
    expect(direct().attachSpawn({ ...SPEC, command: '  ' }).args).toEqual(['-l', '-c', '/bin/zsh'])
  })
})

describe('the reads it honestly cannot answer', () => {
  it('returns NULL capture, not empty string', () => {
    // Load-bearing: the board probe reads '' as "the pane is empty" and null
    // as "no signal". This backend has no out-of-process view of the screen,
    // so claiming emptiness would invent a fact.
    expect(direct().capture()).toBeNull()
  })

  it('reports no scroll state rather than zeros', () => {
    expect(direct().scrollState()).toEqual({ scrollRow: null, historySize: null })
  })

  it('claims no session registry it does not have', () => {
    // A PtySession's existence IS the session, and PtyManager already tracks
    // those; answering yes here would claim knowledge this backend lacks.
    expect(direct().sessionExists()).toBe(false)
    expect(direct().listSessions()).toEqual([])
  })

  it('never pretends to scroll or to have cleaned anything up', () => {
    expect(() => direct().jumpToText()).not.toThrow()
    expect(() => direct().exitCopyMode()).not.toThrow()
    expect(() => direct().killSession()).not.toThrow()
    expect(() => direct().reloadConfig()).not.toThrow()
  })
})

describe('selection — Cookrew always has a host now', () => {
  const unavailableTmux = {
    id: 'tmux',
    capabilities: {
      attach: true,
      copyModeSearch: true,
      monotonicHistory: true,
      persistsAcrossRestart: true
    },
    available: () => false
  } as unknown as Multiplexer

  it('falls back to direct when tmux is absent — as on Windows', () => {
    const roles = selectMultiplexers({ candidates: [unavailableTmux, direct()] })
    expect(roles.host.id).toBe('direct')
    expect(roles.host.capabilities.persistsAcrossRestart).toBe(false)
  })

  it('prefers a persistent host when one is available', () => {
    const tmux = { ...unavailableTmux, available: () => true } as unknown as Multiplexer
    expect(selectMultiplexers({ candidates: [tmux, direct()] }).host.id).toBe('tmux')
  })

  it('means selection can no longer fail for want of a host', () => {
    // With direct in the list there is always an attach-capable backend, so
    // the NoHostMultiplexerError path becomes unreachable in production.
    expect(() => selectMultiplexers({ candidates: [direct()] })).not.toThrow()
  })
})
