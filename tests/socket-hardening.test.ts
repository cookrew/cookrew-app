import { describe, expect, it, vi } from 'vitest'
import {
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
