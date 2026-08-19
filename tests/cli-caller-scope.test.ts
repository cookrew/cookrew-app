// The CLI stops asking what anyone is looking at.
//
// Every `cookrew` invocation arrives from inside a pane, and that pane already
// knows which workspace it lives in — so command scope can travel with the
// CALLER instead of with focus. That is what lets one global CLI socket serve
// N concurrent workspace sessions (marketplace-architecture §11): the socket
// stays process-wide, its scope goes per-session.
//
// The bug this closes: with a second seat looking elsewhere, `cookrew workspace
// dir add` run by an agent in workspace B silently edited workspace A's dirs.

import { describe, expect, it } from 'vitest'
import { callerWorkspaceId, tryCallerWorkspaceId } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import type { WorkspaceStore } from '../src/main/store'
import type { CliRequest } from '../src/shared/model'

const CALLER = { id: 't1', kind: 'terminal', name: 'Coder', orch: false }

function deps(over: {
  ownerOf?: (id: string) => string | undefined
  focusedId?: string
  node?: unknown
}): SocketServerDeps {
  const store = {
    node: () => (over.node === undefined ? CALLER : over.node),
    ownerOf: over.ownerOf ?? ((): string | undefined => undefined),
    focusedId: over.focusedId ?? 'focused-ws'
  } as unknown as WorkspaceStore
  return { store, agents: { list: () => [] } } as unknown as SocketServerDeps
}

const request = (over: Partial<CliRequest> = {}): CliRequest =>
  ({ args: [], flags: {}, terminalId: 't1', ...over }) as CliRequest

describe('callerWorkspaceId', () => {
  it('resolves the workspace that OWNS the calling pane', () => {
    const scope = callerWorkspaceId(request(), deps({ ownerOf: () => 'caller-ws' }))
    expect(scope).toBe('caller-ws')
  })

  it('ignores focus entirely when the caller can be placed', () => {
    // The regression that mattered: an agent in B editing A's dirs because a
    // desktop somewhere had A on screen.
    const scope = callerWorkspaceId(
      request(),
      deps({ ownerOf: () => 'caller-ws', focusedId: 'some-other-ws' })
    )
    expect(scope).toBe('caller-ws')
    expect(scope).not.toBe('some-other-ws')
  })

  it('falls back to focus only when the caller cannot be placed at all', () => {
    // A plain shell using `--as "Name"` against a registry entry whose node is
    // gone: there is no pane to derive scope from, so focus is all there is.
    const scope = callerWorkspaceId(
      request(),
      deps({ ownerOf: () => undefined, focusedId: 'focused-ws' })
    )
    expect(scope).toBe('focused-ws')
  })

  it('is stable across a focus change — scope belongs to the caller', () => {
    const owner = (): string => 'caller-ws'
    expect(callerWorkspaceId(request(), deps({ ownerOf: owner, focusedId: 'a' }))).toBe('caller-ws')
    expect(callerWorkspaceId(request(), deps({ ownerOf: owner, focusedId: 'b' }))).toBe('caller-ws')
  })
})

describe('tryCallerWorkspaceId — a plain shell is not an error (review C1)', () => {
  it('resolves the caller when there IS one', () => {
    expect(tryCallerWorkspaceId(request(), deps({ ownerOf: () => 'caller-ws' }))).toBe('caller-ws')
  })

  it('returns undefined instead of throwing for a non-pane shell', () => {
    // `cookrew workspace dir list` from an ordinary terminal is a legitimate
    // invocation that used to work. self() throws 'not attached' there, which
    // is right for identity-scoped commands and wrong for scope resolution —
    // making it throw regressed the plain CLI, flag-off.
    const shell = deps({ node: null, ownerOf: () => undefined })
    expect(() => tryCallerWorkspaceId(request({ terminalId: undefined }), shell)).not.toThrow()
    expect(tryCallerWorkspaceId(request({ terminalId: undefined }), shell)).toBeUndefined()
  })

  it('the throwing variant still throws — identity commands need that', () => {
    const shell = deps({ node: null, ownerOf: () => undefined })
    expect(() => callerWorkspaceId(request({ terminalId: undefined }), shell)).toThrow()
  })
})
