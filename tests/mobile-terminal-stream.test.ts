import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

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

  it('does not read the PTY when lazy acquisition fails', async () => {
    const get = vi.fn()
    const req = request()
    const res = response()

    await handleMobileApi(
      req,
      res,
      new URL('http://localhost/api/terminal/missing/stream'),
      deps(get, { acquireTerminalView: () => false })
    )

    expect(get).not.toHaveBeenCalled()
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })
})
