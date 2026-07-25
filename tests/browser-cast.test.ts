import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createBrowserCast, originAllowed } from '../src/main/browser-cast'
import type { HeadlessInstance } from '../src/main/headless-chrome'

function maskedTextFrame(payload: string): Buffer {
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const data = Buffer.from(payload, 'utf8')
  const masked = Buffer.from(data.map((byte, index) => byte ^ key[index % key.length]))
  const header = Buffer.from([0x81, 0x80 | data.length])
  return Buffer.concat([header, key, masked])
}

interface TestSocket extends Duplex {
  writes: string[]
  emitEvent: (name: string, value?: unknown) => void
  setWritableLength: (value: number) => void
}

/** Minimal socket stub recording writes + destroy. */
function socketStub(): TestSocket {
  const writes: string[] = []
  const listeners = new Map<string, Set<(value?: unknown) => void>>()
  let destroyed = false
  let writableLength = 0
  const emitEvent = (name: string, value?: unknown): void => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(value)
  }
  const socket = {
    writes,
    get destroyed() {
      return destroyed
    },
    get writableLength() {
      return writableLength
    },
    emitEvent,
    setWritableLength: (value: number) => {
      writableLength = value
    },
    write: vi.fn((c: unknown) => {
      writes.push(String(c))
      return true
    }),
    destroy: vi.fn(() => {
      if (destroyed) return
      destroyed = true
      emitEvent('close')
    }),
    on: vi.fn((name: string, listener: (value?: unknown) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return socket
    }),
    once: vi.fn((name: string, listener: (value?: unknown) => void) => {
      const wrapped = (value?: unknown): void => {
        listeners.get(name)?.delete(wrapped)
        listener(value)
      }
      const set = listeners.get(name) ?? new Set()
      set.add(wrapped)
      listeners.set(name, set)
      return socket
    })
  }
  return socket as unknown as TestSocket
}
function req(url: string, origin?: string): IncomingMessage {
  return {
    url,
    headers: { 'sec-websocket-key': 'k', host: 'localhost', ...(origin ? { origin } : {}) }
  } as unknown as IncomingMessage
}
/** A headless-instance stub so upgrade() never spawns real Chrome in tests. */
function fakeInstance(): HeadlessInstance {
  const viewportState = {
    width: 390,
    height: 844,
    mobile: true,
    revision: 1,
    ownerId: null,
    viewerCount: 0,
    agentHeld: false,
    transitioning: false
  }
  return {
    frameListeners: new Set(),
    dispatchInput: vi.fn(),
    stop: vi.fn(),
    viewport: { width: 390, height: 844 },
    viewportState,
    registerViewportViewer: vi.fn(),
    unregisterViewportViewer: vi.fn(),
    offerViewport: vi.fn(),
    claimViewport: vi.fn(() => true),
    releaseViewport: vi.fn(),
    onViewportState: vi.fn(() => vi.fn())
  } as unknown as HeadlessInstance
}
const okDeps = () => ({
  enabled: () => true,
  desktopToken: () => 'desktop-secret',
  getInstance: vi.fn(() => Promise.resolve(fakeInstance()))
})

describe('upgrade() guards (sync, before any instance work)', () => {
  it('refuses a non-stream upgrade path (destroy, no 101)', () => {
    const socket = socketStub()
    createBrowserCast(okDeps()).upgrade(req('/api/browser/abc/other?w=1'), socket)
    expect(socket.destroy).toHaveBeenCalled()
    expect(socket.writes.join('')).not.toMatch(/101/)
  })
  it('refuses when the flag is off', () => {
    const socket = socketStub()
    const deps = { ...okDeps(), enabled: () => false }
    createBrowserCast(deps).upgrade(req('/api/browser/abc/stream?w=390&h=844'), socket)
    expect(socket.destroy).toHaveBeenCalled()
    expect(deps.getInstance).not.toHaveBeenCalled()
  })
  it('a valid /stream WITH a query writes the 101 (regression: match pathname, not req.url)', () => {
    const socket = socketStub()
    createBrowserCast(okDeps()).upgrade(req('/api/browser/abc123/stream?w=390&h=844'), socket)
    expect(socket.writes.join('')).toMatch(/HTTP\/1\.1 101 Switching Protocols/)
  })
  it('authorizes the desktop cross-origin socket only with its per-process token', () => {
    const refused = socketStub()
    createBrowserCast(okDeps()).upgrade(
      req('/api/browser/abc/stream', 'http://localhost:5173'),
      refused
    )
    expect(refused.destroy).toHaveBeenCalled()

    const accepted = socketStub()
    createBrowserCast(okDeps()).upgrade(
      req('/api/browser/abc/stream?desktopToken=desktop-secret', 'http://localhost:5173'),
      accepted
    )
    expect(accepted.writes.join('')).toMatch(/HTTP\/1\.1 101 Switching Protocols/)
  })
})

describe('upgrade() attaches to the node-owned instance', () => {
  it('resolves the browser id through the manager', async () => {
    const deps = okDeps()
    createBrowserCast(deps).upgrade(req('/api/browser/xyz/stream?w=390&h=844'), socketStub())
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.getInstance).toHaveBeenCalledWith('xyz')
  })

  it('does not retain a client that disconnects while Chrome is starting', async () => {
    let resolve!: (instance: HeadlessInstance | null) => void
    const pending = new Promise<HeadlessInstance | null>((done) => (resolve = done))
    const instance = fakeInstance()
    const socket = socketStub()
    const cast = createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      getInstance: vi.fn(() => pending)
    })
    cast.upgrade(req('/api/browser/slow/stream'), socket)
    socket.emitEvent('close')
    resolve(instance)
    await pending
    await Promise.resolve()
    expect(instance.frameListeners.size).toBe(0)
    expect(cast.activeCount()).toBe(0)
  })

  it('detaches a viewer without stopping the node-owned browser', async () => {
    const instance = fakeInstance()
    const socket = socketStub()
    const cast = createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      getInstance: vi.fn(() => Promise.resolve(instance))
    })
    cast.upgrade(req('/api/browser/shared/stream'), socket)
    await Promise.resolve()
    await Promise.resolve()
    expect(instance.frameListeners.size).toBe(1)

    socket.emitEvent('close')
    expect(instance.frameListeners.size).toBe(0)
    expect(instance.stop).not.toHaveBeenCalled()
    expect(cast.activeCount()).toBe(0)
  })

  it('drops raw CDP-shaped input and forwards sanitized input only', async () => {
    const instance = fakeInstance()
    const socket = socketStub()
    createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      getInstance: vi.fn(() => Promise.resolve(instance))
    }).upgrade(req('/api/browser/secure/stream'), socket)
    await Promise.resolve()
    await Promise.resolve()

    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ method: 'Runtime.evaluate', params: { expression: '1' } }))
    )
    expect(instance.dispatchInput).not.toHaveBeenCalled()

    for (const listener of instance.frameListeners) listener('current-frame', { revision: 1 })

    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'key', key: 'a', code: 'KeyA', revision: 1 }))
    )
    expect(instance.dispatchInput).toHaveBeenCalledTimes(2)
  })

  it('accepts only sanitized viewport intents and revision-gates page input', async () => {
    const instance = fakeInstance()
    const socket = socketStub()
    createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      getInstance: vi.fn(() => Promise.resolve(instance))
    }).upgrade(req('/api/browser/secure/stream'), socket)
    await Promise.resolve()
    await Promise.resolve()

    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({
        t: 'viewport-claim',
        width: 390,
        height: 700,
        mobile: true,
        method: 'Emulation.setDeviceMetricsOverride'
      }))
    )
    expect(instance.claimViewport).toHaveBeenCalledWith(
      expect.any(String),
      { width: 390, height: 700, mobile: true }
    )

    socket.emitEvent('data', maskedTextFrame(JSON.stringify({ t: 'tap', x: 1, y: 1 })))
    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'tap', x: 1, y: 1, revision: 99 }))
    )
    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'tap', x: 1, y: 1, revision: 1 }))
    )
    expect(instance.dispatchInput).not.toHaveBeenCalled()

    for (const listener of instance.frameListeners) listener('current-frame', { revision: 1 })

    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'tap', x: 1, y: 1, revision: 1 }))
    )
    expect(instance.dispatchInput).toHaveBeenCalledTimes(2)
  })

  it('enforces agent/transition holds but permits a current-revision pointer release', async () => {
    const instance = fakeInstance()
    const socket = socketStub()
    createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      getInstance: vi.fn(() => Promise.resolve(instance))
    }).upgrade(req('/api/browser/secure/stream'), socket)
    await Promise.resolve()
    await Promise.resolve()

    for (const listener of instance.frameListeners) listener('current-frame', { revision: 1 })

    Object.assign(instance.viewportState, { agentHeld: true })
    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'move', x: 1, y: 1, revision: 1 }))
    )
    expect(instance.dispatchInput).not.toHaveBeenCalled()

    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'touchend', x: 1, y: 1, revision: 1 }))
    )
    expect(instance.dispatchInput).toHaveBeenCalledWith(
      'Input.dispatchTouchEvent',
      { type: 'touchEnd', touchPoints: [] }
    )

    vi.mocked(instance.dispatchInput).mockClear()
    Object.assign(instance.viewportState, { agentHeld: false, transitioning: true })
    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'down', x: 1, y: 1, revision: 1 }))
    )
    socket.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'up', x: 1, y: 1, revision: 1 }))
    )
    expect(instance.dispatchInput).toHaveBeenCalledTimes(1)
    expect(instance.dispatchInput).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseReleased' })
    )
  })

  it('keeps a fast viewer flowing while a slow viewer retains only its latest frame', async () => {
    const instance = fakeInstance()
    const fast = socketStub()
    const slow = socketStub()
    const cast = createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      getInstance: vi.fn(() => Promise.resolve(instance))
    })
    cast.upgrade(req('/api/browser/shared/stream'), fast)
    cast.upgrade(req('/api/browser/shared/stream'), slow)
    await Promise.resolve()
    await Promise.resolve()

    slow.setWritableLength(1_000_000)
    for (const listener of instance.frameListeners) listener('frame-one', {})
    for (const listener of instance.frameListeners) listener('frame-two', {})

    expect(fast.writes.join('')).toContain('frame-one')
    expect(fast.writes.join('')).toContain('frame-two')
    expect(slow.writes.join('')).not.toContain('frame-one')
    expect(slow.writes.join('')).not.toContain('frame-two')
    slow.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'key', key: 'a', code: 'KeyA', revision: 1 }))
    )
    expect(instance.dispatchInput).not.toHaveBeenCalled()

    slow.setWritableLength(0)
    slow.emitEvent('drain')
    expect(slow.writes.join('')).not.toContain('frame-one')
    expect(slow.writes.join('')).toContain('frame-two')
    slow.emitEvent(
      'data',
      maskedTextFrame(JSON.stringify({ t: 'key', key: 'a', code: 'KeyA', revision: 1 }))
    )
    expect(instance.dispatchInput).toHaveBeenCalledTimes(2)
  })
})

describe('originAllowed (CSWSH / DNS-rebinding guard)', () => {
  it('allows no Origin (native / CLI client)', () => {
    expect(originAllowed({ headers: { host: '192.168.2.13:8643' } })).toBe(true)
  })
  it('allows a same-host Origin (the served phone bundle)', () => {
    expect(
      originAllowed({ headers: { origin: 'https://192.168.2.13:8643', host: '192.168.2.13:8643' } })
    ).toBe(true)
  })
  it('refuses a cross-origin web page', () => {
    expect(
      originAllowed({ headers: { origin: 'https://evil.example', host: '192.168.2.13:8643' } })
    ).toBe(false)
  })
  it('refuses a malformed Origin', () => {
    expect(originAllowed({ headers: { origin: 'not a url', host: '192.168.2.13:8643' } })).toBe(false)
  })
})
