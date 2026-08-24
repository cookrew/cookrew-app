import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  handleMobileApi,
  acquireViewWhenReady,
  type MobileApiDeps,
} from '../src/main/mobile-api'
import { WorkspaceStore } from '../src/main/store'
import { DEFAULT_TERMINAL_SIZE } from '../src/shared/model'

class FakeSession extends EventEmitter {
  geometry(): { cols: number; rows: number } {
    return { cols: 100, rows: 30 }
  }

  replayFrame(): string {
    return 'transcript'
  }
}

function request(): http.IncomingMessage {
  const value = new EventEmitter() as http.IncomingMessage
  value.method = 'GET'
  value.headers = {}
  return value
}

function response(): http.ServerResponse {
  const value = Object.assign(new EventEmitter(), {
    req: { headers: {} } as http.IncomingMessage
  }) as http.ServerResponse
  value.writeHead = vi.fn(() => value) as unknown as http.ServerResponse['writeHead']
  value.write = vi.fn(() => true) as unknown as http.ServerResponse['write']
  value.end = vi.fn() as unknown as http.ServerResponse['end']
  value.destroy = vi.fn(() => value) as unknown as http.ServerResponse['destroy']
  return value
}

function deps(
  get: (terminalId: string) => FakeSession | undefined,
  over: Partial<MobileApiDeps> = {}
): MobileApiDeps {
  return {
    store: {},
    ptys: { get },
    turns: {},
    ops: {},
    presets: [],
    ...over
  } as unknown as MobileApiDeps
}

describe('mobile terminal stream lazy attachment', () => {
  it('acquires before reading the PTY and releases all viewer state on close', async () => {
    const order: string[] = []
    const session = new FakeSession()
    const acquire = vi.fn(() => {
      order.push('acquire')
      return true
    })
    const release = vi.fn()
    const subscribe = vi.fn()
    const unsubscribe = vi.fn()
    const req = request()
    const res = response()

    const handled = await handleMobileApi(
      req,
      res,
      new URL('http://localhost/api/terminal/t1/stream'),
      deps(
        () => {
          order.push('get')
          return session
        },
        {
          acquireTerminalView: acquire,
          releaseTerminalView: release,
          subscribeTerminal: subscribe,
          unsubscribeTerminal: unsubscribe
        }
      )
    )

    expect(handled).toBe(true)
    expect(order).toEqual(['acquire', 'get'])
    expect(subscribe).toHaveBeenCalledWith('t1')
    expect(session.listenerCount('data')).toBe(1)

    req.emit('close')
    res.emit('close')
    expect(session.listenerCount('data')).toBe(0)
    expect(unsubscribe).toHaveBeenCalledWith('t1')
    expect(release).toHaveBeenCalledWith('t1')
  })

  it('releases a successful acquisition when no PTY materializes', async () => {
    const release = vi.fn()
    const req = request()
    const res = response()

    await handleMobileApi(
      req,
      res,
      new URL('http://localhost/api/terminal/missing/stream'),
      deps(() => undefined, {
        acquireTerminalView: () => true,
        releaseTerminalView: release
      })
    )

    expect(release).toHaveBeenCalledWith('missing')
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })

  it('404s when the mirror never becomes resident within the boot window', async () => {
    const req = request()
    const res = response()

    await handleMobileApi(
      req,
      res,
      new URL('http://localhost/api/terminal/missing/stream'),
      // acquire keeps failing AND the pty never appears — a terminal that
      // genuinely cannot come up. The route waits the (test-shrunk) window then
      // 404s, handing recovery to the caller's retry / poll backstop.
      deps(() => undefined, {
        acquireTerminalView: () => false,
        viewReady: { attempts: 3, stepMs: 1 },
      })
    )

    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })
})

/**
 * The cold-boot fix (proxy fixture): opening a stream BOOTS the mirror on
 * demand, and a cold agent's PTY is not resident on the same tick — so the
 * route must wait through the boot window instead of 404-spamming the viewer.
 * This is what stopped the "[mirror: … retrying]" flood on a freshly-placed
 * proxy card. Tested on the extracted helper so the timing is deterministic.
 */
describe('acquireViewWhenReady — cold-boot tolerance', () => {
  const baseDeps = (over: Partial<MobileApiDeps>): MobileApiDeps =>
    ({ store: {}, ptys: {}, turns: {}, ops: {}, presets: [], ...over }) as unknown as MobileApiDeps

  it('returns true immediately when the mirror is already resident', async () => {
    const acquire = vi.fn(() => true)
    const ok = await acquireViewWhenReady(
      baseDeps({ acquireTerminalView: acquire }),
      { get: () => ({}) },
      't1',
    )
    expect(ok).toBe(true)
    expect(acquire).toHaveBeenCalledTimes(1) // no polling needed
  })

  it('waits through the boot window, then acquires once the PTY appears', async () => {
    // The classic race: the first acquire fails (spawn kicked off, not resident
    // yet); a few ticks later the PTY is registered and the second acquire wins.
    let resident = false
    setTimeout(() => {
      resident = true
    }, 5)
    const acquire = vi.fn(() => resident)
    const ok = await acquireViewWhenReady(
      baseDeps({ acquireTerminalView: acquire }),
      { get: () => (resident ? {} : undefined) },
      't1',
      { attempts: 40, stepMs: 2 },
    )
    expect(ok).toBe(true)
    expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(2) // failed then won
  })

  it('gives up after the bounded window when nothing ever comes up', async () => {
    const acquire = vi.fn(() => false)
    const ok = await acquireViewWhenReady(
      baseDeps({ acquireTerminalView: acquire }),
      { get: () => undefined },
      't1',
      { attempts: 3, stepMs: 1 },
    )
    expect(ok).toBe(false)
  })

  it('is a no-op pass-through for embedders/tests without a gating hook', async () => {
    const ok = await acquireViewWhenReady(baseDeps({}), { get: () => undefined }, 't1')
    expect(ok).toBe(true)
  })
})

/**
 * Cross-forked-workspace resolution — the primitive the proxy relies on. A
 * proxy card in one workspace mirrors an orch agent that a template import
 * placed in a DIFFERENT (forked session) workspace. The on-demand boot resolves
 * the target across every workspace, not just the focused one; this proves that
 * resolution survives switching away from the orch's home.
 */
describe('cross-workspace orch resolution (proxy target)', () => {
  const freshStore = (): WorkspaceStore =>
    new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-proxy-')))

  const addOrch = (store: WorkspaceStore, id: string): void => {
    store.addNode({
      kind: 'terminal',
      id,
      name: 'Commander',
      preset: 'Claude Code',
      command: 'claude',
      cwd: store.focusedState.dir,
      orch: true,
      role: null,
      position: { x: 0, y: 0 },
      size: DEFAULT_TERMINAL_SIZE,
    })
  }

  it('resolves the orch terminal after the caller switched to another workspace', () => {
    const store = freshStore()
    const orchHomeId = store.focusedId
    addOrch(store, 'orch-1')

    // The template import forks a NEW session workspace and switches to it; the
    // proxy card lives here, the orch stays in its home workspace.
    const forked = store.createWorkspace('Commander — session', store.focusedState.dir)
    store.switchWorkspace(forked.id)

    // Active-scoped lookups no longer see the orch...
    expect(store.node('orch-1')).toBeUndefined()
    // ...but the boot path resolves it across workspaces — the proxy stream can
    // still attach to an orch that lives in a background workspace.
    const hit = store.nodeAcrossWorkspaces('orch-1')
    expect(hit?.workspaceId).toBe(orchHomeId)
    expect(hit?.node.kind).toBe('terminal')
    expect((hit?.node as { orch?: boolean }).orch).toBe(true)
  })

  it('returns undefined for an orch id that exists in no workspace', () => {
    const store = freshStore()
    addOrch(store, 'orch-real')
    expect(store.nodeAcrossWorkspaces('orch-ghost')).toBeUndefined()
  })
})
