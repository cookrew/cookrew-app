import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { holdSocketsOpen } from '../src/main/mobile-http'

describe('the phone link holds its sockets open', () => {
  /**
   * Node's 5s keep-alive default is tuned for servers behind a fronting
   * proxy; this one has none, and its client TYPES INTERMITTENTLY. Every
   * pause longer than the window closed the connection, so the next
   * keystroke paid a fresh TCP+TLS handshake — over a relayed tailnet
   * (round trips 300ms–2.5s) that is the difference between an echo and a
   * stall, and it read as "the terminal is laggy" when the pty was instant.
   */
  it('outlasts a reader pause, with headersTimeout above it (the ECONNRESET race)', () => {
    const server = http.createServer()
    holdSocketsOpen(server)
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(60_000)
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout)
    server.close()
  })
})
