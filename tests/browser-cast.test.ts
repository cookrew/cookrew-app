import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createBrowserCast, originAllowed } from '../src/main/browser-cast'
import type { HeadlessInstance } from '../src/main/headless-chrome'

/** Minimal socket stub recording writes + destroy. */
function socketStub(): Duplex & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    write: vi.fn((c: unknown) => {
      writes.push(String(c))
      return true
    }),
    destroy: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    writableLength: 0
  } as unknown as Duplex & { writes: string[] }
}
function req(url: string): IncomingMessage {
  return { url, headers: { 'sec-websocket-key': 'k', host: 'localhost' } } as unknown as IncomingMessage
}
/** A headless-instance stub so upgrade() never spawns real Chrome in tests. */
function fakeInstance(): HeadlessInstance {
  return {
    frameListeners: new Set(),
    onExit: () => undefined,
    start: () => Promise.resolve(),
    stop: vi.fn(),
    dispatchInput: vi.fn(),
    devToolsPort: 0
  } as unknown as HeadlessInstance
}
const okDeps = () => ({
  resolveTarget: vi.fn(() => ({ url: 'about:blank', profileDir: '/tmp/p' })),
  chromePath: vi.fn(() => '/fake/chrome'),
  enabled: () => true,
  makeInstance: vi.fn(() => fakeInstance())
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
    expect(deps.resolveTarget).not.toHaveBeenCalled()
  })
  it('a valid /stream WITH a query writes the 101 (regression: match pathname, not req.url)', () => {
    const socket = socketStub()
    createBrowserCast(okDeps()).upgrade(req('/api/browser/abc123/stream?w=390&h=844'), socket)
    expect(socket.writes.join('')).toMatch(/HTTP\/1\.1 101 Switching Protocols/)
  })
})

describe('upgrade() reaches the instance factory for a valid stream', () => {
  it('resolves target + chrome path and builds an instance (async)', async () => {
    const deps = okDeps()
    createBrowserCast(deps).upgrade(req('/api/browser/xyz/stream?w=390&h=844'), socketStub())
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.chromePath).toHaveBeenCalled()
    expect(deps.resolveTarget).toHaveBeenCalledWith('xyz')
    expect(deps.makeInstance).toHaveBeenCalled()
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
