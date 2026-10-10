/**
 * A WEBSOCKET THAT SAYS HELLO AND HANGS UP — the one probe a browser carries
 * to the LAN when it will not carry a fetch.
 *
 * On the owner's iPhone (2026-10-11) a fetch from the cookrew.dev page to the
 * Mac's LAN name never reached the Mac: a 2.5 s probe, zero packets at the
 * listener, every race, with the Mac three metres away. A WebSocket is not a
 * fetch — the browser attaches neither CORS nor, in the engines that gate
 * local addresses, the same check — so the companion opens one here to learn
 * whether the LAN is reachable before it navigates there.
 *
 * It proves REACHABILITY and nothing else: the page it leads to is served
 * under a name whose certificate binds it to this Mac (reach-names.ts), so
 * the proof of identity is the certificate, exactly as for a typed URL.
 *
 * No library: the handshake is one SHA-1 and three headers, and the socket is
 * closed with a clean close frame the moment it opens. Nothing is read from
 * it and nothing but the close frame is written.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export const SOCKET_HELLO_PATH = '/api/ws-hello'

/** RFC 6455 §1.3 — the fixed GUID every accept value is derived with. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const socketAccept = (key: string): string =>
  createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')

/** A normal closure (1000), unmasked, as a server sends it. */
const CLOSE_FRAME = Buffer.from([0x88, 0x02, 0x03, 0xe8])

/** Whether this upgrade is the hello, and if so answer it. */
export const answerSocketHello = (request: IncomingMessage, socket: Duplex): boolean => {
  const path = (request.url ?? '').split('?')[0]
  if (path !== SOCKET_HELLO_PATH) return false
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
    return true
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-accept: ${socketAccept(key)}\r\n` +
      '\r\n'
  )
  socket.end(CLOSE_FRAME)
  return true
}
