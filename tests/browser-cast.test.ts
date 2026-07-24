import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createBrowserCast, originAllowed } from '../src/main/browser-cast'

/** Minimal socket stub — upgrade() only needs destroy on the refusal paths. */
function socketStub(): Duplex {
  return { destroy: vi.fn(), write: vi.fn(), on: vi.fn(), once: vi.fn(), writableLength: 0 } as unknown as Duplex
}
function req(url: string): IncomingMessage {
  return { url, headers: { 'sec-websocket-key': 'k', host: 'localhost' } } as unknown as IncomingMessage
}

describe('upgrade() stream-path matching', () => {
  // Regression: STREAM_RE was matched against req.url (query included) with a
  // `$` anchor, so `/stream?w=&h=` — what EVERY real client sends — missed and
  // was refused before resolveWebContents ran. Match the pathname instead.
  it('reaches resolveWebContents for a /stream URL WITH a query string', () => {
    const resolveWebContents = vi.fn(() => null)
    const cast = createBrowserCast({ resolveWebContents, enabled: () => true })
    cast.upgrade(req('/api/browser/abc123/stream?w=390&h=844'), socketStub())
    expect(resolveWebContents).toHaveBeenCalledWith('abc123')
  })
  it('still matches a /stream URL with no query', () => {
    const resolveWebContents = vi.fn(() => null)
    createBrowserCast({ resolveWebContents, enabled: () => true }).upgrade(
      req('/api/browser/xyz/stream'),
      socketStub()
    )
    expect(resolveWebContents).toHaveBeenCalledWith('xyz')
  })
  it('refuses (destroys, no resolve) a non-stream upgrade path', () => {
    const resolveWebContents = vi.fn(() => null)
    const socket = socketStub()
    createBrowserCast({ resolveWebContents, enabled: () => true }).upgrade(
      req('/api/browser/abc/other?w=1'),
      socket
    )
    expect(resolveWebContents).not.toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalled()
  })
  it('refuses when the flag is off, before resolving', () => {
    const resolveWebContents = vi.fn(() => null)
    createBrowserCast({ resolveWebContents, enabled: () => false }).upgrade(
      req('/api/browser/abc/stream?w=390'),
      socketStub()
    )
    expect(resolveWebContents).not.toHaveBeenCalled()
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
