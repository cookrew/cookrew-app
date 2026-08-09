import { describe, expect, it } from 'vitest'
import { migrateForeignSession } from '../src/main/pty'
import type { Multiplexer } from '../src/main/multiplexer'

/**
 * ONE live process per terminal across ALL multiplexers. Without this rule,
 * switching hosts forked the whole agent population: 13 tmux claudes and 13
 * herdr claudes with the same identities, writing the same conversations,
 * racing the same repo (measured live, 2026-08-09 — two Magpies, both resumed
 * from session 0e3f412a, one per backend).
 */

function backend(id: string, holds: Set<string>, available = true): Multiplexer & { kills: string[] } {
  const kills: string[] = []
  return {
    id,
    kills,
    capabilities: {
      attach: true,
      copyModeSearch: false,
      monotonicHistory: false,
      persistsAcrossRestart: true,
      agentLifecycle: false
    },
    available: () => available,
    sessionExists: (name: string) => holds.has(name),
    listSessions: () => [...holds],
    killSession: (name: string) => {
      kills.push(name)
      holds.delete(name)
    },
    ensureSession: () => {},
    attachSpawn: () => ({ file: 'x', args: [] }),
    capture: () => null,
    scrollState: () => ({ scrollRow: null, historySize: null }),
    panePid: () => null,
    paneLaunch: () => null,
    jumpToText: () => {},
    exitCopyMode: () => {},
    reloadConfig: () => {}
  }
}

const fileTurns = (): 'file' => 'file'
const SPEC = { sessionName: 'cookrew_abc', command: 'claude --resume deadbeef' }

describe('migrateForeignSession — one live process per terminal, everywhere', () => {
  it('kills the foreign copy so the host can resume it from the session file', () => {
    const tmux = backend('tmux', new Set(['cookrew_abc']))
    const herdr = backend('herdr', new Set())
    const outcome = migrateForeignSession(SPEC, herdr, [herdr, tmux], fileTurns, 50)
    expect(outcome).toBe('migrated')
    expect(tmux.kills).toEqual(['cookrew_abc'])
  })

  it('is symmetric — falling back to tmux migrates the herdr copy the same way', () => {
    // "Support the fallback" is this test: the rule has no favourite backend.
    const tmux = backend('tmux', new Set())
    const herdr = backend('herdr', new Set(['cookrew_abc']))
    const outcome = migrateForeignSession(SPEC, tmux, [herdr, tmux], fileTurns, 50)
    expect(outcome).toBe('migrated')
    expect(herdr.kills).toEqual(['cookrew_abc'])
  })

  it('does nothing when no other backend holds the session', () => {
    const tmux = backend('tmux', new Set())
    const herdr = backend('herdr', new Set())
    expect(migrateForeignSession(SPEC, herdr, [herdr, tmux], fileTurns)).toBe('none')
    expect(tmux.kills).toEqual([])
  })

  it('NEVER kills a scrape-only agent — its conversation IS the process', () => {
    // opencode has no session file; killing it would destroy the only copy of
    // its state. It stays where it lives, and the caller is told why.
    const tmux = backend('tmux', new Set(['cookrew_abc']))
    const herdr = backend('herdr', new Set())
    const outcome = migrateForeignSession(
      { sessionName: 'cookrew_abc', command: 'opencode' },
      herdr,
      [herdr, tmux],
      () => 'scrape',
      50
    )
    expect(outcome).toBe('left-unresumable')
    expect(tmux.kills).toEqual([])
  })

  it('NEVER kills a plain shell — jobs and history are unresumable too', () => {
    const tmux = backend('tmux', new Set(['cookrew_abc']))
    const herdr = backend('herdr', new Set())
    const outcome = migrateForeignSession(
      { sessionName: 'cookrew_abc', command: '' },
      herdr,
      [herdr, tmux],
      () => null,
      50
    )
    expect(outcome).toBe('left-unresumable')
    expect(tmux.kills).toEqual([])
  })

  it('ignores unavailable backends instead of probing a dead binary', () => {
    const tmux = backend('tmux', new Set(['cookrew_abc']), false)
    const herdr = backend('herdr', new Set())
    expect(migrateForeignSession(SPEC, herdr, [herdr, tmux], fileTurns)).toBe('none')
  })

  it('never asks the host about itself — the host holding the session is NORMAL', () => {
    // A surviving pane on the host is the reattach case (persistence), not a
    // foreign copy. Killing it would destroy the very thing persistence keeps.
    const herdr = backend('herdr', new Set(['cookrew_abc']))
    expect(migrateForeignSession(SPEC, herdr, [herdr], fileTurns)).toBe('none')
    expect(herdr.kills).toEqual([])
  })
})
