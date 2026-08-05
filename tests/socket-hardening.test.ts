import { describe, expect, it, vi } from 'vitest'
import {
  browserWorkspaceError,
  RetryableDispatchError,
  resolveSelf,
  retryTransient
} from '../src/main/socket-server'
import type { WorkspaceStore } from '../src/main/store'

const meta = (id: string, name: string): { id: string; name: string } => ({ id, name })

function fakeStore(over: Partial<WorkspaceStore>): WorkspaceStore {
  return over as unknown as WorkspaceStore
}

describe('resolveSelf — cross-workspace error naming (a)', () => {
  it('names BOTH the home and active workspace when the terminal lives elsewhere', () => {
    const store = fakeStore({
      node: () => undefined,
      workspaceOfNode: () => meta('a', 'Alpha') as never,
      activeMeta: () => meta('b', 'Bravo') as never
    })
    expect(() => resolveSelf('t1', store)).toThrowError(/Alpha/)
    expect(() => resolveSelf('t1', store)).toThrowError(/Bravo/)
  })

  it('falls back to the generic message when the node exists nowhere', () => {
    const store = fakeStore({
      node: () => undefined,
      workspaceOfNode: () => undefined,
      activeMeta: () => meta('b', 'Bravo') as never
    })
    expect(() => resolveSelf('t1', store)).toThrowError(/not attached to a Cookrew terminal/i)
  })

  it('returns the terminal node when it is in the active workspace', () => {
    const node = { id: 't1', kind: 'terminal', name: 'Me' }
    const store = fakeStore({ node: () => node as never })
    expect(resolveSelf('t1', store)).toBe(node)
  })

  it('does not throw the cross-workspace error for a non-terminal node', () => {
    const store = fakeStore({
      node: () => ({ id: 't1', kind: 'note' }) as never,
      workspaceOfNode: () => undefined,
      activeMeta: () => meta('b', 'Bravo') as never
    })
    expect(() => resolveSelf('t1', store)).toThrowError(/not attached to a Cookrew terminal/i)
  })
})

describe('browserWorkspaceError — browsers do not cross workspaces', () => {
  const active = { id: 'ws-dev', name: 'Cookrew Dev' }
  const goat = { id: 'ws-goat', name: 'GOAT Team' }

  it('names the browser\'s OWN workspace instead of sending the agent back to list', () => {
    // The reported closed loop: `cookrew list` enumerates connections across
    // ALL workspaces and advertised this browser, then the webview lookup
    // (active workspace only) answered "not found. Run 'cookrew list'" —
    // so an agent loops list → info → list forever.
    const message = browserWorkspaceError({
      active,
      caller: goat,
      browser: { name: '巴法云', workspaceId: goat.id, workspaceName: goat.name }
    })
    expect(message).toMatch(/巴法云/)
    expect(message).toMatch(/GOAT Team/)
    expect(message).toMatch(/Cookrew Dev/)
    expect(message).toMatch(/workspace switch/)
    expect(message).not.toMatch(/cookrew list/)
  })

  it('does NOT refuse on the caller when the browser is right here', () => {
    // Regression guard: gating every subcommand on the CALLER's workspace
    // replaced one loop with another (switch to Beta for the terminal, switch
    // back for the browser). Only `create` needs the caller — driving a
    // browser only needs the browser, and that used to work from anywhere.
    expect(
      browserWorkspaceError({
        active,
        browser: { name: 'Docs', workspaceId: active.id, workspaceName: active.name }
      })
    ).toBeNull()
  })

  it('refuses a caller parked in another workspace, before create places a node', () => {
    // `browser create` has no browser name to check, so the caller's own
    // workspace is the guard — without it the node silently landed in the
    // ACTIVE workspace at (0,0) with an edge to an id that does not exist there.
    const message = browserWorkspaceError({ active, caller: goat })
    expect(message).toMatch(/GOAT Team/)
    expect(message).toMatch(/Cookrew Dev/)
    expect(message).toMatch(/workspace switch/)
  })

  it('allows the normal case: caller and browser both in the active workspace', () => {
    expect(browserWorkspaceError({ active, caller: active })).toBeNull()
    expect(
      browserWorkspaceError({
        active,
        caller: active,
        browser: { name: 'Docs', workspaceId: active.id, workspaceName: active.name }
      })
    ).toBeNull()
  })

  it('allows a caller the workspace files cannot place (registry-only, post-reboot)', () => {
    // resolveSelf synthesizes such a terminal from the durable registry; it is
    // not evidence of a cross-workspace call, so it must not be refused here.
    expect(browserWorkspaceError({ active })).toBeNull()
  })
})

describe('retryTransient — brief retry during a workspace switch (b)', () => {
  it('retries once after the delay when the first attempt is transiently not-attached', async () => {
    let calls = 0
    const sleep = vi.fn(async () => undefined)
    const result = await retryTransient(async () => {
      calls += 1
      if (calls === 1) throw new RetryableDispatchError('Agent has no running terminal')
      return 'ok'
    }, sleep)
    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('does NOT retry a non-transient error', async () => {
    let calls = 0
    const sleep = vi.fn(async () => undefined)
    await expect(
      retryTransient(async () => {
        calls += 1
        throw new Error('This terminal is not the Orch')
      }, sleep)
    ).rejects.toThrow(/not the Orch/)
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries at most once — a second transient failure propagates', async () => {
    let calls = 0
    const sleep = vi.fn(async () => undefined)
    await expect(
      retryTransient(async () => {
        calls += 1
        throw new RetryableDispatchError('still switching')
      }, sleep)
    ).rejects.toThrow(/still switching/)
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('returns immediately on success with no sleep', async () => {
    const sleep = vi.fn(async () => undefined)
    expect(await retryTransient(async () => 'done', sleep)).toBe('done')
    expect(sleep).not.toHaveBeenCalled()
  })
})
