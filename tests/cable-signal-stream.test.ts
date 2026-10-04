import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { CableSignalBus } from '../src/main/cable-signal'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * THE PHONE GETS THE SAME SIGNAL.
 *
 * The desktop renderer hears a cable light over IPC; the phone hears it on
 * the /api/events stream it already holds, as one `signal` frame, filtered
 * to the canvas the stream serves. No new route, no poll.
 */

const NOW = 1_700_000_000_000

function fakeStream(): {
  request: http.IncomingMessage
  response: http.ServerResponse
  frames: () => string
  close: () => void
} {
  const request = new EventEmitter() as unknown as http.IncomingMessage
  request.method = 'GET'
  request.headers = {}
  let written = ''
  const response = Object.assign(new EventEmitter(), {
    req: request,
    writableEnded: false,
    destroyed: false,
    writeHead() {
      return response
    },
    write(chunk: string) {
      written += chunk
      return true
    },
    end() {
      return response
    }
  }) as unknown as http.ServerResponse
  return {
    request,
    response,
    frames: () => written,
    close: () => {
      request.emit('close')
      response.emit('close')
    }
  }
}

function deps(bus: CableSignalBus): MobileApiDeps {
  const store = Object.assign(new EventEmitter(), {
    focusedState: {
      name: 'ws',
      dir: '/tmp',
      nodes: [
        { kind: 'terminal', id: 'orch', name: 'Orch' },
        { kind: 'terminal', id: 'forge', name: 'Forge' }
      ],
      connections: []
    }
  })
  const turns = Object.assign(new EventEmitter(), { list: () => [] })
  return {
    store,
    turns,
    ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'ws' }) },
    signalBus: bus
  } as unknown as MobileApiDeps
}

const url = (raw: string): URL => new URL(raw, 'http://lan.local')

describe('GET /api/events carries cable signals', () => {
  it('sends one `signal` frame per moment on this canvas, and stops when the phone leaves', async () => {
    const bus = new CableSignalBus(() => NOW)
    const stream = fakeStream()
    const handled = await handleMobileApi(stream.request, stream.response, url('/api/events'), deps(bus))
    expect(handled).toBe(true)

    bus.emit({ from: 'orch', to: 'forge', kind: 'ask' })
    expect(stream.frames()).toContain('signal')
    expect(stream.frames()).toContain('"from":"orch"')
    expect(stream.frames()).toContain('"kind":"ask"')

    // Either end on this canvas is enough — the other end may be a tab here.
    bus.emit({ from: 'elsewhere', to: 'forge', kind: 'answer' })
    expect(stream.frames()).toContain('"from":"elsewhere"')

    // The root stream is the canvas on screen and hears everything, as it
    // does for activity; a slug-scoped stream is filtered (below).
    bus.emit({ from: 'x', to: 'y', kind: 'ask' })
    expect(stream.frames()).toContain('"from":"x"')

    stream.close()
    expect(bus.size).toBe(0)
    bus.emit({ from: 'forge', to: 'orch', kind: 'answer' })
    expect(stream.frames()).not.toContain('"from":"forge"')
  })

  it('keeps another canvas’s traffic off a scoped stream', async () => {
    const bus = new CableSignalBus(() => NOW)
    const stream = fakeStream()
    const scoped = deps(bus)
    ;(scoped as unknown as { scope: string }).scope = 'ws-2'
    ;(scoped.store as unknown as { workspaceState: (id: string) => unknown }).workspaceState = () => ({
      name: 'other',
      dir: '/tmp',
      nodes: [{ kind: 'terminal', id: 'orch', name: 'Orch' }],
      connections: []
    })
    await handleMobileApi(stream.request, stream.response, url('/api/events'), scoped)
    bus.emit({ from: 'x', to: 'y', kind: 'ask' })
    expect(stream.frames()).not.toContain('"from":"x"')
    bus.emit({ from: 'orch', to: 'y', kind: 'ask' })
    expect(stream.frames()).toContain('"from":"orch"')
    stream.close()
  })

  it('serves the stream unchanged on a server without a bus', async () => {
    const stream = fakeStream()
    const handled = await handleMobileApi(
      stream.request,
      stream.response,
      url('/api/events'),
      { ...deps(new CableSignalBus()), signalBus: undefined } as MobileApiDeps
    )
    expect(handled).toBe(true)
    stream.close()
  })
})
