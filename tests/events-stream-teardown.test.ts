import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { CableSignalBus } from '../src/main/cable-signal'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * ONE CLOSE LISTENER PER EVENT STREAM.
 *
 * /api/events subscribes to a dozen buses, and each used to register its own
 * `request.on('close')`. Eleven of them on one request is what Node reported,
 * once per phone, as `MaxListenersExceededWarning ... [IncomingMessage]`. The
 * teardown is now one list behind one listener, and closing the stream must
 * still leave every bus as it found it.
 */

function fakeStream(): { request: http.IncomingMessage; response: http.ServerResponse; close: () => void } {
  const request = new EventEmitter() as unknown as http.IncomingMessage
  request.method = 'GET'
  request.headers = {}
  const response = Object.assign(new EventEmitter(), {
    req: request,
    writableEnded: false,
    destroyed: false,
    writeHead: () => response,
    write: () => true,
    end: () => response
  }) as unknown as http.ServerResponse
  return {
    request,
    response,
    close: () => {
      request.emit('close')
      response.emit('close')
    }
  }
}

function everyBus(): { deps: MobileApiDeps; listeners: () => number; held: () => number } {
  const store = Object.assign(new EventEmitter(), {
    focusedState: { name: 'ws', dir: '/tmp', nodes: [], connections: [] }
  })
  const turns = Object.assign(new EventEmitter(), { list: () => [] })
  const buildBus = new EventEmitter()
  const uiBus = new EventEmitter()
  const tuningBus = new EventEmitter()
  const inboxBus = new EventEmitter()
  const sousBus = new EventEmitter()
  const routeBus = new EventEmitter()
  const reachBus = new EventEmitter()
  const signalBus = new CableSignalBus()
  const useListeners = new Set<() => void>()
  const useBus = {
    on: (listener: () => void) => {
      useListeners.add(listener)
      return () => void useListeners.delete(listener)
    }
  }
  const agentListeners = new Set<() => void>()
  let holds = 0
  const hold = (): (() => void) => {
    holds += 1
    return () => void (holds -= 1)
  }
  const emitters = [store, turns, buildBus, uiBus, tuningBus, inboxBus, sousBus, routeBus, reachBus]
  const deps = {
    store,
    turns,
    ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'ws' }) },
    build: { id: () => 'b1', bus: buildBus },
    uiBus,
    tuningBus,
    inbox: () => [],
    inboxHold: hold,
    inboxBus,
    sousBus,
    signalBus,
    useBus,
    route: { hold },
    routeBus,
    reachBus,
    agents: {
      onChange: (listener: () => void) => {
        agentListeners.add(listener)
        return () => void agentListeners.delete(listener)
      }
    }
  } as unknown as MobileApiDeps
  const listeners = (): number =>
    emitters.reduce((sum, emitter) => sum + emitter.eventNames().reduce((n, name) => n + emitter.listenerCount(name), 0), 0) +
    signalBus.size +
    useListeners.size +
    agentListeners.size
  return { deps, listeners, held: () => holds }
}

describe('GET /api/events tears down through one close listener', () => {
  it('adds one close listener to the request and leaves every bus clean when the phone leaves', async () => {
    const { deps, listeners, held } = everyBus()
    const stream = fakeStream()
    const handled = await handleMobileApi(stream.request, stream.response, new URL('http://lan.local/api/events'), deps)
    expect(handled).toBe(true)
    expect(stream.request.listenerCount('close')).toBe(1)
    expect(listeners()).toBeGreaterThan(10)
    expect(held()).toBe(2)

    stream.close()
    expect(listeners()).toBe(0)
    expect(held()).toBe(0)
  })
})
